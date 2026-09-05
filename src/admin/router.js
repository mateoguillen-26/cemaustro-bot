/**
 * Rutas del panel de administración.
 *
 * Todo cuelga de /admin y pasa por Basic Auth + comprobación de origen.
 * Los avisos ("guardado", "no se pudo") viajan en la URL como ?ok= / ?error=,
 * salvo el código de vinculación: ese se pinta directamente en la respuesta
 * del POST para que no quede en el historial del navegador.
 */
import express from 'express';
import { advertenciasDeConfiguracion } from '../config.js';
import { logger, incidenciasRecientes } from '../utils/logger.js';
import { requiereAuth, mismoOrigen } from './auth.js';
import { pagina } from './vistas.js';
import * as paginas from './paginas.js';
import * as db from '../db/queries.js';
import * as auth from '../services/auth.js';
import * as conocimiento from '../services/conocimiento.js';
import { CATALOGO, ajuste, estaPersonalizado, guardarAjuste, restaurarAjuste } from '../services/ajustes.js';
import { esCedulaValida, normalizarCedula } from '../utils/cedula.js';

export const adminRouter = express.Router();

adminRouter.use(express.urlencoded({ extended: false, limit: '2mb' }));
adminRouter.use(requiereAuth);
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

/** Normaliza un teléfono escrito a mano: solo dígitos, sin '+' ni espacios. */
function normalizarTelefono(valor) {
  return String(valor ?? '').replace(/[^0-9]/g, '') || null;
}

/* ------------------------------------------------------------------ */
/* Resumen                                                             */
/* ------------------------------------------------------------------ */

adminRouter.get('/', (req, res) => {
  res.type('html').send(
    pagina({
      titulo: 'Resumen',
      activo: '/admin',
      aviso: avisoDe(req),
      contenido: paginas.resumen(db.metricas(), db.alertas({ soloAbiertas: true, limite: 10 })),
    }),
  );
});

/* ------------------------------------------------------------------ */
/* Pacientes                                                           */
/* ------------------------------------------------------------------ */

adminRouter.get('/pacientes', (req, res) => {
  const busqueda = String(req.query.q ?? '').trim();
  res.type('html').send(
    pagina({
      titulo: 'Pacientes',
      activo: '/admin/pacientes',
      aviso: avisoDe(req),
      contenido: paginas.pacientes(db.listarPacientes({ busqueda }), busqueda),
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
  if (telefono && db.pacientePorTelefono(telefono)) {
    return volver(res, '/admin/pacientes', {
      tipo: 'error',
      texto: 'Ese teléfono ya está registrado a nombre de otro paciente.',
    });
  }

  try {
    const paciente = db.crearPaciente({
      cedula,
      name: nombre,
      phone: telefono,
      diabetesType: req.body.diabetes_type || null,
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
    lecturas: db.glucemiasDe(paciente.id),
    resumenGlucemias: db.resumenGlucemias(paciente.id),
    conversacion: db.conversacionDe(paciente.id, 120),
    alertas: db.alertasDe(paciente.id),
    codigoPendiente: db.tieneCodigoPendiente(paciente.id),
    codigo: null,
    ...extras,
  });
}

adminRouter.get('/pacientes/:id', (req, res) => {
  const contenido = fichaDe(Number(req.params.id));
  if (!contenido) return res.status(404).send('Paciente no encontrado.');

  res.type('html').send(
    pagina({ titulo: 'Paciente', activo: '/admin/pacientes', aviso: avisoDe(req), contenido }),
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
  const ocupado = telefono ? db.pacientePorTelefono(telefono) : null;
  if (ocupado && ocupado.id !== id) {
    return volver(res, `/admin/pacientes/${id}`, {
      tipo: 'error',
      texto: 'Ese teléfono ya está registrado a nombre de otro paciente.',
    });
  }

  const activo = req.body.active === '1';

  db.actualizarPaciente(id, {
    name: nombre,
    phone: telefono,
    diabetesType: req.body.diabetes_type || null,
    notes: String(req.body.notes ?? '').trim() || null,
    active: activo,
  });

  // Si le cambiaron el número o lo desactivaron, la sesión anterior ya no
  // debe servir: quien tuviera el teléfono viejo perdería el acceso ahora.
  if (telefono !== paciente.phone || !activo) {
    db.revocarSesionesDe(id);
  }

  logger.info(`Paciente #${id} actualizado desde el panel.`);
  return volver(res, `/admin/pacientes/${id}`, { tipo: 'ok', texto: 'Datos guardados.' });
});

adminRouter.post('/pacientes/:id/codigo', (req, res) => {
  const id = Number(req.params.id);
  if (!db.obtenerPaciente(id)) return res.status(404).send('Paciente no encontrado.');

  const codigo = auth.generarCodigo(id);

  // Se responde con la página ya pintada, sin redirect: el código solo existe
  // legible en este momento y no debe quedar en la barra de direcciones.
  res.type('html').send(
    pagina({
      titulo: 'Paciente',
      activo: '/admin/pacientes',
      aviso: { tipo: 'ok', texto: 'Código generado. Anótelo ahora: no se vuelve a mostrar.' },
      contenido: fichaDe(id, { codigo }),
    }),
  );
});

adminRouter.post('/pacientes/:id/revocar', (req, res) => {
  const id = Number(req.params.id);
  if (!db.obtenerPaciente(id)) return res.status(404).send('Paciente no encontrado.');

  const cerradas = db.revocarSesionesDe(id);
  logger.info(`Sesión del paciente #${id} cerrada desde el panel.`);

  return volver(res, `/admin/pacientes/${id}`, {
    tipo: 'ok',
    texto: cerradas > 0 ? 'Sesión cerrada. Tendrá que verificarse de nuevo.' : 'No tenía sesión abierta.',
  });
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
      contenido: paginas.listaAlertas(db.alertas({ soloAbiertas }), soloAbiertas),
    }),
  );
});

adminRouter.post('/alertas/:id/resolver', (req, res) => {
  const resuelta = db.resolverAlerta(Number(req.params.id));
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

  const resultado = await conocimiento.indexarDocumento(documento.id);

  return volver(res, '/admin/conocimiento', {
    tipo: resultado.ok ? 'ok' : 'error',
    texto: resultado.ok
      ? `Documento guardado e indexado en ${resultado.fragmentos} fragmento(s).`
      : `Documento guardado, pero no se pudo indexar: ${resultado.error} Use "Reindexar".`,
  });
});

adminRouter.post('/conocimiento/:id/reindexar', async (req, res) => {
  const resultado = await conocimiento.indexarDocumento(Number(req.params.id));
  return volver(res, '/admin/conocimiento', {
    tipo: resultado.ok ? 'ok' : 'error',
    texto: resultado.ok ? `Reindexado en ${resultado.fragmentos} fragmento(s).` : resultado.error,
  });
});

adminRouter.post('/conocimiento/:id/activar', (req, res) => {
  const activo = req.body.activo === '1';
  db.activarDocumento(Number(req.params.id), activo);
  conocimiento.invalidarCache();
  return volver(res, '/admin/conocimiento', {
    tipo: 'ok',
    texto: activo ? 'Documento encendido.' : 'Documento apagado.',
  });
});

adminRouter.post('/conocimiento/:id/borrar', (req, res) => {
  const borrado = db.borrarDocumento(Number(req.params.id));
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
      contenido: paginas.configuracion(valoresDeConfiguracion()),
    }),
  );
});

adminRouter.post('/configuracion', (req, res) => {
  const clave = String(req.body.clave ?? '');

  if (req.body.restaurar === '1') {
    restaurarAjuste(clave);
    return volver(res, '/admin/configuracion', { tipo: 'ok', texto: 'Valor de fábrica restaurado.' });
  }

  const definicion = CATALOGO.find((a) => a.clave === clave);
  const valor = definicion?.tipo === 'si_no' ? req.body.valor === '1' : req.body.valor;

  const error = guardarAjuste(clave, valor);
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
      contenido: paginas.seguridad(
        db.ultimosIntentos(60),
        incidenciasRecientes(30),
        advertenciasDeConfiguracion(),
      ),
    }),
  );
});
