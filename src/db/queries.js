/**
 * Todas las consultas SQL de la aplicación.
 *
 * Se concentran aquí para que el resto del código no escriba SQL suelto y
 * para que una futura migración a PostgreSQL toque un solo archivo.
 */
import { obtenerDB } from './database.js';
import { ahoraISO, enDias } from '../utils/datetime.js';

/**
 * "Ahora" en el mismo formato que usa JavaScript (ISO 8601 en UTC).
 *
 * CURRENT_TIMESTAMP de SQLite escribe "2026-09-01 23:53:33" — con espacio y
 * sin zona. Comparado como texto contra un ISO de JavaScript
 * ("2026-09-01T23:53:33.000Z") el espacio ordena antes que la "T", así que
 * `created_at > ?` no encontraba nunca nada, y `new Date()` interpretaba esas
 * fechas como hora local. Todas las marcas de tiempo se guardan en ISO.
 */
const AHORA_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/* ================================================================== */
/* Pacientes                                                           */
/* ================================================================== */

/** Paciente por el teléfono que tiene registrado. */
export function pacientePorTelefono(telefono) {
  return obtenerDB().prepare('SELECT * FROM patients WHERE phone = ?').get(telefono) ?? null;
}

/** Paciente por cédula. */
export function pacientePorCedula(cedula) {
  return obtenerDB().prepare('SELECT * FROM patients WHERE cedula = ?').get(cedula) ?? null;
}

/** Paciente por id. */
export function obtenerPaciente(id) {
  return obtenerDB().prepare('SELECT * FROM patients WHERE id = ?').get(id) ?? null;
}

/**
 * Agrega un paciente al padrón.
 * @param {{cedula: string, name: string, phone?: string|null,
 *          diabetesType?: string|null, notes?: string|null}} datos
 */
export function crearPaciente({ cedula, name, phone = null, diabetesType = null, notes = null }) {
  const resultado = obtenerDB()
    .prepare(
      `INSERT INTO patients (cedula, name, phone, diabetes_type, notes)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(cedula, name, phone || null, diabetesType || null, notes || null);

  return obtenerPaciente(resultado.lastInsertRowid);
}

/** Actualiza los datos editables de un paciente. */
export function actualizarPaciente(id, { name, phone, diabetesType, notes, active }) {
  obtenerDB()
    .prepare(
      `UPDATE patients
          SET name = ?, phone = ?, diabetes_type = ?, notes = ?, active = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    )
    .run(name, phone || null, diabetesType || null, notes || null, active ? 1 : 0, id);

  return obtenerPaciente(id);
}

/** Lista el padrón, con lo necesario para la tabla del panel. */
export function listarPacientes({ soloActivos = false, busqueda = '' } = {}) {
  const filtros = [];
  const parametros = [];

  if (soloActivos) filtros.push('p.active = 1');
  if (busqueda) {
    filtros.push('(p.name LIKE ? OR p.cedula LIKE ? OR p.phone LIKE ?)');
    const patron = `%${busqueda}%`;
    parametros.push(patron, patron, patron);
  }

  const donde = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';

  return obtenerDB()
    .prepare(
      `SELECT p.*,
              s.expires_at   AS session_expires_at,
              s.revoked_at   AS session_revoked_at,
              (SELECT COUNT(*) FROM glucose_readings g WHERE g.patient_id = p.id) AS lecturas,
              (SELECT COUNT(*) FROM alerts a WHERE a.patient_id = p.id AND a.resolved_at IS NULL) AS alertas_abiertas
         FROM patients p
         LEFT JOIN sessions s ON s.patient_id = p.id
         ${donde}
        ORDER BY p.name COLLATE NOCASE`,
    )
    .all(...parametros);
}

/**
 * Liga un teléfono a un paciente.
 *
 * Si el número estaba registrado a nombre de otra persona (un celular que
 * cambió de dueño, o un familiar que lo prestó), primero se lo quita a esa
 * otra y se le cierra la sesión: un mismo teléfono nunca puede quedar
 * apuntando a dos historias distintas.
 */
export function vincularTelefono(pacienteId, telefono) {
  const db = obtenerDB();

  const vincular = db.transaction(() => {
    const anterior = db
      .prepare('SELECT id FROM patients WHERE phone = ? AND id <> ?')
      .get(telefono, pacienteId);

    if (anterior) {
      db.prepare(
        `UPDATE patients SET phone = NULL, updated_at = ${AHORA_SQL} WHERE id = ?`,
      ).run(anterior.id);
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE patient_id = ? AND revoked_at IS NULL')
        .run(ahoraISO(), anterior.id);
    }

    // Las sesiones viejas del propio paciente (otro número) también caen: si
    // cambió de teléfono, el anterior deja de tener acceso.
    db.prepare('UPDATE sessions SET revoked_at = ? WHERE patient_id = ? AND revoked_at IS NULL')
      .run(ahoraISO(), pacienteId);

    db.prepare(
      `UPDATE patients SET phone = ?, updated_at = ${AHORA_SQL} WHERE id = ?`,
    ).run(telefono, pacienteId);
  });

  vincular();
  return obtenerPaciente(pacienteId);
}

/** Marca que el paciente escribió (reabre la ventana de 24 h de WhatsApp). */
export function registrarActividad(pacienteId) {
  obtenerDB()
    .prepare('UPDATE patients SET last_user_message_at = ? WHERE id = ?')
    .run(ahoraISO(), pacienteId);
}

/* ================================================================== */
/* Sesiones                                                            */
/* ================================================================== */

/** Sesión vigente de un teléfono, o null si no hay, expiró o fue revocada. */
export function sesionVigente(telefono) {
  return (
    obtenerDB()
      .prepare(
        `SELECT s.*, p.id AS patient_id, p.active AS patient_active
           FROM sessions s
           JOIN patients p ON p.id = s.patient_id
          WHERE s.phone = ?
            AND s.revoked_at IS NULL
            AND s.expires_at > ?
            AND p.active = 1`,
      )
      .get(telefono, ahoraISO()) ?? null
  );
}

/**
 * Última sesión de un paciente, esté vigente o no.
 * La ficha del panel la necesita para poder decir si su número está
 * verificado, caducado o revocado.
 */
export function sesionDePaciente(pacienteId) {
  return (
    obtenerDB()
      .prepare('SELECT * FROM sessions WHERE patient_id = ? ORDER BY id DESC LIMIT 1')
      .get(pacienteId) ?? null
  );
}

/** Crea o renueva la sesión de un teléfono. */
export function abrirSesion(pacienteId, telefono, dias) {
  const ahora = ahoraISO();
  obtenerDB()
    .prepare(
      `INSERT INTO sessions (patient_id, phone, verified_at, expires_at, last_seen_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(phone) DO UPDATE SET
            patient_id   = excluded.patient_id,
            verified_at  = excluded.verified_at,
            expires_at   = excluded.expires_at,
            last_seen_at = excluded.last_seen_at,
            revoked_at   = NULL`,
    )
    .run(pacienteId, telefono, ahora, enDias(dias), ahora);
}

/** Anota que la sesión sigue en uso (no la extiende). */
export function tocarSesion(telefono) {
  obtenerDB().prepare('UPDATE sessions SET last_seen_at = ? WHERE phone = ?').run(ahoraISO(), telefono);
}

/** Cierra la sesión de un paciente: su número vuelve a tener que verificarse. */
export function revocarSesionesDe(pacienteId) {
  return obtenerDB()
    .prepare('UPDATE sessions SET revoked_at = ? WHERE patient_id = ? AND revoked_at IS NULL')
    .run(ahoraISO(), pacienteId).changes;
}

/* ================================================================== */
/* Códigos de vinculación                                              */
/* ================================================================== */

/** Guarda el resumen de un código nuevo y anula los anteriores del paciente. */
export function guardarCodigo(pacienteId, codeHash, expiraISO) {
  const db = obtenerDB();
  const guardar = db.transaction(() => {
    // Un paciente tiene como mucho un código vivo: si el doctor genera otro,
    // el anterior deja de servir.
    db.prepare(
      `UPDATE link_codes SET expires_at = ?
        WHERE patient_id = ? AND used_at IS NULL AND expires_at > ?`,
    ).run(ahoraISO(), pacienteId, ahoraISO());

    db.prepare(
      'INSERT INTO link_codes (patient_id, code_hash, expires_at) VALUES (?, ?, ?)',
    ).run(pacienteId, codeHash, expiraISO);
  });

  guardar();
}

/** Código vigente de un paciente que coincida con el resumen dado. */
export function codigoVigente(pacienteId, codeHash) {
  return (
    obtenerDB()
      .prepare(
        `SELECT * FROM link_codes
          WHERE patient_id = ? AND code_hash = ? AND used_at IS NULL AND expires_at > ?`,
      )
      .get(pacienteId, codeHash, ahoraISO()) ?? null
  );
}

/** Marca el código como usado. Devuelve false si otro lo consumió antes. */
export function consumirCodigo(codigoId, telefono) {
  return (
    obtenerDB()
      .prepare('UPDATE link_codes SET used_at = ?, used_by_phone = ? WHERE id = ? AND used_at IS NULL')
      .run(ahoraISO(), telefono, codigoId).changes > 0
  );
}

/** ¿El paciente tiene un código sin usar todavía vigente? (para el panel) */
export function tieneCodigoPendiente(pacienteId) {
  const fila = obtenerDB()
    .prepare(
      `SELECT expires_at FROM link_codes
        WHERE patient_id = ? AND used_at IS NULL AND expires_at > ?
        ORDER BY id DESC LIMIT 1`,
    )
    .get(pacienteId, ahoraISO());
  return fila?.expires_at ?? null;
}

/* ================================================================== */
/* Intentos de verificación                                            */
/* ================================================================== */

export function registrarIntento(telefono, cedulaEnmascarada, resultado, motivo = null) {
  obtenerDB()
    .prepare('INSERT INTO auth_attempts (phone, cedula_masked, outcome, reason) VALUES (?, ?, ?, ?)')
    .run(telefono, cedulaEnmascarada, resultado, motivo);
}

/** Intentos fallidos de un teléfono desde una fecha. Base del bloqueo. */
export function fallosDesde(telefono, desdeISO) {
  return obtenerDB()
    .prepare(
      `SELECT COUNT(*) AS total FROM auth_attempts
        WHERE phone = ? AND outcome = 'fallo' AND created_at > ?`,
    )
    .get(telefono, desdeISO).total;
}

/** Últimos intentos, para la pantalla de seguridad del panel. */
export function ultimosIntentos(limite = 50) {
  return obtenerDB()
    .prepare('SELECT * FROM auth_attempts ORDER BY id DESC LIMIT ?')
    .all(limite);
}

/* ================================================================== */
/* Conversación                                                        */
/* ================================================================== */

/**
 * Registra un wa_message_id como procesado.
 * @returns {boolean} false si ya estaba (mensaje duplicado de Meta).
 */
export function registrarMensajeProcesado(waMessageId) {
  if (!waMessageId) return true;
  try {
    obtenerDB()
      .prepare('INSERT INTO processed_messages (wa_message_id) VALUES (?)')
      .run(waMessageId);
    return true;
  } catch {
    return false; // UNIQUE constraint: ya lo procesamos
  }
}

export function guardarMensaje(pacienteId, rol, contenido, waMessageId = null) {
  obtenerDB()
    .prepare('INSERT INTO messages (patient_id, wa_message_id, role, content) VALUES (?, ?, ?, ?)')
    .run(pacienteId, waMessageId, rol, contenido);
}

/** Últimos mensajes del paciente, en orden cronológico (viejo -> nuevo). */
export function obtenerHistorial(pacienteId, limite = 6) {
  const filas = obtenerDB()
    .prepare('SELECT role, content FROM messages WHERE patient_id = ? ORDER BY id DESC LIMIT ?')
    .all(pacienteId, limite);
  return filas.reverse();
}

/**
 * Mensajes que el paciente mandó en la última hora.
 * Sirve de freno: una sola persona no puede gastar la cuota de OpenAI de todos.
 */
export function mensajesRecientesDe(pacienteId) {
  const desde = new Date(Date.now() - 3_600_000).toISOString();
  return obtenerDB()
    .prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE patient_id = ? AND role = 'user' AND created_at > ?",
    )
    .get(pacienteId, desde).n;
}

/** Conversación completa de un paciente para el panel (más nuevo primero). */
export function conversacionDe(pacienteId, limite = 200) {
  return obtenerDB()
    .prepare('SELECT * FROM messages WHERE patient_id = ? ORDER BY id DESC LIMIT ?')
    .all(pacienteId, limite);
}

/* ================================================================== */
/* Glucemias                                                           */
/* ================================================================== */

export function guardarGlucemia(pacienteId, { valor, contexto, medidaEn, nota }) {
  const resultado = obtenerDB()
    .prepare(
      `INSERT INTO glucose_readings (patient_id, value_mgdl, context, measured_at, note)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(pacienteId, valor, contexto || null, medidaEn, nota || null);

  return obtenerDB()
    .prepare('SELECT * FROM glucose_readings WHERE id = ?')
    .get(resultado.lastInsertRowid);
}

export function glucemiasDe(pacienteId, limite = 60) {
  return obtenerDB()
    .prepare(
      'SELECT * FROM glucose_readings WHERE patient_id = ? ORDER BY measured_at DESC LIMIT ?',
    )
    .all(pacienteId, limite);
}

/** Resumen para el panel y para dar contexto al modelo. */
export function resumenGlucemias(pacienteId, dias = 14) {
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString();
  return obtenerDB()
    .prepare(
      `SELECT COUNT(*) AS total,
              ROUND(AVG(value_mgdl)) AS promedio,
              MIN(value_mgdl) AS minimo,
              MAX(value_mgdl) AS maximo
         FROM glucose_readings
        WHERE patient_id = ? AND measured_at > ?`,
    )
    .get(pacienteId, desde);
}

/* ================================================================== */
/* Alertas                                                             */
/* ================================================================== */

export function crearAlerta(pacienteId, { nivel, motivo, extracto, origen }) {
  const resultado = obtenerDB()
    .prepare(
      `INSERT INTO alerts (patient_id, level, reason, excerpt, source)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(pacienteId, nivel, motivo, extracto || null, origen);

  return obtenerDB().prepare('SELECT * FROM alerts WHERE id = ?').get(resultado.lastInsertRowid);
}

export function marcarAlertaNotificada(alertaId, via) {
  obtenerDB()
    .prepare('UPDATE alerts SET notified_at = ?, notify_via = ? WHERE id = ?')
    .run(ahoraISO(), via, alertaId);
}

/** Última alerta enviada al doctor por un paciente (para el tiempo de espera). */
export function ultimaAlertaNotificada(pacienteId) {
  return (
    obtenerDB()
      .prepare(
        `SELECT * FROM alerts
          WHERE patient_id = ? AND notified_at IS NOT NULL
          ORDER BY notified_at DESC LIMIT 1`,
      )
      .get(pacienteId) ?? null
  );
}

export function alertas({ soloAbiertas = false, limite = 100 } = {}) {
  const donde = soloAbiertas ? 'WHERE a.resolved_at IS NULL' : '';
  return obtenerDB()
    .prepare(
      `SELECT a.*, p.name AS patient_name, p.cedula AS patient_cedula, p.phone AS patient_phone
         FROM alerts a
         JOIN patients p ON p.id = a.patient_id
         ${donde}
        ORDER BY a.id DESC LIMIT ?`,
    )
    .all(limite);
}

/** Alertas de un paciente, de la más nueva a la más vieja. */
export function alertasDe(pacienteId, limite = 100) {
  return obtenerDB()
    .prepare('SELECT * FROM alerts WHERE patient_id = ? ORDER BY id DESC LIMIT ?')
    .all(pacienteId, limite);
}

export function resolverAlerta(alertaId) {
  return (
    obtenerDB()
      .prepare('UPDATE alerts SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL')
      .run(ahoraISO(), alertaId).changes > 0
  );
}

/* ================================================================== */
/* Base de conocimiento                                                */
/* ================================================================== */

export function crearDocumento({ titulo, fuente, contenido }) {
  const resultado = obtenerDB()
    .prepare('INSERT INTO documents (title, source, content) VALUES (?, ?, ?)')
    .run(titulo, fuente || null, contenido);
  return obtenerDocumento(resultado.lastInsertRowid);
}

export function obtenerDocumento(id) {
  return obtenerDB().prepare('SELECT * FROM documents WHERE id = ?').get(id) ?? null;
}

export function listarDocumentos() {
  return obtenerDB()
    .prepare(
      `SELECT d.*,
              LENGTH(d.content) AS caracteres,
              (SELECT COUNT(*) FROM chunks c WHERE c.document_id = d.id) AS fragmentos
         FROM documents d
        ORDER BY d.id DESC`,
    )
    .all();
}

export function activarDocumento(id, activo) {
  obtenerDB()
    .prepare(`UPDATE documents SET active = ?, updated_at = ${AHORA_SQL} WHERE id = ?`)
    .run(activo ? 1 : 0, id);
}

export function borrarDocumento(id) {
  // Los fragmentos caen solos por ON DELETE CASCADE.
  return obtenerDB().prepare('DELETE FROM documents WHERE id = ?').run(id).changes > 0;
}

export function reemplazarFragmentos(documentoId, fragmentos) {
  const db = obtenerDB();
  const guardar = db.transaction(() => {
    db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentoId);
    const insertar = db.prepare(
      'INSERT INTO chunks (document_id, ordinal, content, embedding) VALUES (?, ?, ?, ?)',
    );
    fragmentos.forEach((f, i) => insertar.run(documentoId, i, f.contenido, f.embedding));
  });
  guardar();
}

/** Todos los fragmentos de documentos activos, para buscar por similitud. */
export function fragmentosActivos() {
  return obtenerDB()
    .prepare(
      `SELECT c.id, c.content, c.embedding, d.title, d.source
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
        WHERE d.active = 1`,
    )
    .all();
}

/* ================================================================== */
/* Ajustes                                                             */
/* ================================================================== */

export function leerAjuste(clave) {
  return obtenerDB().prepare('SELECT value FROM settings WHERE key = ?').get(clave)?.value ?? null;
}

export function escribirAjuste(clave, valor) {
  obtenerDB()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .run(clave, String(valor));
}

export function borrarAjuste(clave) {
  obtenerDB().prepare('DELETE FROM settings WHERE key = ?').run(clave);
}

/* ================================================================== */
/* Métricas para el panel                                              */
/* ================================================================== */

export function metricas() {
  const db = obtenerDB();
  const desde24h = new Date(Date.now() - 86_400_000).toISOString();

  return {
    pacientes: db.prepare('SELECT COUNT(*) AS n FROM patients WHERE active = 1').get().n,
    verificados: db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ?')
      .get(ahoraISO()).n,
    mensajes24h: db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'user' AND created_at > ?")
      .get(desde24h).n,
    alertasAbiertas: db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE resolved_at IS NULL').get().n,
    lecturas7d: db
      .prepare('SELECT COUNT(*) AS n FROM glucose_readings WHERE measured_at > ?')
      .get(new Date(Date.now() - 7 * 86_400_000).toISOString()).n,
    documentos: db.prepare('SELECT COUNT(*) AS n FROM documents WHERE active = 1').get().n,
    fragmentos: db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n,
  };
}

/* ================================================================== */
/* Usuarios del panel                                                  */
/* ================================================================== */

export function contarUsuariosPanel() {
  return obtenerDB().prepare('SELECT COUNT(*) AS n FROM admin_users WHERE active = 1').get().n;
}

/** Busca por nombre de usuario. Devuelve también los inactivos: quien llama decide. */
export function usuarioPanelPorNombre(usuario) {
  return (
    obtenerDB()
      .prepare('SELECT * FROM admin_users WHERE username = ?')
      .get(String(usuario ?? '').trim()) ?? null
  );
}

export function usuarioPanelPorId(id) {
  return obtenerDB().prepare('SELECT * FROM admin_users WHERE id = ?').get(id) ?? null;
}

export function listarUsuariosPanel() {
  return obtenerDB()
    .prepare('SELECT * FROM admin_users ORDER BY active DESC, username')
    .all();
}

export function crearUsuarioPanel({ usuario, hash, nombre = null }) {
  const info = obtenerDB()
    .prepare('INSERT INTO admin_users (username, password_hash, name) VALUES (?, ?, ?)')
    .run(String(usuario).trim(), hash, nombre);
  return usuarioPanelPorId(info.lastInsertRowid);
}

export function cambiarPasswordPanel(id, hash) {
  obtenerDB().prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(hash, id);
}

export function activarUsuarioPanel(id, activo) {
  obtenerDB().prepare('UPDATE admin_users SET active = ? WHERE id = ?').run(activo ? 1 : 0, id);
}

export function registrarEntradaPanel(id) {
  obtenerDB()
    .prepare("UPDATE admin_users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .run(id);
}

export function cambiarNombreUsuarioPanel(id, nombre) {
  obtenerDB().prepare('UPDATE admin_users SET name = ? WHERE id = ?').run(nombre, id);
}

export function cambiarUsuarioPanel(id, usuario) {
  obtenerDB().prepare('UPDATE admin_users SET username = ? WHERE id = ?').run(usuario, id);
}
