/**
 * Integración con OpenAI para responderle al paciente.
 *
 * Recibe el mensaje (escrito o dictado), el historial reciente, el perfil del
 * paciente y el material del consultorio que encontró la búsqueda; devuelve
 * una decisión estructurada:
 *   { response_text, action, glucose_readings, alert_level, alert_reason }
 *
 * Se usa "structured outputs" (json_schema estricto) para que la respuesta
 * tenga siempre la misma forma y no haya que adivinar el formato.
 */
import { cliente } from './openaiCliente.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { fechaActualParaPrompt, zonaDe } from '../utils/datetime.js';
import { ajuste, reemplazarMarcas } from './ajustes.js';
import { MARCAS_PROMPT } from './prompts.js';
import { buscar, comoContexto } from './conocimiento.js';

/** Qué decidió hacer el modelo con el mensaje. */
export const ACCIONES = {
  RESPONDER: 'responder',
  REGISTRAR: 'registrar_glucemia',
  DERIVAR: 'derivar',
  EMERGENCIA: 'emergencia',
  FUERA_DE_TEMA: 'fuera_de_tema',
};

/** Nivel de atención que pide el caso. */
export const ALERTAS = {
  NINGUNA: 'ninguna',
  AVISO: 'aviso',
  URGENTE: 'urgente',
};

/** Contextos válidos de una medición de glucosa. */
export const CONTEXTOS = ['ayunas', 'postprandial', 'antes_dormir', 'aleatoria'];

/** Tope de mediciones que se aceptan en un solo mensaje (red de seguridad). */
export const MAX_LECTURAS_POR_MENSAJE = 8;

/**
 * Esquema que obliga al modelo a responder siempre igual.
 * En modo estricto de OpenAI TODAS las propiedades van en `required`, y las
 * opcionales se declaran como anulables (`["string", "null"]`).
 */
const ESQUEMA_RESPUESTA = {
  type: 'object',
  properties: {
    response_text: {
      type: 'string',
      description: 'Mensaje en español para enviarle al paciente por WhatsApp.',
    },
    action: {
      type: 'string',
      enum: Object.values(ACCIONES),
    },
    glucose_readings: {
      type: ['array', 'null'],
      description:
        'Mediciones de glucosa que el paciente reportó en este mensaje. null si no reportó ninguna.',
      items: {
        type: 'object',
        properties: {
          value_mgdl: {
            type: 'integer',
            description: 'Valor en mg/dL. Si el paciente lo dio en mmol/L, conviértalo (×18).',
          },
          context: {
            type: 'string',
            enum: CONTEXTOS,
            description: '"aleatoria" si el paciente no precisó cuándo se la tomó.',
          },
          minutes_ago: {
            type: ['integer', 'null'],
            description:
              'Hace cuántos MINUTOS se tomó la medición, contando desde ahora. ' +
              '0 o null si el paciente no dijo cuándo. Ejemplos: "hace un rato" ≈ 30, ' +
              '"esta mañana" = los minutos transcurridos desde esa hora, "anoche" ≈ 600. ' +
              'Nunca devuelva una fecha: solo el número de minutos.',
          },
          note: {
            type: ['string', 'null'],
            description: 'Detalle que dijo el paciente, ej. "después del almuerzo". Corto.',
          },
        },
        required: ['value_mgdl', 'context', 'minutes_ago', 'note'],
        additionalProperties: false,
      },
    },
    alert_level: {
      type: 'string',
      enum: Object.values(ALERTAS),
    },
    alert_reason: {
      type: ['string', 'null'],
      description: 'Frase corta y clínica para el doctor. null si alert_level es "ninguna".',
    },
  },
  required: ['response_text', 'action', 'glucose_readings', 'alert_level', 'alert_reason'],
  additionalProperties: false,
};

/** Arma el prompt de sistema con los datos reales de este paciente. */
async function construirPromptSistema(paciente, mensaje, resumen) {
  const encontrados = await buscar(mensaje, ajuste('ia.fragmentos'));

  const perfil = [];
  if (paciente.diabetes_type) perfil.push(`Tipo de diabetes: ${paciente.diabetes_type}.`);
  if (paciente.notes) perfil.push(`Notas del médico sobre este paciente: ${paciente.notes}`);

  const glucemias =
    resumen?.total > 0
      ? `Últimas 2 semanas de glucemias que el propio paciente reportó: ${resumen.total} mediciones, ` +
        `promedio ${resumen.promedio} mg/dL (mínima ${resumen.minimo}, máxima ${resumen.maximo}). ` +
        'Son valores autorreportados, no de laboratorio.'
      : 'El paciente todavía no ha reportado mediciones por este chat.';

  // El límite se le dice al modelo en caracteres y también en líneas: pedirlo
  // de las dos formas funciona bastante mejor que solo con el número.
  const limite = ajuste('ia.maxCaracteres');
  const lineas = Math.max(2, Math.round(limite / 110));
  const instruccionLargo =
    `No pases de ${limite} caracteres, que son unas ${lineas} líneas de WhatsApp. ` +
    'Si no cabe todo, deja fuera lo accesorio, nunca lo importante.';

  const plantilla = ajuste('ia.promptSistema');

  const prompt = reemplazarMarcas(plantilla, {
    [MARCAS_PROMPT.FECHA]: fechaActualParaPrompt(zonaDe(paciente)),
    [MARCAS_PROMPT.CLINICA]: config.clinica.nombre,
    [MARCAS_PROMPT.DOCTOR]: config.clinica.doctor,
    [MARCAS_PROMPT.NOMBRE]: paciente.name ? `- El paciente se llama ${paciente.name}.` : '',
    [MARCAS_PROMPT.PERFIL]: perfil.length ? `- ${perfil.join(' ')}` : '',
    [MARCAS_PROMPT.GLUCEMIAS]: `- ${glucemias}`,
    [MARCAS_PROMPT.LIMITE]: instruccionLargo,
    [MARCAS_PROMPT.DOCUMENTOS]: comoContexto(encontrados),
  });

  return { prompt, encontrados };
}

/** Deja la decisión del modelo en un estado en el que se puede confiar. */
function sanear(decision) {
  const accion = Object.values(ACCIONES).includes(decision.action)
    ? decision.action
    : ACCIONES.RESPONDER;

  let nivel = Object.values(ALERTAS).includes(decision.alert_level)
    ? decision.alert_level
    : ALERTAS.NINGUNA;

  // Una emergencia sin alerta sería una emergencia que el doctor nunca ve.
  if (accion === ACCIONES.EMERGENCIA) nivel = ALERTAS.URGENTE;

  const lecturas = Array.isArray(decision.glucose_readings)
    ? decision.glucose_readings
        .filter((l) => Number.isFinite(Number(l?.value_mgdl)))
        .slice(0, MAX_LECTURAS_POR_MENSAJE)
        .map((l) => {
          // El modelo solo dice "hace cuántos minutos"; la fecha la calcula
          // el código. Un valor negativo o disparatado se trata como "ahora".
          const minutos = Number(l.minutes_ago);
          return {
            valor: Math.round(Number(l.value_mgdl)),
            contexto: CONTEXTOS.includes(l.context) ? l.context : 'aleatoria',
            minutosAtras: Number.isFinite(minutos) && minutos > 0 ? Math.round(minutos) : 0,
            nota: l.note ? String(l.note).slice(0, 200) : null,
          };
        })
    : [];

  return {
    texto: String(decision.response_text ?? '').trim(),
    accion,
    lecturas,
    nivelAlerta: nivel,
    motivoAlerta: decision.alert_reason ? String(decision.alert_reason).slice(0, 300) : null,
  };
}

/**
 * Le pide al modelo qué responder.
 *
 * @param {object} opciones
 * @param {object} opciones.paciente
 * @param {string} opciones.mensaje texto del paciente (ya transcrito si era audio)
 * @param {Array<{role: string, content: string}>} opciones.historial
 * @param {object|null} opciones.resumenGlucemias
 * @returns {Promise<object|null>} decisión saneada, o null si falló la llamada
 */
export async function interpretarMensaje({ paciente, mensaje, historial = [], resumenGlucemias }) {
  try {
    const { prompt, encontrados } = await construirPromptSistema(
      paciente,
      mensaje,
      resumenGlucemias,
    );

    const respuesta = await cliente.chat.completions.create({
      model: config.openai.modelo,
      max_tokens: config.openai.maxTokens,
      temperature: 0.3, // bajo a propósito: aquí no queremos creatividad
      messages: [
        { role: 'system', content: prompt },
        ...historial.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: mensaje },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'respuesta_asistente',
          strict: true,
          schema: ESQUEMA_RESPUESTA,
        },
      },
    });

    const contenido = respuesta.choices?.[0]?.message?.content;
    if (!contenido) {
      logger.error('El modelo devolvió una respuesta vacía.');
      return null;
    }

    const decision = sanear(JSON.parse(contenido));

    if (!decision.texto) {
      logger.error('El modelo no devolvió texto para el paciente.');
      return null;
    }

    logger.info(
      `Decisión del modelo: ${decision.accion} (alerta: ${decision.nivelAlerta}, ` +
        `${encontrados.length} fragmento(s) de apoyo).`,
    );

    return decision;
  } catch (error) {
    logger.error('Falló la llamada al modelo.', error);
    return null;
  }
}
