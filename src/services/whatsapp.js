/**
 * Servicio de WhatsApp (Meta Cloud API).
 *  - Enviar mensajes de texto libres (solo dentro de la ventana de 24 h)
 *  - Enviar plantillas aprobadas (funcionan siempre)
 *  - Marcar mensajes como leídos
 *  - Descargar audios (.ogg) recibidos
 *  - Validar la firma de los webhooks
 */
import crypto from 'node:crypto';
import axios from 'axios';
import { config } from '../config.js';
import { logger, ofuscarTelefono } from '../utils/logger.js';

/**
 * Código de error de Meta cuando se escribe fuera de la ventana de 24 horas.
 * Al recibirlo hay que reintentar con una plantilla aprobada.
 */
export const FUERA_DE_VENTANA = 131047;

/** Cliente HTTP con el token de acceso ya configurado. */
function cliente() {
  return axios.create({
    baseURL: config.whatsapp.baseUrl,
    headers: { Authorization: `Bearer ${config.whatsapp.token}` },
    timeout: 30_000,
  });
}

function detalleError(error) {
  return error?.response?.data?.error?.message ?? error?.message ?? 'error desconocido';
}

function codigoError(error) {
  return error?.response?.data?.error?.code ?? null;
}

/** Envía un payload ya armado y normaliza el resultado. */
async function enviar(payload, descripcion) {
  try {
    await cliente().post(`/${config.whatsapp.phoneNumberId}/messages`, payload);
    logger.info(`${descripcion} enviado a ${ofuscarTelefono(payload.to)}.`);
    return { ok: true, codigo: null };
  } catch (error) {
    const codigo = codigoError(error);
    logger.error(
      `No se pudo enviar ${descripcion} a ${ofuscarTelefono(payload.to)} ` +
        `(código ${codigo ?? 's/n'}): ${detalleError(error)}`,
    );
    return { ok: false, codigo };
  }
}

/**
 * Envía un mensaje de texto libre.
 * Solo funciona dentro de la ventana de 24 h desde el último mensaje del usuario.
 *
 * @returns {Promise<{ok: boolean, codigo: number|null}>}
 */
export async function enviarMensaje(telefono, texto) {
  if (!texto || !texto.trim()) {
    logger.warn('Se intentó enviar un mensaje vacío; se omite.');
    return { ok: false, codigo: null };
  }

  // WhatsApp acepta hasta 4096 caracteres por mensaje de texto.
  const contenido = texto.length > 4000 ? `${texto.slice(0, 3990)}…` : texto;

  return enviar(
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: telefono,
      type: 'text',
      text: { preview_url: false, body: contenido },
    },
    'Mensaje',
  );
}

/**
 * Envía una plantilla aprobada por Meta. Funciona también fuera de la
 * ventana de 24 horas, que es el caso de las alertas al doctor de madrugada.
 *
 * @param {string} telefono
 * @param {string} nombrePlantilla
 * @param {string[]} variables valores para {{1}}, {{2}}... en orden
 */
export async function enviarPlantilla(telefono, nombrePlantilla, variables = []) {
  if (!nombrePlantilla) {
    logger.warn('Se pidió enviar una plantilla pero no hay ninguna configurada.');
    return { ok: false, codigo: null };
  }

  const componentes = [];
  if (variables.length > 0) {
    componentes.push({
      type: 'body',
      // Las variables de plantilla no admiten saltos de línea ni espacios seguidos.
      parameters: variables.map((v) => ({
        type: 'text',
        text: String(v).replace(/\s+/g, ' ').trim().slice(0, 900) || '-',
      })),
    });
  }

  return enviar(
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: telefono,
      type: 'template',
      template: {
        name: nombrePlantilla,
        language: { code: config.whatsapp.plantillaIdioma },
        components: componentes,
      },
    },
    `Plantilla "${nombrePlantilla}"`,
  );
}

/** Marca un mensaje como leído. No es crítico si falla. */
export async function marcarComoLeido(waMessageId) {
  if (!waMessageId) return;
  try {
    await cliente().post(`/${config.whatsapp.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: waMessageId,
    });
  } catch (error) {
    logger.debug(`No se pudo marcar como leído: ${detalleError(error)}`);
  }
}

/**
 * Descarga un archivo de media (audio) recibido por WhatsApp.
 * Son dos pasos: primero la URL temporal, luego el binario.
 *
 * @returns {Promise<{buffer: Buffer, mimeType: string} | null>}
 */
export async function descargarMedia(mediaId) {
  try {
    const { data: info } = await cliente().get(`/${mediaId}`);
    if (!info?.url) {
      logger.error(`Meta no devolvió URL para el media ${mediaId}.`);
      return null;
    }

    const respuesta = await axios.get(info.url, {
      headers: { Authorization: `Bearer ${config.whatsapp.token}` },
      responseType: 'arraybuffer',
      timeout: 60_000,
    });

    const buffer = Buffer.from(respuesta.data);
    const mimeType = info.mime_type || 'audio/ogg';

    logger.info(`Archivo descargado (${(buffer.length / 1024).toFixed(1)} KB, ${mimeType}).`);
    return { buffer, mimeType };
  } catch (error) {
    logger.error(`No se pudo descargar el media ${mediaId}: ${detalleError(error)}`);
    return null;
  }
}

/**
 * Comprueba la firma X-Hub-Signature-256 que Meta pone en cada webhook.
 *
 * Sin esto, cualquiera que descubra la URL puede simular mensajes de un
 * paciente. Con datos de salud de por medio, eso no es aceptable en
 * producción, así que aquí se rechaza todo lo que no venga firmado —
 * salvo que WHATSAPP_APP_SECRET esté vacío, caso en el que se avisa al
 * arrancar y se deja pasar (solo para desarrollo local).
 *
 * @param {Buffer} cuerpoCrudo el body tal como llegó, sin volver a serializar
 * @param {string} cabecera valor de la cabecera x-hub-signature-256
 */
export function firmaValida(cuerpoCrudo, cabecera) {
  if (!config.whatsapp.appSecret) return true; // validación desactivada
  if (!cuerpoCrudo || !cabecera?.startsWith('sha256=')) return false;

  const esperada = crypto
    .createHmac('sha256', config.whatsapp.appSecret)
    .update(cuerpoCrudo)
    .digest('hex');

  const recibida = cabecera.slice('sha256='.length);
  if (recibida.length !== esperada.length) return false;

  return crypto.timingSafeEqual(Buffer.from(recibida, 'utf8'), Buffer.from(esperada, 'utf8'));
}
