/**
 * Transcripción de las notas de voz con Whisper.
 *
 * Muchos pacientes mayores prefieren hablar antes que escribir, así que el
 * audio es una vía de entrada de primera clase, no un extra.
 */
import { toFile } from 'openai';
import { cliente } from './openaiCliente.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/** Extensión que le ponemos al archivo temporal según el tipo que manda Meta. */
function extensionDe(mimeType = '') {
  if (mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('amr')) return 'amr';
  return 'ogg'; // lo que manda WhatsApp normalmente
}

/**
 * Convierte un audio en texto.
 * @param {Buffer} buffer contenido del audio
 * @param {string} mimeType tipo declarado por Meta
 * @returns {Promise<string|null>} el texto, o null si no se pudo
 */
export async function transcribirAudio(buffer, mimeType) {
  if (!buffer || buffer.length === 0) return null;

  try {
    const archivo = await toFile(buffer, `nota.${extensionDe(mimeType)}`, { type: mimeType });

    const respuesta = await cliente.audio.transcriptions.create({
      file: archivo,
      model: config.openai.modeloTranscripcion,
      language: config.idioma,
      // Sesga el reconocimiento hacia el vocabulario que de verdad aparece
      // en estas conversaciones: sin esto, "metformina" sale como "meta formina".
      prompt:
        'Conversación en español sobre diabetes: glucosa, glicemia, hemoglobina glicosilada, ' +
        'metformina, insulina, glucómetro, ayunas, hipoglucemia, mg/dL, unidades.',
    });

    const texto = respuesta?.text?.trim();
    return texto || null;
  } catch (error) {
    logger.error('No se pudo transcribir el audio.', error);
    return null;
  }
}
