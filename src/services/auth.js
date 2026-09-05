/**
 * Verificación de pacientes.
 *
 * Ningún número recibe contenido médico sin pasar por aquí. Hay dos caminos,
 * y los dos exigen que la persona ya esté en el padrón que cargó el doctor:
 *
 *   A) El doctor ya registró el teléfono del paciente.
 *      El paciente escribe su cédula desde ESE número y queda verificado.
 *      Son dos factores reales: tener el teléfono + saber la cédula.
 *
 *   B) El teléfono no está registrado (o el paciente cambió de número).
 *      Hace falta, además de la cédula, un código de 6 dígitos que el doctor
 *      genera en el panel y le entrega en consulta. Al usarlo, el número
 *      queda ligado a ese paciente y el código se quema.
 *
 * Por qué el código no se manda por WhatsApp: enviarlo al mismo número desde
 * el que escriben no verifica nada — quien tiene el teléfono recibiría el
 * código. El código vale justamente porque viaja por otro canal (la consulta).
 *
 * Contra la enumeración: las respuestas de fallo son siempre iguales. Ni la
 * cédula ni el código revelan si esa persona es paciente del consultorio,
 * porque saber quién se atiende con un diabetólogo ya es información de salud.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger, ofuscarTelefono, ofuscarCedula } from '../utils/logger.js';
import { extraerCedula, extraerCodigo } from '../utils/cedula.js';
import { enMinutos } from '../utils/datetime.js';
import * as db from '../db/queries.js';

/** Resultado de intentar verificar un mensaje entrante. */
export const RESULTADO = {
  VERIFICADO: 'verificado',
  PENDIENTE: 'pendiente', // hay que seguir pidiendo datos
  BLOQUEADO: 'bloqueado',
};

/* ------------------------------------------------------------------ */
/* Textos                                                              */
/* ------------------------------------------------------------------ */

const MENSAJES = {
  pedirDatos: () =>
    `Hola 👋 Soy el asistente de educación en diabetes de ${config.clinica.nombre}.\n\n` +
    'Antes de poder ayudarle necesito confirmar que usted es paciente del consultorio.\n\n' +
    'Por favor, escríbame *su número de cédula* (10 dígitos).',

  pedirCodigo: () =>
    'Gracias. Este número todavía no está vinculado a una historia clínica.\n\n' +
    `Escríbame de nuevo su cédula junto con el *código de 6 dígitos* que le entregó el ${config.clinica.doctor} en la consulta.\n\n` +
    'Por ejemplo: _0102030405 123456_\n\n' +
    (config.clinica.telefonoContacto
      ? `Si no tiene el código, pídalo en el consultorio: ${config.clinica.telefonoContacto}`
      : 'Si no tiene el código, pídalo en el consultorio.'),

  cedulaMalFormada: () =>
    'Ese número de cédula no parece correcto. Son 10 dígitos, sin puntos ni guiones. ¿Me lo puede escribir de nuevo?',

  // Una sola respuesta para "no está en el padrón", "está de baja" y "código
  // equivocado". Cualquier diferencia entre ellas permitiría averiguar desde
  // afuera quién es paciente del consultorio.
  noSePudo: () =>
    'No pude verificar esos datos.\n\n' +
    'Revise que la cédula y el código estén bien escritos. ' +
    (config.clinica.telefonoContacto
      ? `Si el problema sigue, comuníquese con el consultorio: ${config.clinica.telefonoContacto}`
      : 'Si el problema sigue, comuníquese con el consultorio.'),

  bloqueado: () =>
    'Por seguridad, este número quedó bloqueado un rato tras varios intentos fallidos.\n\n' +
    'Vuelva a intentarlo más tarde o comuníquese con el consultorio.',

  bienvenida: (paciente) =>
    `¡Listo, ${primerNombre(paciente.name)}! Su número quedó verificado ✅\n\n` +
    `Soy el asistente del ${config.clinica.doctor}. Puedo resolverle dudas sobre *diabetes*: ` +
    'alimentación, actividad física, cuidado de los pies, cómo medirse la glucosa y qué significan sus valores.\n\n' +
    'También puede reportarme sus mediciones, así: _"glucosa 128 en ayunas"_.\n\n' +
    '⚠️ Importante: le doy información educativa, *no* diagnósticos ni cambios de tratamiento. ' +
    'Eso siempre lo decide su médico en consulta.\n\n' +
    '¿En qué le puedo ayudar?',

  sesionCerrada: () =>
    'Listo, cerré su sesión. Cuando quiera volver a escribirme, mándeme su cédula otra vez.',
};

/** "María Elena Vásquez" -> "María" */
function primerNombre(nombre = '') {
  return String(nombre).trim().split(/\s+/)[0] || 'paciente';
}

/* ------------------------------------------------------------------ */
/* Códigos de vinculación                                              */
/* ------------------------------------------------------------------ */

/**
 * Resumen del código. Lleva la sal secreta y el id del paciente, de modo que
 * un código solo sirve para la persona a la que se le emitió, aunque alguien
 * llegara a leer la tabla.
 */
function resumirCodigo(pacienteId, codigo) {
  return crypto
    .createHash('sha256')
    .update(`${config.auth.pepper}:${pacienteId}:${codigo}`)
    .digest('hex');
}

/**
 * Genera un código nuevo para un paciente y devuelve el código en claro.
 * Es la única vez que existe legible: en la base solo queda el resumen, así
 * que el doctor tiene que copiarlo en ese momento.
 */
export function generarCodigo(pacienteId) {
  const codigo = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const expira = enMinutos(config.auth.minutosDelCodigo);

  db.guardarCodigo(pacienteId, resumirCodigo(pacienteId, codigo), expira);
  logger.info(`Código de vinculación generado para el paciente #${pacienteId}.`);

  return { codigo, expira };
}

/* ------------------------------------------------------------------ */
/* Estado de un número                                                 */
/* ------------------------------------------------------------------ */

/**
 * Paciente verificado detrás de un teléfono, o null.
 * Se comprueba en cada mensaje: si el doctor da de baja al paciente o revoca
 * la sesión, el acceso se corta en el siguiente mensaje, sin esperar nada.
 */
export function pacienteVerificado(telefono) {
  const sesion = db.sesionVigente(telefono);
  if (!sesion) return null;

  const paciente = db.obtenerPaciente(sesion.patient_id);
  if (!paciente || !paciente.active) return null;

  // El teléfono tiene que seguir siendo el que el paciente tiene registrado.
  // Si el doctor se lo cambió en el panel, esta sesión ya no vale.
  if (paciente.phone !== telefono) return null;

  db.tocarSesion(telefono);
  return paciente;
}

/** ¿El número está bloqueado por intentos fallidos? */
function estaBloqueado(telefono) {
  const desde = enMinutos(-config.auth.minutosDeBloqueo);
  return db.fallosDesde(telefono, desde) >= config.auth.maxIntentos;
}

/** ¿El paciente pidió cerrar sesión? */
export function pidioCerrarSesion(texto = '') {
  const limpio = texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
  return ['salir', 'cerrar sesion', 'cerrar session', 'desvincular', 'logout'].includes(limpio);
}

/** Cierra la sesión de un paciente a petición suya. */
export function cerrarSesion(paciente) {
  db.revocarSesionesDe(paciente.id);
  logger.info(`El paciente #${paciente.id} cerró su sesión.`);
  return MENSAJES.sesionCerrada();
}

/* ------------------------------------------------------------------ */
/* Verificación                                                        */
/* ------------------------------------------------------------------ */

/**
 * Procesa un mensaje de un número todavía no verificado.
 *
 * @param {string} telefono
 * @param {string} texto lo que escribió (o dictó) la persona
 * @returns {{resultado: string, paciente: object|null, respuesta: string}}
 */
export function intentarVerificar(telefono, texto) {
  if (estaBloqueado(telefono)) {
    logger.warn(`Número bloqueado por intentos fallidos: ${ofuscarTelefono(telefono)}.`);
    return { resultado: RESULTADO.BLOQUEADO, paciente: null, respuesta: MENSAJES.bloqueado() };
  }

  const cedula = extraerCedula(texto);

  if (!cedula) {
    // Puede ser el primer "hola" o una cédula mal escrita. Si el mensaje trae
    // una tira larga de dígitos, es lo segundo y conviene decirlo.
    const pareceIntento = /\d{8,}/.test(texto ?? '');
    if (pareceIntento) {
      db.registrarIntento(telefono, null, 'fallo', 'cédula con formato inválido');
      return {
        resultado: RESULTADO.PENDIENTE,
        paciente: null,
        respuesta: MENSAJES.cedulaMalFormada(),
      };
    }
    return { resultado: RESULTADO.PENDIENTE, paciente: null, respuesta: MENSAJES.pedirDatos() };
  }

  const enmascarada = ofuscarCedula(cedula);
  const paciente = db.pacientePorCedula(cedula);

  // --- Camino A: el doctor ya tenía registrado este teléfono ---
  if (paciente?.active && paciente.phone === telefono) {
    return verificar(paciente, telefono, enmascarada, 'teléfono ya registrado');
  }

  // --- Camino B: hace falta el código de vinculación ---
  const codigo = extraerCodigo(texto);

  if (!codigo) {
    // Se pide el código sin importar si la cédula existe: responder distinto
    // aquí delataría quién es paciente del consultorio.
    return { resultado: RESULTADO.PENDIENTE, paciente: null, respuesta: MENSAJES.pedirCodigo() };
  }

  if (!paciente || !paciente.active) {
    db.registrarIntento(telefono, enmascarada, 'fallo', 'la cédula no está en el padrón activo');
    return { resultado: RESULTADO.PENDIENTE, paciente: null, respuesta: MENSAJES.noSePudo() };
  }

  const emitido = db.codigoVigente(paciente.id, resumirCodigo(paciente.id, codigo));
  if (!emitido) {
    db.registrarIntento(telefono, enmascarada, 'fallo', 'código incorrecto o vencido');
    logger.warn(
      `Código inválido para la cédula ${enmascarada} desde ${ofuscarTelefono(telefono)}.`,
    );
    return { resultado: RESULTADO.PENDIENTE, paciente: null, respuesta: MENSAJES.noSePudo() };
  }

  // Quemar el código antes de abrir la sesión: si dos mensajes llegaran a la
  // vez, solo uno puede consumirlo.
  if (!db.consumirCodigo(emitido.id, telefono)) {
    db.registrarIntento(telefono, enmascarada, 'fallo', 'código ya usado');
    return { resultado: RESULTADO.PENDIENTE, paciente: null, respuesta: MENSAJES.noSePudo() };
  }

  const vinculado = db.vincularTelefono(paciente.id, telefono);
  return verificar(vinculado, telefono, enmascarada, 'código de vinculación');
}

/** Abre la sesión y arma la bienvenida. */
function verificar(paciente, telefono, cedulaEnmascarada, via) {
  db.abrirSesion(paciente.id, telefono, config.auth.diasDeSesion);
  db.registrarIntento(telefono, cedulaEnmascarada, 'ok', via);
  logger.info(
    `Paciente #${paciente.id} verificado desde ${ofuscarTelefono(telefono)} (${via}).`,
  );

  return {
    resultado: RESULTADO.VERIFICADO,
    paciente,
    respuesta: MENSAJES.bienvenida(paciente),
  };
}
