/**
 * Rutas del panel de administración.
 *
 * Todo cuelga de /admin y exige sesión iniciada, salvo la propia pantalla de
 * entrada. Los avisos ("guardado", "no se pudo") viajan en la URL como
 * ?ok= / ?error=, salvo el código de vinculación: ese se pinta directamente
 * en la respuesta del POST para que no quede en el historial del navegador.
 */
import { randomBytes } from 'node:crypto';
import express from 'express';
import Busboy from 'busboy';
import { fromZonedTime } from 'date-fns-tz';
import { advertenciasDeConfiguracion, config } from '../config.js';
import { logger, incidenciasRecientes, ofuscarCedula } from '../utils/logger.js';
import {
  abrirSesion,
  anotarFallo,
  cerrarSesion,
  esAdministrador,
  estaBloqueado,
  guardaDeSecciones,
  minutosQueFaltan,
  mismoOrigen,
  ROLES,
  olvidarFallos,
  passwordCorrecta,
  problemaConLaPassword,
  requiereSesion,
  resumirPassword,
} from './auth.js';
import { pagina, paginaEntrar } from './vistas.js';
import * as paginas from './paginas.js';
import * as db from '../db/queries.js';
import { baseCifrada } from '../db/database.js';
import * as auth from '../services/auth.js';
import * as borrado from '../services/borrado.js';
import * as conocimiento from '../services/conocimiento.js';
import {
  extraerTexto,
  formatoDe,
  MAX_BYTES,
  tipoDeArchivo,
  tituloDesdeNombre,
} from '../services/documentos.js';
import { anotar, desdeElPanel, GRUPOS } from '../services/bitacora.js';
import { CATALOGO, ajuste, estaPersonalizado, guardarAjuste, restaurarAjuste } from '../services/ajustes.js';
import { esCedulaValida, normalizarCedula } from '../utils/cedula.js';
import { comoLocal, esTelefonoValido, normalizarTelefono } from '../utils/telefono.js';

export const adminRouter = express.Router();

/** Anota en el historial algo hecho desde el panel, con quién lo hizo. */
function anotarPanel(req, accion, { pacienteId = null, detalle = null } = {}) {
  anotar({ actor: desdeElPanel(req.usuario), accion, pacienteId, detalle });
}

adminRouter.use(express.urlencoded({ extended: false, limit: '2mb' }));
adminRouter.use(mismoOrigen);

/** Lee el aviso que viene en la URL tras un redirect. */
function avisoDe(req) {
  if (req.query.ok) return { tipo: 'ok', texto: String(req.query.ok) };
  if (req.query.error) return { tipo: 'error', texto: String(req.query.error) };
  return null;
}

/** Redirige a una ruta con un aviso. */
function volver(res, ruta, aviso) {
  const parametros = aviso ? `?${aviso.tipo === 'error' ? 'error' : 'ok'}=${encodeURIComponent(aviso.texto)}` : '';
  res.redirect(`${ruta}${parametros}`);
}

/* ------------------------------------------------------------------ */
/* Entrar y salir                                                      */
/*                                                                     */
/* Van antes del guardia de sesión: son las únicas rutas del panel a    */
/* las que se llega sin haber entrado.                                 */
/* ------------------------------------------------------------------ */

adminRouter.get('/entrar', (req, res) => {
  res.type('html').send(paginaEntrar({ aviso: avisoDe(req) }));
});

adminRouter.post('/entrar', (req, res) => {
  const ip = req.ip;

  if (estaBloqueado(ip)) {
    logger.warn(`Entrada al panel bloqueada por intentos fallidos desde ${ip}.`);
    return res.status(429).type('html').send(
      paginaEntrar({
        aviso: {
          tipo: 'error',
          texto: `Demasiados intentos fallidos. Espere ${minutosQueFaltan(ip)} minuto(s).`,
        },
      }),
    );
  }

  const nombreUsuario = String(req.body.usuario ?? '').trim();
  const usuario = db.usuarioPanelPorNombre(nombreUsuario);
  const correcta =
    usuario?.active && passwordCorrecta(String(req.body.password ?? ''), usuario.password_hash);

  // El mismo mensaje tanto si el usuario no existe como si la contraseña está
  // mal: decir cuál de las dos falló le regala media respuesta a quien prueba.
  if (!correcta) {
    anotarFallo(ip);
    logger.warn(`Intento fallido de entrada al panel desde ${ip}.`);
    return res.status(401).type('html').send(
      paginaEntrar({
        usuario: nombreUsuario,
        aviso: { tipo: 'error', texto: 'Usuario o contraseña incorrectos.' },
      }),
    );
  }

  olvidarFallos(ip);
  abrirSesion(res, req, usuario);
  anotar({ actor: desdeElPanel(usuario), accion: 'panel.entrada' });
  logger.info(`Entrada al panel: "${usuario.username}".`);
  return res.redirect(303, '/admin');
});

adminRouter.post('/salir', (req, res) => {
  cerrarSesion(res);
  res.redirect(303, '/admin/entrar');
});

/* ------------------------------------------------------------------ */
/* A partir de aquí hace falta haber entrado                           */
/* ------------------------------------------------------------------ */

adminRouter.use(requiereSesion);

// Y algunas secciones, además, solo para administradores.
adminRouter.use(guardaDeSecciones);

/**
 * Datos clínicos del formulario. Devuelve { error } si la edad no sirve.
 * Los textos se recortan a un largo razonable para una ficha.
 */
function datosClinicosDe(body) {
  const texto = (campo) => String(body[campo] ?? '').trim().slice(0, 1000) || null;
  const edadEscrita = String(body.age ?? '').trim();
  const edad = edadEscrita === '' ? null : Number(edadEscrita);
  if (edad !== null && !(Number.isInteger(edad) && edad >= 0 && edad <= 120)) {
    return { error: 'La edad tiene que ser un número entero entre 0 y 120.' };
  }
  return {
    datos: {
      edad,
      alergias: texto('food_allergies'),
      medicamentos: texto('medications'),
      otrasEnfermedades: texto('other_conditions'),
    },
  };
}

/** Aviso cuando el teléfono escrito no tiene forma de número. */
const TELEFONO_INVALIDO =
  'Ese teléfono no parece completo. Escríbalo como 0991234567 o con código de país (593991234567).';

/* ------------------------------------------------------------------ */
/* Resumen                                                             */
/* ------------------------------------------------------------------ */

adminRouter.get('/', (req, res) => {
  res.type('html').send(
    pagina({
      titulo: 'Resumen',
      activo: '/admin',
      aviso: avisoDe(req),
      usuario: req.usuario,
      contenido: paginas.resumen(db.metricas(), db.alertas({ soloAbiertas: true, limite: 10 })),
    }),
  );
});

/* ------------------------------------------------------------------ */
/* Pacientes                                                           */
/* ------------------------------------------------------------------ */

adminRouter.get('/pacientes', (req, res) => {
  const busqueda = String(req.query.q ?? '').trim();
  const estado = paginas.ESTADOS_DEL_NUMERO[req.query.estado] ? String(req.query.estado) : '';
  const lista = db
    .listarPacientes({ busqueda })
    .filter((p) => !estado || paginas.estadoDelNumeroDe(p) === estado);
  res.type('html').send(
    pagina({
      titulo: 'Pacientes',
      activo: '/admin/pacientes',
      aviso: avisoDe(req),
      usuario: req.usuario,
      contenido: paginas.pacientes(lista, busqueda, estado),
    }),
  );
});

adminRouter.post('/pacientes', (req, res) => {
  const cedula = normalizarCedula(req.body.cedula);
  const nombre = String(req.body.name ?? '').trim();

  if (!esCedulaValida(cedula)) {
    return volver(res, '/admin/pacientes', {
      tipo: 'error',
      texto: 'Esa cédula no es válida. Revise los 10 dígitos.',
    });
  }
  if (!nombre) {
    return volver(res, '/admin/pacientes', { tipo: 'error', texto: 'Falta el nombre.' });
  }
  if (db.pacientePorCedula(cedula)) {
    return volver(res, '/admin/pacientes', {
      tipo: 'error',
      texto: 'Ya hay un paciente con esa cédula.',
    });
  }

  const telefono = normalizarTelefono(req.body.phone);
  if (telefono && !esTelefonoValido(telefono)) {
    return volver(res, '/admin/pacientes', { tipo: 'error', texto: TELEFONO_INVALIDO });
  }
  if (telefono && db.pacientePorTelefono(telefono)) {
    return volver(res, '/admin/pacientes', {
      tipo: 'error',
      texto: 'Ese teléfono ya está registrado a nombre de otro paciente.',
    });
  }

  const clinicos = datosClinicosDe(req.body);
  if (clinicos.error) {
    return volver(res, '/admin/pacientes', { tipo: 'error', texto: clinicos.error });
  }

  try {
    const paciente = db.crearPaciente({
      cedula,
      name: nombre,
      phone: telefono,
      diabetesType: req.body.diabetes_type || null,
      clinicos: clinicos.datos,
    });
    anotarPanel(req, 'paciente.creado', {
      pacienteId: paciente.id,
      detalle: telefono ? `Con el teléfono ${comoLocal(telefono)}` : 'Sin teléfono',
    });
    logger.info(`Paciente #${paciente.id} agregado desde el panel.`);
    return volver(res, `/admin/pacientes/${paciente.id}`, {
      tipo: 'ok',
      texto: 'Paciente agregado.',
    });
  } catch (error) {
    logger.error('No se pudo agregar al paciente.', error);
    return volver(res, '/admin/pacientes', {
      tipo: 'error',
      texto: 'No se pudo guardar. Revise los datos.',
    });
  }
});

/** Junta todo lo que se muestra en la ficha de un paciente. */
function fichaDe(pacienteId, extras = {}) {
  const paciente = db.obtenerPaciente(pacienteId);
  if (!paciente) return null;

  // El estado del número ("verificado", "sin verificar") vive en la tabla de
  // sesiones, así que se le adjunta con los mismos nombres que trae el listado.
  const sesion = db.sesionDePaciente(paciente.id);

  return paginas.paciente({
    paciente: {
      ...paciente,
      session_expires_at: sesion?.expires_at ?? null,
      session_revoked_at: sesion?.revoked_at ?? null,
    },
    sesion,
    eventos: db.eventosDePaciente(paciente.id, 50),
    intentos: db.intentosDePaciente(db.telefonosDePaciente(paciente.id), ofuscarCedula(paciente.cedula), 30),
    lecturas: db.glucemiasDe(paciente.id),
    resumenGlucemias: db.resumenGlucemias(paciente.id),
    conversacion: db.conversacionDe(paciente.id, 120),
    alertas: db.alertasDe(paciente.id),
    codigoPendiente: db.tieneCodigoPendiente(paciente.id),
    consentimiento: db.consentimientoDe(paciente.id),
    codigo: null,
    ...extras,
  });
}

adminRouter.get('/pacientes/:id', (req, res) => {
  const contenido = fichaDe(Number(req.params.id), {
    puedeBorrar: esAdministrador(req.usuario),
    verHistorial: esAdministrador(req.usuario),
  });
  if (!contenido) return res.status(404).send('Paciente no encontrado.');

  res.type('html').send(
    pagina({ titulo: 'Paciente', activo: '/admin/pacientes', aviso: avisoDe(req), contenido, usuario: req.usuario }),
  );
});

adminRouter.post('/pacientes/:id', (req, res) => {
  const id = Number(req.params.id);
  const paciente = db.obtenerPaciente(id);
  if (!paciente) return res.status(404).send('Paciente no encontrado.');

  const nombre = String(req.body.name ?? '').trim();
  if (!nombre) {
    return volver(res, `/admin/pacientes/${id}`, { tipo: 'error', texto: 'Falta el nombre.' });
  }

  const telefono = normalizarTelefono(req.body.phone);
  if (telefono && !esTelefonoValido(telefono)) {
    return volver(res, `/admin/pacientes/${id}`, { tipo: 'error', texto: TELEFONO_INVALIDO });
  }
  const ocupado = telefono ? db.pacientePorTelefono(telefono) : null;
  if (ocupado && ocupado.id !== id) {
    return volver(res, `/admin/pacientes/${id}`, {
      tipo: 'error',
      texto: 'Ese teléfono ya está registrado a nombre de otro paciente.',
    });
  }

  const clinicos = datosClinicosDe(req.body);
  if (clinicos.error) {
    return volver(res, `/admin/pacientes/${id}`, { tipo: 'error', texto: clinicos.error });
  }

  const activo = req.body.active === '1';
  const tipo = req.body.diabetes_type || null;
  const notas = String(req.body.notes ?? '').trim() || null;

  const cambiaTelefono = telefono !== paciente.phone;
  const cambiaEstado = activo !== Boolean(paciente.active);
  const sesion = db.sesionDePaciente(id);
  const estabaVerificado = Boolean(paciente.active) && paginas.sesionAbierta(sesion);

  // Cambiar el teléfono o desactivar a un paciente verificado lo deja sin
  // acceso en ese mismo momento. Antes de hacerlo se le muestra a quien
  // guarda qué va a pasar y se le pide que lo confirme: sin esto, un número
  // mal copiado deja a un paciente fuera sin que nadie se entere (caso del
  // 01/10/2026, ver casos/).
  if ((cambiaTelefono || !activo) && estabaVerificado && req.body.confirmado !== '1') {
    return res.type('html').send(
      pagina({
        titulo: 'Confirmar el cambio',
        activo: '/admin/pacientes',
        usuario: req.usuario,
        contenido: paginas.confirmarCambioDePaciente({
          paciente,
          sesion,
          telefonoNuevo: cambiaTelefono ? telefono : undefined,
          desactiva: !activo,
          campos: req.body,
        }),
      }),
    );
  }

  db.actualizarDatosClinicos(id, clinicos.datos);
  db.actualizarPaciente(id, {
    name: nombre,
    phone: telefono,
    diabetesType: tipo,
    notes: notas,
    active: activo,
  });

  // Si le cambiaron el número o lo desactivaron, la sesión anterior ya no
  // debe servir: quien tuviera el teléfono viejo perdería el acceso ahora.
  let sesionCerrada = false;
  if (cambiaTelefono || !activo) {
    sesionCerrada = db.revocarSesionesDe(id) > 0 && estabaVerificado;
  }
  const nota = sesionCerrada ? `. Se cerró su sesión (estaba verificado desde ${comoLocal(sesion.phone)})` : '';

  if (cambiaTelefono) {
    anotarPanel(req, 'paciente.telefono', {
      pacienteId: id,
      detalle: `${paciente.phone ? comoLocal(paciente.phone) : 'Sin número'} → ${telefono ? comoLocal(telefono) : 'sin número'}${nota}`,
    });
  }
  if (cambiaEstado) {
    anotarPanel(req, 'paciente.estado', {
      pacienteId: id,
      detalle: `${activo ? 'Inactivo → Activo' : 'Activo → Inactivo'}${cambiaTelefono ? '' : nota}`,
    });
  }

  // Del resto solo se anota QUÉ cambió, no los valores: el historial no es
  // otra copia de los datos de salud.
  const otros = [
    [nombre !== paciente.name, 'nombre'],
    [tipo !== paciente.diabetes_type, 'tipo de diabetes'],
    [notas !== paciente.notes, 'notas para el asistente'],
    [clinicos.datos.edad !== paciente.age, 'edad'],
    [(clinicos.datos.alergias || null) !== paciente.food_allergies, 'alergias'],
    [(clinicos.datos.medicamentos || null) !== paciente.medications, 'medicamentos'],
    [(clinicos.datos.otrasEnfermedades || null) !== paciente.other_conditions, 'otras enfermedades'],
  ]
    .filter(([cambio]) => cambio)
    .map(([, campo]) => campo);
  if (otros.length) {
    anotarPanel(req, 'paciente.datos', { pacienteId: id, detalle: `Cambió: ${otros.join(', ')}` });
  }

  logger.info(`Paciente #${id} actualizado desde el panel.`);
  return volver(res, `/admin/pacientes/${id}`, {
    tipo: 'ok',
    texto: sesionCerrada
      ? 'Datos guardados. Su sesión se cerró: tendrá que verificarse de nuevo.'
      : 'Datos guardados.',
  });
});

adminRouter.post('/pacientes/:id/codigo', (req, res) => {
  const id = Number(req.params.id);
  if (!db.obtenerPaciente(id)) return res.status(404).send('Paciente no encontrado.');

  const codigo = auth.generarCodigo(id);
  anotarPanel(req, 'codigo.generado', { pacienteId: id });

  // Se responde con la página ya pintada, sin redirect: el código solo existe
  // legible en este momento y no debe quedar en la barra de direcciones.
  res.type('html').send(
    pagina({
      titulo: 'Paciente',
      activo: '/admin/pacientes',
      aviso: { tipo: 'ok', texto: 'Código generado. Anótelo ahora: no se vuelve a mostrar.' },
      usuario: req.usuario,
      contenido: fichaDe(id, {
        codigo,
        puedeBorrar: esAdministrador(req.usuario),
        verHistorial: esAdministrador(req.usuario),
      }),
    }),
  );
});

adminRouter.post('/pacientes/:id/revocar', (req, res) => {
  const id = Number(req.params.id);
  if (!db.obtenerPaciente(id)) return res.status(404).send('Paciente no encontrado.');

  const sesion = db.sesionDePaciente(id);
  const cerradas = db.revocarSesionesDe(id);
  if (cerradas > 0) {
    anotarPanel(req, 'sesion.cerrada_panel', {
      pacienteId: id,
      detalle: sesion ? `Estaba verificado desde ${comoLocal(sesion.phone)}` : null,
    });
  }
  logger.info(`Sesión del paciente #${id} cerrada desde el panel.`);

  return volver(res, `/admin/pacientes/${id}`, {
    tipo: 'ok',
    texto: cerradas > 0 ? 'Sesión cerrada. Tendrá que verificarse de nuevo.' : 'No tenía sesión abierta.',
  });
});

adminRouter.post('/pacientes/:id/borrar', async (req, res) => {
  // Solo el administrador. Se comprueba aquí y no con guardaDeSecciones
  // porque el resto de /pacientes sí es del doctor.
  if (!esAdministrador(req.usuario)) {
    logger.warn(`"${req.usuario.username}" intentó borrar un paciente sin ser administrador.`);
    return res.status(403).send('Solo un administrador puede borrar los datos de un paciente.');
  }

  const id = Number(req.params.id);
  const paciente = db.obtenerPaciente(id);
  if (!paciente) return res.status(404).send('Paciente no encontrado.');

  if (normalizarCedula(req.body.confirmar_cedula) !== paciente.cedula) {
    return volver(res, `/admin/pacientes/${id}`, {
      tipo: 'error',
      texto: 'La cédula escrita no coincide con la del paciente. No se borró nada.',
    });
  }

  try {
    const { teniaAlertas, doctorAvisado } = await borrado.borrarPaciente(
      paciente,
      `panel:${req.usuario.username}`,
    );
    let texto = 'Todos los datos del paciente fueron eliminados.';
    if (teniaAlertas) {
      texto += doctorAvisado
        ? ' Tenía alertas sin revisar: se le avisó al doctor por WhatsApp.'
        : ' Tenía alertas sin revisar y NO se pudo avisar al doctor por WhatsApp.';
    }
    return volver(res, '/admin/pacientes', { tipo: teniaAlertas && !doctorAvisado ? 'error' : 'ok', texto });
  } catch (error) {
    logger.error(`No se pudieron borrar los datos del paciente #${id}.`, error);
    return volver(res, `/admin/pacientes/${id}`, {
      tipo: 'error',
      texto: 'No se pudo borrar. No se eliminó nada; inténtelo de nuevo.',
    });
  }
});

/* ------------------------------------------------------------------ */
/* Alertas                                                             */
/* ------------------------------------------------------------------ */

adminRouter.get('/alertas', (req, res) => {
  const soloAbiertas = req.query.abiertas === '1';
  res.type('html').send(
    pagina({
      titulo: 'Alertas',
      activo: '/admin/alertas',
      aviso: avisoDe(req),
      usuario: req.usuario,
      contenido: paginas.listaAlertas(db.alertas({ soloAbiertas }), soloAbiertas),
    }),
  );
});

adminRouter.post('/alertas/:id/resolver', (req, res) => {
  const alerta = db.obtenerAlerta(Number(req.params.id));
  const resuelta = db.resolverAlerta(Number(req.params.id));
  if (resuelta) {
    anotarPanel(req, 'alerta.revisada', { pacienteId: alerta.patient_id, detalle: alerta.reason });
  }
  const destino = req.get('referer')?.includes('/admin/pacientes/')
    ? req.get('referer').split('?')[0]
    : '/admin/alertas';

  return volver(res, destino, {
    tipo: resuelta ? 'ok' : 'error',
    texto: resuelta ? 'Alerta marcada como revisada.' : 'Esa alerta ya estaba revisada.',
  });
});

/* ------------------------------------------------------------------ */
/* Base de conocimiento                                                */
/* ------------------------------------------------------------------ */

adminRouter.get('/conocimiento', (req, res) => {
  res.type('html').send(
    pagina({
      titulo: 'Conocimiento',
      activo: '/admin/conocimiento',
      aviso: avisoDe(req),
      usuario: req.usuario,
      contenido: paginas.conocimiento(db.listarDocumentos()),
    }),
  );
});

adminRouter.post('/conocimiento', async (req, res) => {
  const titulo = String(req.body.titulo ?? '').trim();
  const contenido = String(req.body.contenido ?? '').trim();

  if (!titulo || !contenido) {
    return volver(res, '/admin/conocimiento', {
      tipo: 'error',
      texto: 'Hacen falta el título y el contenido.',
    });
  }

  const documento = db.crearDocumento({
    titulo,
    fuente: String(req.body.fuente ?? '').trim() || null,
    contenido,
  });

  // Si venía de "Subir un archivo", el original esperaba con este token.
  const token = String(req.body.archivo ?? '');
  const conOriginal = token ? db.ligarArchivo(token, documento.id) : false;
  if (token && !conOriginal) {
    logger.warn(`El archivo original del documento #${documento.id} ya no estaba (se revisó pasado un día).`);
  }
  anotarPanel(req, 'documento.creado', {
    detalle: `${titulo}${conOriginal ? ` (archivo ${documento.source ?? ''})` : ''}`,
  });

  const resultado = await conocimiento.indexarDocumento(documento.id);

  return volver(res, '/admin/conocimiento', {
    tipo: resultado.ok ? 'ok' : 'error',
    texto: resultado.ok
      ? `Documento guardado e indexado en ${resultado.fragmentos} fragmento(s).`
      : `Documento guardado, pero no se pudo indexar: ${resultado.error} Use "Reindexar".`,
  });
});

adminRouter.get('/conocimiento/:id', (req, res) => {
  const documento = db.obtenerDocumento(Number(req.params.id));
  if (!documento) return res.status(404).send('Documento no encontrado.');

  res.type('html').send(
    pagina({
      titulo: documento.title,
      activo: '/admin/conocimiento',
      aviso: avisoDe(req),
      usuario: req.usuario,
      contenido: paginas.documento({
        documento,
        archivo: db.archivoDeDocumento(documento.id),
        fragmentos: db.fragmentosDe(documento.id),
      }),
    }),
  );
});

/**
 * Cabecera para que el navegador guarde el archivo con su nombre, tildes
 * incluidas (filename* es para los navegadores que entienden UTF-8).
 */
function nombreDeDescarga(modo, nombre) {
  const ascii = nombre.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${modo}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nombre)}`;
}

/** El texto que usa el asistente, tal como quedó guardado. */
adminRouter.get('/conocimiento/:id/texto', (req, res) => {
  const documento = db.obtenerDocumento(Number(req.params.id));
  if (!documento) return res.status(404).send('Documento no encontrado.');

  const nombre = `${documento.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'documento'}.txt`;
  res.set({
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': nombreDeDescarga('attachment', nombre),
    'Cache-Control': 'no-store',
  });
  res.send(documento.content);
});

/**
 * El archivo tal como se subió. Un PDF se puede abrir en el navegador
 * (?ver=1); lo demás siempre se descarga. Nunca se sirve nada para que el
 * navegador lo interprete como página: solo se aceptan PDF, Word y texto,
 * y nosniff impide que adivine otro tipo.
 */
adminRouter.get('/conocimiento/:id/original', (req, res) => {
  const archivo = db.contenidoDeArchivo(Number(req.params.id));
  if (!archivo) return res.status(404).send('Este documento no tiene el archivo original guardado.');

  const abrir = req.query.ver === '1' && archivo.mime === 'application/pdf';
  res.set({
    'Content-Type': archivo.mime,
    'Content-Disposition': nombreDeDescarga(abrir ? 'inline' : 'attachment', archivo.filename),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.send(archivo.data);
});

adminRouter.post('/conocimiento/:id/reindexar', async (req, res) => {
  const documento = db.obtenerDocumento(Number(req.params.id));
  const resultado = await conocimiento.indexarDocumento(Number(req.params.id));
  if (resultado.ok && documento) anotarPanel(req, 'documento.reindexado', { detalle: documento.title });
  return volver(res, '/admin/conocimiento', {
    tipo: resultado.ok ? 'ok' : 'error',
    texto: resultado.ok ? `Reindexado en ${resultado.fragmentos} fragmento(s).` : resultado.error,
  });
});

adminRouter.post('/conocimiento/:id/activar', (req, res) => {
  const activo = req.body.activo === '1';
  const documento = db.obtenerDocumento(Number(req.params.id));
  db.activarDocumento(Number(req.params.id), activo);
  conocimiento.invalidarCache();
  if (documento) {
    anotarPanel(req, activo ? 'documento.encendido' : 'documento.apagado', { detalle: documento.title });
  }
  return volver(res, '/admin/conocimiento', {
    tipo: 'ok',
    texto: activo ? 'Documento encendido.' : 'Documento apagado.',
  });
});

adminRouter.post('/conocimiento/:id/borrar', (req, res) => {
  const documento = db.obtenerDocumento(Number(req.params.id));
  const borrado = db.borrarDocumento(Number(req.params.id));
  if (borrado) anotarPanel(req, 'documento.borrado', { detalle: documento.title });
  conocimiento.invalidarCache();
  return volver(res, '/admin/conocimiento', {
    tipo: borrado ? 'ok' : 'error',
    texto: borrado ? 'Documento borrado.' : 'No se encontró ese documento.',
  });
});

/* ------------------------------------------------------------------ */
/* Configuración                                                       */
/* ------------------------------------------------------------------ */

function valoresDeConfiguracion() {
  return Object.fromEntries(
    CATALOGO.map((a) => [a.clave, { valor: ajuste(a.clave), personalizado: estaPersonalizado(a.clave) }]),
  );
}

adminRouter.get('/configuracion', (req, res) => {
  res.type('html').send(
    pagina({
      titulo: 'Configuración',
      activo: '/admin/configuracion',
      aviso: avisoDe(req),
      usuario: req.usuario,
      contenido: paginas.configuracion(valoresDeConfiguracion()),
    }),
  );
});

adminRouter.post('/configuracion', (req, res) => {
  const clave = String(req.body.clave ?? '');
  const definicion = CATALOGO.find((a) => a.clave === clave);

  if (req.body.restaurar === '1') {
    restaurarAjuste(clave);
    anotarPanel(req, 'ajuste.restaurado', { detalle: definicion?.etiqueta ?? clave });
    return volver(res, '/admin/configuracion', { tipo: 'ok', texto: 'Valor de fábrica restaurado.' });
  }

  const valor = definicion?.tipo === 'si_no' ? req.body.valor === '1' : req.body.valor;

  const error = guardarAjuste(clave, valor);
  if (!error) anotarPanel(req, 'ajuste.cambiado', { detalle: definicion?.etiqueta ?? clave });
  return volver(res, '/admin/configuracion', {
    tipo: error ? 'error' : 'ok',
    texto: error ?? 'Guardado. Ya está en uso.',
  });
});

/* ------------------------------------------------------------------ */
/* Seguridad                                                           */
/* ------------------------------------------------------------------ */

adminRouter.get('/seguridad', (req, res) => {
  res.type('html').send(
    pagina({
      titulo: 'Seguridad',
      activo: '/admin/seguridad',
      aviso: avisoDe(req),
      usuario: req.usuario,
      contenido: paginas.seguridad(
        db.ultimosIntentos(60),
        incidenciasRecientes(30),
        // El aviso sobre ADMIN_USER/ADMIN_PASSWORD solo sirve mientras no haya
        // ningún usuario: creado el primero, esas variables ya no pintan nada
        // y dejarlo puesto haría que el doctor persiguiera un problema que no
        // existe. Al revés, quedarse sin usuarios sí es grave.
        db.contarUsuariosPanel() > 0
          ? advertenciasDeConfiguracion().filter((a) => !a.startsWith('ADMIN_USER'))
          : [...advertenciasDeConfiguracion(), 'No hay ningún usuario con acceso al panel.'],
        baseCifrada(),
        db.ultimosBorrados(30),
      ),
    }),
  );
});

/* ------------------------------------------------------------------ */
/* Historial                                                           */
/* ------------------------------------------------------------------ */

/** Un día escrito en el formulario (AAAA-MM-DD) como instante UTC del inicio de ese día en Ecuador. */
function inicioDelDia(dia) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return '';
  const fecha = fromZonedTime(`${dia}T00:00:00`, config.zonaHoraria);
  return Number.isNaN(fecha.getTime()) ? '' : fecha.toISOString();
}

const MAX_FILAS_HISTORIAL = 200;

adminRouter.get('/historial', (req, res) => {
  const filtros = {
    q: String(req.query.q ?? '').trim().slice(0, 100),
    quien: String(req.query.quien ?? ''),
    que: GRUPOS[req.query.que] ? String(req.query.que) : '',
    desde: String(req.query.desde ?? ''),
    hasta: String(req.query.hasta ?? ''),
  };

  const desde = inicioDelDia(filtros.desde);
  // "Hasta" incluye ese día entero: se busca hasta el inicio del siguiente.
  const hasta = inicioDelDia(filtros.hasta)
    ? new Date(new Date(inicioDelDia(filtros.hasta)).getTime() + 86_400_000).toISOString()
    : '';

  const eventos =
    filtros.que === 'intentos'
      ? []
      : db.buscarEventos({
          texto: filtros.q,
          actor: filtros.quien,
          acciones: GRUPOS[filtros.que]?.prefijos ?? [],
          desde,
          hasta,
          limite: MAX_FILAS_HISTORIAL,
        });

  // Los intentos de verificación vienen de WhatsApp: entran si no se filtró
  // por un usuario del panel y si el "qué" los incluye.
  const conIntentos =
    ['', 'intentos', 'numeros'].includes(filtros.que) && ['', 'paciente'].includes(filtros.quien);
  const cedula = normalizarCedula(filtros.q);
  const intentos = conIntentos
    ? db.buscarIntentos({
        texto: filtros.q,
        cedulaEnmascarada: esCedulaValida(cedula) ? ofuscarCedula(cedula) : '',
        desde,
        hasta,
        limite: MAX_FILAS_HISTORIAL,
      })
    : [];

  const filas = [
    ...eventos.map((e) => ({ tipo: 'evento', ...e })),
    ...intentos.map((i) => ({ tipo: 'intento', ...i })),
  ]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, MAX_FILAS_HISTORIAL);

  res.type('html').send(
    pagina({
      titulo: 'Historial',
      activo: '/admin/historial',
      aviso: avisoDe(req),
      usuario: req.usuario,
      contenido: paginas.historial({
        filas,
        filtros,
        actores: db.actoresDelHistorial(),
        limite: MAX_FILAS_HISTORIAL,
      }),
    }),
  );
});

/* ------------------------------------------------------------------ */
/* Mi cuenta                                                           */
/* ------------------------------------------------------------------ */

adminRouter.get('/cuenta', (req, res) => {
  res.type('html').send(
    pagina({
      titulo: 'Mi cuenta',
      activo: '/admin/cuenta',
      aviso: avisoDe(req),
      usuario: req.usuario,
      contenido: paginas.cuenta(req.usuario),
    }),
  );
});

adminRouter.post('/cuenta', (req, res) => {
  const actual = String(req.body.actual ?? '');
  const nueva = String(req.body.nueva ?? '');
  const repetida = String(req.body.repetida ?? '');

  if (!passwordCorrecta(actual, req.usuario.password_hash)) {
    logger.warn(`Cambio de contraseña rechazado: la actual no coincide ("${req.usuario.username}").`);
    return volver(res, '/admin/cuenta', { tipo: 'error', texto: 'La contraseña actual no es correcta.' });
  }

  if (nueva !== repetida) {
    return volver(res, '/admin/cuenta', { tipo: 'error', texto: 'Las dos contraseñas nuevas no coinciden.' });
  }

  const problema = problemaConLaPassword(nueva, { usuario: req.usuario.username, actual });
  if (problema) return volver(res, '/admin/cuenta', { tipo: 'error', texto: problema });

  db.cambiarPasswordPanel(req.usuario.id, resumirPassword(nueva));
  anotarPanel(req, 'cuenta.password');
  logger.info(`Contraseña cambiada por "${req.usuario.username}".`);

  // La firma de la sesión incluye el resumen de la contraseña, así que la
  // cookie actual acaba de quedar invalidada. Se abre una nueva para no echar
  // fuera a quien acaba de cambiarla, y las de otros navegadores caen solas.
  abrirSesion(res, req, db.usuarioPanelPorId(req.usuario.id));

  return volver(res, '/admin/cuenta', {
    tipo: 'ok',
    texto: 'Contraseña cambiada. Las sesiones abiertas en otros navegadores se cerraron.',
  });
});

adminRouter.post('/cuenta/usuario', (req, res) => {
  const nuevo = String(req.body.nuevo ?? '').trim().toLowerCase();

  // Se pide la contraseña porque esto cambia con qué credencial se entra:
  // una sesión robada no debería poder tocarlo.
  if (!passwordCorrecta(String(req.body.password ?? ''), req.usuario.password_hash)) {
    logger.warn(`Cambio de nombre de usuario rechazado: contraseña incorrecta ("${req.usuario.username}").`);
    return volver(res, '/admin/cuenta', { tipo: 'error', texto: 'La contraseña no es correcta.' });
  }

  if (nuevo === req.usuario.username.toLowerCase()) {
    return volver(res, '/admin/cuenta', { tipo: 'ok', texto: 'Ese ya es su nombre de usuario.' });
  }

  if (!/^[a-z0-9._-]{3,40}$/.test(nuevo)) {
    return volver(res, '/admin/cuenta', {
      tipo: 'error',
      texto: 'El usuario admite entre 3 y 40 letras sin tilde, números, punto, guion o guion bajo.',
    });
  }

  if (db.usuarioPanelPorNombre(nuevo)) {
    return volver(res, '/admin/cuenta', { tipo: 'error', texto: 'Ya existe un usuario con ese nombre.' });
  }

  const anterior = req.usuario.username;
  db.cambiarUsuarioPanel(req.usuario.id, nuevo);
  // Con el nombre nuevo como actor, y el viejo en el detalle: así se puede
  // seguir a la misma persona en el historial.
  anotar({ actor: `panel:${nuevo}`, accion: 'cuenta.usuario', detalle: `Antes era "${anterior}"` });
  logger.info(`Nombre de usuario del panel cambiado: "${anterior}" pasa a ser "${nuevo}".`);

  // La sesión se firma con el id y la contraseña, no con el nombre, así que
  // sigue valiendo: no hace falta volver a entrar.
  return volver(res, '/admin/cuenta', {
    tipo: 'ok',
    texto: `Desde ahora entra como "${nuevo}".`,
  });
});

adminRouter.post('/cuenta/nombre', (req, res) => {
  const nombre = String(req.body.nombre ?? '').trim().slice(0, 80);
  db.cambiarNombreUsuarioPanel(req.usuario.id, nombre || null);
  return volver(res, '/admin/cuenta', { tipo: 'ok', texto: 'Nombre guardado.' });
});

/* ------------------------------------------------------------------ */
/* Usuarios                                                            */
/* ------------------------------------------------------------------ */

adminRouter.get('/usuarios', (req, res) => {
  res.type('html').send(
    pagina({
      titulo: 'Usuarios',
      activo: '/admin/usuarios',
      aviso: avisoDe(req),
      usuario: req.usuario,
      contenido: paginas.usuarios(db.listarUsuariosPanel(), req.usuario),
    }),
  );
});

adminRouter.post('/usuarios', (req, res) => {
  const usuario = String(req.body.usuario ?? '').trim().toLowerCase();
  const nombre = String(req.body.nombre ?? '').trim().slice(0, 80) || null;
  const password = String(req.body.password ?? '');

  if (!/^[a-z0-9._-]{3,40}$/.test(usuario)) {
    return volver(res, '/admin/usuarios', {
      tipo: 'error',
      texto: 'El usuario admite entre 3 y 40 letras, números, punto, guion o guion bajo.',
    });
  }

  if (db.usuarioPanelPorNombre(usuario)) {
    return volver(res, '/admin/usuarios', { tipo: 'error', texto: 'Ya existe un usuario con ese nombre.' });
  }

  const problema = problemaConLaPassword(password, { usuario });
  if (problema) return volver(res, '/admin/usuarios', { tipo: 'error', texto: problema });

  // Ante cualquier valor raro, el papel más limitado.
  const rol = req.body.rol === ROLES.ADMINISTRADOR ? ROLES.ADMINISTRADOR : ROLES.DOCTOR;

  db.crearUsuarioPanel({ usuario, hash: resumirPassword(password), nombre, rol });
  anotarPanel(req, 'usuario.creado', { detalle: `"${usuario}" como ${rol}` });
  logger.info(`Usuario del panel creado: "${usuario}" como ${rol} (por "${req.usuario.username}").`);

  return volver(res, '/admin/usuarios', {
    tipo: 'ok',
    texto: `Usuario "${usuario}" creado. Entréguele la contraseña en persona y pídale que la cambie.`,
  });
});

adminRouter.post('/usuarios/:id/acceso', (req, res) => {
  const id = Number(req.params.id);

  // Quitarse el acceso a uno mismo es la forma más rápida de quedarse fuera.
  if (id === req.usuario.id) {
    return volver(res, '/admin/usuarios', { tipo: 'error', texto: 'No puede quitarse el acceso a usted mismo.' });
  }

  const objetivo = db.usuarioPanelPorId(id);
  if (!objetivo) return volver(res, '/admin/usuarios', { tipo: 'error', texto: 'Ese usuario no existe.' });

  const activar = req.body.activo === '1';

  // Dejar el panel sin ningún usuario activo lo apagaría para todos.
  if (!activar && db.contarUsuariosPanel() <= 1) {
    return volver(res, '/admin/usuarios', {
      tipo: 'error',
      texto: 'Es el último usuario con acceso: cree otro antes de quitárselo.',
    });
  }

  // Y sin administradores nadie podría volver a tocar la configuración ni
  // devolverle el acceso a nadie: el panel quedaría a medio gas para siempre.
  if (!activar && esAdministrador(objetivo) && db.contarAdministradoresPanel() <= 1) {
    return volver(res, '/admin/usuarios', {
      tipo: 'error',
      texto: 'Es el último administrador: nombre a otro antes de quitarle el acceso.',
    });
  }

  db.activarUsuarioPanel(id, activar);
  anotarPanel(req, 'usuario.acceso', {
    detalle: `${activar ? 'Devolvió' : 'Quitó'} el acceso a "${objetivo.username}"`,
  });
  logger.info(`Acceso al panel ${activar ? 'devuelto a' : 'retirado a'} "${objetivo.username}".`);

  return volver(res, '/admin/usuarios', {
    tipo: 'ok',
    texto: activar ? `"${objetivo.username}" vuelve a tener acceso.` : `"${objetivo.username}" ya no puede entrar.`,
  });
});

adminRouter.post('/usuarios/:id/rol', (req, res) => {
  const id = Number(req.params.id);
  const rol = req.body.rol === ROLES.ADMINISTRADOR ? ROLES.ADMINISTRADOR : ROLES.DOCTOR;

  const objetivo = db.usuarioPanelPorId(id);
  if (!objetivo) return volver(res, '/admin/usuarios', { tipo: 'error', texto: 'Ese usuario no existe.' });

  // Bajarse a uno mismo el papel es perder el acceso a esta misma página.
  if (id === req.usuario.id) {
    return volver(res, '/admin/usuarios', {
      tipo: 'error',
      texto: 'No puede cambiarse su propio papel. Pídaselo a otro administrador.',
    });
  }

  if (rol !== ROLES.ADMINISTRADOR && esAdministrador(objetivo) && db.contarAdministradoresPanel() <= 1) {
    return volver(res, '/admin/usuarios', {
      tipo: 'error',
      texto: 'Es el último administrador: nombre a otro antes de bajarle el papel.',
    });
  }

  db.cambiarRolPanel(id, rol);
  anotarPanel(req, 'usuario.rol', { detalle: `"${objetivo.username}" pasa a ser ${rol}` });
  logger.info(`"${objetivo.username}" pasa a ser ${rol} (por "${req.usuario.username}").`);

  return volver(res, '/admin/usuarios', {
    tipo: 'ok',
    texto: `"${objetivo.username}" ahora es ${rol === ROLES.ADMINISTRADOR ? 'administrador' : 'doctor'}.`,
  });
});

adminRouter.get('/usuarios/:id/password', (req, res) => {
  const objetivo = db.usuarioPanelPorId(Number(req.params.id));
  if (!objetivo) return volver(res, '/admin/usuarios', { tipo: 'error', texto: 'Ese usuario no existe.' });

  // La propia se cambia desde "Mi cuenta", que exige la actual.
  if (objetivo.id === req.usuario.id) return res.redirect(303, '/admin/cuenta');

  res.type('html').send(
    pagina({
      titulo: 'Restablecer contraseña',
      activo: '/admin/usuarios',
      aviso: avisoDe(req),
      usuario: req.usuario,
      contenido: paginas.restablecerPassword(objetivo),
    }),
  );
});

adminRouter.post('/usuarios/:id/password', (req, res) => {
  const id = Number(req.params.id);
  const objetivo = db.usuarioPanelPorId(id);
  if (!objetivo) return volver(res, '/admin/usuarios', { tipo: 'error', texto: 'Ese usuario no existe.' });

  if (id === req.usuario.id) {
    return volver(res, '/admin/usuarios', {
      tipo: 'error',
      texto: 'Su propia contraseña se cambia desde "Mi cuenta".',
    });
  }

  const password = String(req.body.password ?? '');
  const problema = problemaConLaPassword(password, { usuario: objetivo.username });
  if (problema) return volver(res, `/admin/usuarios/${id}/password`, { tipo: 'error', texto: problema });

  // La firma de la sesión lleva el resumen de la contraseña, así que las
  // sesiones que ese usuario tuviera abiertas caen solas con este cambio.
  db.cambiarPasswordPanel(id, resumirPassword(password));
  anotarPanel(req, 'usuario.password', { detalle: `De "${objetivo.username}"` });
  logger.info(`Contraseña de "${objetivo.username}" restablecida por "${req.usuario.username}".`);

  return volver(res, '/admin/usuarios', {
    tipo: 'ok',
    texto: `Contraseña de "${objetivo.username}" restablecida. Entréguesela en persona y pídale que la cambie.`,
  });
});

/* ------------------------------------------------------------------ */
/* Subir un archivo al conocimiento                                    */
/*                                                                     */
/* Aquí no se crea ningún documento: se extrae el texto y se le enseña  */
/* al doctor para que lo revise. Guardar lo hace después el mismo       */
/* formulario de siempre. Lo único que se guarda ya es el archivo       */
/* original, aparte y sin documento, con un token que viaja en ese      */
/* formulario; si nadie lo guarda, se descarta al día siguiente.        */
/* ------------------------------------------------------------------ */

adminRouter.post('/conocimiento/subir', (req, res) => {
  let terminado = false;

  const fallar = (texto) => {
    if (terminado) return;
    terminado = true;
    volver(res, '/admin/conocimiento', { tipo: 'error', texto });
  };

  let bus;
  try {
    // Los navegadores mandan el nombre del archivo en UTF-8; busboy, por
    // defecto, lo lee como latin1 y "Guía.pdf" llegaba como "GuÃ­a.pdf".
    bus = Busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: 1, fileSize: MAX_BYTES } });
  } catch {
    return fallar('No se recibió ningún archivo.');
  }

  let nombre = '';
  let pedazos = [];
  let bytes = 0;
  let demasiadoGrande = false;

  bus.on('file', (_campo, flujo, info) => {
    nombre = info.filename ?? '';

    if (!formatoDe(nombre)) {
      flujo.resume(); // hay que consumir el flujo aunque no sirva
      return;
    }

    flujo.on('data', (pedazo) => {
      bytes += pedazo.length;
      pedazos.push(pedazo);
    });

    flujo.on('limit', () => {
      demasiadoGrande = true;
      pedazos = [];
    });
  });

  bus.on('error', () => fallar('No se pudo recibir el archivo.'));

  bus.on('close', async () => {
    if (terminado) return;

    if (demasiadoGrande) {
      return fallar(`El archivo pasa de ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`);
    }
    if (!nombre) return fallar('No se eligió ningún archivo.');
    if (!formatoDe(nombre)) {
      return fallar('Solo se pueden subir archivos PDF, Word (.docx), .txt o .md.');
    }
    if (bytes === 0) return fallar('El archivo llegó vacío.');

    const datos = Buffer.concat(pedazos);
    const resultado = await extraerTexto({ buffer: datos, nombre });
    if (!resultado.ok) return fallar(resultado.error);

    // Sin el original se puede seguir: el asistente solo usa el texto.
    let archivo = null;
    try {
      db.descartarArchivosPendientes(new Date(Date.now() - 86_400_000).toISOString());
      archivo = randomBytes(18).toString('base64url');
      db.guardarArchivoPendiente({ token: archivo, nombre, tipo: tipoDeArchivo(nombre), datos });
    } catch (error) {
      logger.error(`No se pudo guardar el archivo original ${nombre}.`, error);
      archivo = null;
    }

    terminado = true;
    return res.type('html').send(
      pagina({
        titulo: 'Revisar documento',
        activo: '/admin/conocimiento',
        usuario: req.usuario,
        aviso: resultado.aviso ? { tipo: 'ok', texto: resultado.aviso } : null,
        contenido: paginas.revisarDocumento({
          titulo: tituloDesdeNombre(nombre),
          fuente: nombre,
          contenido: resultado.texto,
          archivo,
        }),
      }),
    );
  });

  return req.pipe(bus);
});
