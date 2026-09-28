/**
 * Consentimiento de tratamiento de datos.
 *
 * Un número nuevo, antes de dar su cédula o cualquier otro dato, recibe un
 * aviso con dos botones: "Acepto" y "No acepto".
 *
 *   - Si acepta, se guarda quién (el teléfono), cuándo y QUÉ VERSIÓN del texto
 *     vio, y sigue la verificación de siempre. Al verificarse, esa aceptación
 *     se liga a su ficha.
 *   - Si no acepta, no se guarda nada suyo y se le dice cómo contactar al
 *     consultorio. Si vuelve a escribir, se le pregunta de nuevo.
 *   - Si escribe en lugar de tocar un botón, se le repite el aviso: la
 *     aceptación siempre queda con el toque del botón, nunca adivinada a
 *     partir de un texto.
 *
 * Por decisión del consultorio (09/2026), los números que ya se habían
 * verificado alguna vez NO pasan por aquí: el aviso es solo para los nuevos.
 */
import crypto from 'node:crypto';
import * as db from '../db/queries.js';
import * as whatsapp from './whatsapp.js';
import { ajuste } from './ajustes.js';
import { logger, ofuscarTelefono } from '../utils/logger.js';

const PREFIJO = 'consentimiento';
const BOTON_NO = `${PREFIJO}:no`;

/** El id del botón "Acepto" lleva la versión del texto que la persona tenía delante. */
const botonAcepto = (version) => `${PREFIJO}:acepto:v${version}`;

/** ¿Este número tiene que aceptar antes de seguir? */
export function necesitaConsentimiento(telefono) {
  return !db.tieneConsentimiento(telefono) && !db.seVerificoAlgunaVez(telefono);
}

/** Versión del texto vigente (se crea la primera vez que se muestra). */
function versionVigente() {
  const texto = ajuste('consentimiento.texto');
  const resumen = crypto.createHash('sha256').update(texto).digest('hex');
  return { texto, version: db.versionDeTextoConsentimiento(texto, resumen) };
}

/** Envía el aviso con los dos botones. */
export async function pedirConsentimiento(telefono) {
  const { texto, version } = versionVigente();
  return whatsapp.enviarBotones(telefono, texto, [
    { id: botonAcepto(version), titulo: 'Acepto' },
    { id: BOTON_NO, titulo: 'No acepto' },
  ]);
}

/**
 * Qué significa un mensaje para el consentimiento:
 *   { tipo: 'acepto', version } | { tipo: 'no' } | null (no tocó un botón nuestro)
 */
export function leerRespuesta(mensaje) {
  const id = whatsapp.idDeBotonTocado(mensaje);
  if (!id) return null;
  if (id === BOTON_NO) return { tipo: 'no' };

  const coincide = /^consentimiento:acepto:v(\d+)$/.exec(id);
  if (!coincide) return null;
  return { tipo: 'acepto', version: Number(coincide[1]) };
}

/**
 * Atiende un mensaje de un número que todavía no ha aceptado.
 *
 * @returns {Promise<boolean>} true si aceptó en este mensaje (y hay que seguir
 *   con la verificación); false si ya se le respondió y no hay más que hacer.
 */
export async function atender(telefono, mensaje) {
  const respuesta = leerRespuesta(mensaje);

  if (respuesta?.tipo === 'acepto' && db.existeVersionConsentimiento(respuesta.version)) {
    db.registrarConsentimiento(telefono, respuesta.version, mensaje.id);
    logger.info(
      `Consentimiento aceptado desde ${ofuscarTelefono(telefono)} (texto v${respuesta.version}).`,
    );
    return true;
  }

  if (respuesta?.tipo === 'no') {
    logger.info(`Consentimiento rechazado desde ${ofuscarTelefono(telefono)}.`);
    await whatsapp.enviarMensaje(telefono, ajuste('consentimiento.rechazado'));
    return false;
  }

  await pedirConsentimiento(telefono);
  return false;
}
