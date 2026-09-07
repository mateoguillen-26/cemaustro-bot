/**
 * Rutas del panel de administración.
 *
 * Todo cuelga de /admin y exige sesión iniciada, salvo la propia pantalla de
 * entrada. Los avisos ("guardado", "no se pudo") viajan en la URL como
 * ?ok= / ?error=, salvo el código de vinculación: ese se pinta directamente
 * en la respuesta del POST para que no quede en el historial del navegador.
 */
import express from 'express';
import { advertenciasDeConfiguracion } from '../config.js';
import { logger, incidenciasRecientes } from '../utils/logger.js';
import {
  abrirSesion,
  anotarFallo,
  cerrarSesion,
  estaBloqueado,
  minutosQueFaltan,
  mismoOrigen,
  olvidarFallos,
  passwordCorrecta,
  problemaConLaPassword,
  requiereSesion,
  resumirPassword,
} from './auth.js';
import { pagina, paginaEntrar } from './vistas.js';
import * as paginas from './paginas.js';
import * as db from '../db/queries.js';
import * as auth from '../services/auth.js';
import * as conocimiento from '../services/conocimiento.js';
import { CATALOGO, ajuste, estaPersonalizado, guardarAjuste, restaurarAjuste } from '../services/ajustes.js';
import { esCedulaValida, normalizarCedula } from '../utils/cedula.js';

export const adminRouter = express.Router();

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
  res.type('html').send(
    pagina({
      titulo: 'Pacientes',
      activo: '/admin/pacientes',
      aviso: avisoDe(req),
      usuario: req.usuario,
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
      usuario: req.usuario,
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
      usuario: req.usuario,
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
      usuario: req.usuario,
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
      ),
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

  const problema = problemaConLaPassword(nueva);
  if (problema) return volver(res, '/admin/cuenta', { tipo: 'error', texto: problema });

  db.cambiarPasswordPanel(req.usuario.id, resumirPassword(nueva));
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

  const problema = problemaConLaPassword(password);
  if (problema) return volver(res, '/admin/usuarios', { tipo: 'error', texto: problema });

  db.crearUsuarioPanel({ usuario, hash: resumirPassword(password), nombre });
  logger.info(`Usuario del panel creado: "${usuario}" (por "${req.usuario.username}").`);

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

  db.activarUsuarioPanel(id, activar);
  logger.info(`Acceso al panel ${activar ? 'devuelto a' : 'retirado a'} "${objetivo.username}".`);

  return volver(res, '/admin/usuarios', {
    tipo: 'ok',
    texto: activar ? `"${objetivo.username}" vuelve a tener acceso.` : `"${objetivo.username}" ya no puede entrar.`,
  });
});
