/**
 * Borrado total de datos, a pedido del paciente (por WhatsApp) o del
 * administrador (desde el panel).
 *
 * Por WhatsApp va en dos pasos, para que nadie lo haga por error:
 *
 *   1. La persona escribe algo como "borrar mis datos". Se le explica qué se
 *      va a borrar y se le muestran dos botones: "Sí, borrar todo" y
 *      "Cancelar". Ese mensaje no se guarda en la conversación.
 *   2. Si toca "Sí, borrar todo" en los siguientes 15 minutos, se borra y se
 *      le confirma. Pasado ese tiempo, el botón ya no vale: se le vuelve a
 *      preguntar. Así un toque accidental días después no borra nada.
 *
 * Si el paciente tenía alertas sin revisar, ANTES de borrar se le avisa al
 * doctor: después ya no quedaría nada en el panel que mirar.
 *
 * De cada borrado queda una constancia SIN datos personales (tabla
 * `deletions`): el id que tenía la ficha, quién lo pidió y cuándo.
 */
import * as db from '../db/queries.js';
import * as whatsapp from './whatsapp.js';
import * as alertas from './alertas.js';
import { logger, ofuscarTelefono } from '../utils/logger.js';

const BOTON_SI = 'borrado:si';
const BOTON_CANCELAR = 'borrado:cancelar';

/** Cuánto vale la confirmación después de pedirla. */
const VIGENCIA_MS = 15 * 60 * 1000;

/**
 * Teléfonos que pidieron borrar y cuándo. En memoria a propósito: si el
 * servidor se reinicia en medio, lo peor que pasa es que se le vuelve a
 * preguntar.
 */
const pendientes = new Map();

const MENSAJES = {
  confirmarPaciente:
    '¿Quiere que borre *todos* sus datos de este asistente?\n\n' +
    'Se eliminarán para siempre su ficha, nuestras conversaciones, sus glucemias y sus ' +
    'alertas. *No se puede deshacer.*\n\n' +
    'Si más adelante quiere volver a usar el asistente, tendrá que registrarse de nuevo ' +
    'en el consultorio.',
  confirmarSinFicha:
    '¿Quiere que borre los datos que tengo de este número (su aceptación del aviso de ' +
    'privacidad y sus intentos de verificación)?\n\n*No se puede deshacer.*',
  listo:
    'Listo ✅ Borré todos sus datos de este asistente.\n\n' +
    'Si vuelve a escribir, empezaré de cero, como con un número nuevo. Los mensajes de ' +
    'este chat siguen en su teléfono; puede borrarlos desde WhatsApp.',
  cancelado: 'Entendido, no borré nada. Sigo aquí para lo que necesite.',
  vencido: 'Esa confirmación ya venció. Se la pido de nuevo:',
};

/** Quita tildes y mayúsculas para comparar lo que escribió la persona. */
function limpiar(texto = '') {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ¿La persona está pidiendo borrar sus datos? Se busca un verbo de borrar
 * seguido de "mis datos" o parecido. Si se equivoca, no pasa nada grave: lo
 * único que hace es preguntarle si de verdad quiere.
 */
export function pidioBorrar(texto) {
  const limpio = limpiar(texto);
  return (
    /\b(borr|elimin|suprim|quit)\w*\b.{0,25}\b(mis datos|mi informacion|mi cuenta|mis registros)\b/.test(
      limpio,
    ) || ['borrar datos', 'eliminar datos', 'borrar mis datos', 'eliminar mis datos'].includes(limpio)
  );
}

/** ¿El mensaje es el toque de uno de nuestros botones de borrado? */
export function esBotonDeBorrado(mensaje) {
  return whatsapp.idDeBotonTocado(mensaje)?.startsWith('borrado:') ?? false;
}

/** Explica qué se va a borrar y muestra los dos botones. */
export async function pedirConfirmacion(telefono, { conFicha }) {
  pendientes.set(telefono, Date.now());
  return whatsapp.enviarBotones(
    telefono,
    conFicha ? MENSAJES.confirmarPaciente : MENSAJES.confirmarSinFicha,
    [
      { id: BOTON_SI, titulo: 'Sí, borrar todo' },
      { id: BOTON_CANCELAR, titulo: 'Cancelar' },
    ],
  );
}

/**
 * Atiende el toque de un botón de borrado.
 *
 * @param {object} mensaje el mensaje de WhatsApp
 * @param {string} telefono
 * @param {object|null} paciente el paciente verificado, o null si el número no lo es
 */
export async function atenderBoton(mensaje, telefono, paciente) {
  const id = whatsapp.idDeBotonTocado(mensaje);

  if (id === BOTON_CANCELAR) {
    pendientes.delete(telefono);
    await whatsapp.enviarMensaje(telefono, MENSAJES.cancelado);
    return;
  }

  if (id !== BOTON_SI) return;

  const pedidoEn = pendientes.get(telefono);
  if (!pedidoEn || Date.now() - pedidoEn > VIGENCIA_MS) {
    await whatsapp.enviarMensaje(telefono, MENSAJES.vencido);
    await pedirConfirmacion(telefono, { conFicha: Boolean(paciente) });
    return;
  }

  pendientes.delete(telefono);
  if (paciente) {
    await borrarPaciente(paciente, 'paciente');
  } else {
    borrarNumero(telefono);
  }
  await whatsapp.enviarMensaje(telefono, MENSAJES.listo);
}

/**
 * Borra todo lo de un paciente. Lo usan el WhatsApp y el panel.
 *
 * @param {object} paciente fila de `patients`
 * @param {string} solicitadoPor 'paciente' | 'panel:<usuario>'
 * @returns {Promise<{filas: number, teniaAlertas: boolean, doctorAvisado: boolean}>}
 */
export async function borrarPaciente(paciente, solicitadoPor) {
  const abiertas = db.alertasAbiertasDe(paciente.id);

  let doctorAvisado = false;
  if (abiertas.length > 0) {
    // Si el aviso falla, se borra igual: es un derecho del paciente y no puede
    // depender de que WhatsApp esté funcionando.
    doctorAvisado = await alertas.avisarBorradoConAlertas(paciente, abiertas).catch((error) => {
      logger.error('No se pudo avisar al doctor del borrado.', error);
      return false;
    });
  }

  const filas = db.borrarDatosDePaciente(paciente.id);
  db.registrarBorrado({
    pacienteRef: paciente.id,
    solicitadoPor,
    teniaAlertas: abiertas.length > 0,
    doctorAvisado,
  });

  logger.info(
    `Datos del paciente #${paciente.id} borrados a pedido de ${solicitadoPor} ` +
      `(${filas} filas${abiertas.length ? `, ${abiertas.length} alertas abiertas` : ''}).`,
  );
  return { filas, teniaAlertas: abiertas.length > 0, doctorAvisado };
}

/** Borra lo de un número que nunca llegó a verificarse. */
export function borrarNumero(telefono) {
  const filas = db.borrarDatosDeTelefono(telefono);
  db.registrarBorrado({ solicitadoPor: 'paciente' });
  logger.info(`Datos de un número sin verificar borrados (${ofuscarTelefono(telefono)}, ${filas} filas).`);
  return filas;
}
