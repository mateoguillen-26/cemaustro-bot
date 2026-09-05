/**
 * Cálculo aproximado de calorías y carbohidratos a partir de la foto de un plato.
 *
 * Funciona igual que la transcripción de audio: la foto no abre un camino
 * propio hacia el paciente, sino que se convierte en TEXTO y entra por la
 * conversación de siempre. Así todo lo que sale hacia el paciente sigue
 * pasando por las reglas clínicas del asistente (services/prompts.js) y por
 * la detección de alertas, en lugar de tener un segundo modelo hablando por
 * su cuenta.
 *
 * Lo que se devuelve es una línea que empieza por "[FOTO DE COMIDA]", que es
 * la marca que el prompt del asistente sabe reconocer.
 */
import { cliente } from './openaiCliente.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { ajuste } from './ajustes.js';

/** Marca con la que el asistente reconoce que esto vino de una foto. */
export const MARCA_FOTO = '[FOTO DE COMIDA]';

/**
 * Tope de tamaño de la imagen. WhatsApp ya comprime bastante; por encima de
 * esto lo más probable es que algo vaya mal, y en base64 crece un tercio más.
 */
const MAX_BYTES = 8 * 1024 * 1024;

/** Formatos que el modelo sabe mirar. WhatsApp manda JPEG casi siempre. */
const TIPOS_ACEPTADOS = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/**
 * Esquema que obliga al modelo de visión a responder siempre igual.
 * En modo estricto todas las propiedades van en `required`; las que pueden
 * faltar se declaran anulables.
 */
const ESQUEMA_PLATO = {
  type: 'object',
  properties: {
    es_comida: {
      type: 'boolean',
      description: 'false si en la foto no hay comida o no se distingue qué hay.',
    },
    descripcion: {
      type: 'string',
      description: 'El plato en una frase corta, ej. "Almuerzo: arroz, seco de pollo y jugo".',
    },
    alimentos: {
      type: ['array', 'null'],
      description: 'Lo que se distingue en el plato, con su porción aproximada.',
      items: {
        type: 'object',
        properties: {
          nombre: { type: 'string' },
          porcion: {
            type: 'string',
            description: 'Porción a ojo, ej. "1 taza", "120 g", "2 unidades".',
          },
          carbohidratos_g: {
            type: ['integer', 'null'],
            description: 'Carbohidratos de ESTE alimento en gramos. null si no aplica.',
          },
        },
        required: ['nombre', 'porcion', 'carbohidratos_g'],
        additionalProperties: false,
      },
    },
    calorias_min: {
      type: ['integer', 'null'],
      description: 'Extremo bajo del rango de calorías del plato completo.',
    },
    calorias_max: {
      type: ['integer', 'null'],
      description: 'Extremo alto del rango de calorías del plato completo.',
    },
    carbohidratos_g: {
      type: ['integer', 'null'],
      description: 'Carbohidratos totales del plato en gramos.',
    },
    confianza: {
      type: 'string',
      enum: ['alta', 'media', 'baja'],
      description: '"baja" si la foto está oscura, cortada o el plato se ve a medias.',
    },
  },
  required: [
    'es_comida',
    'descripcion',
    'alimentos',
    'calorias_min',
    'calorias_max',
    'carbohidratos_g',
    'confianza',
  ],
  additionalProperties: false,
};

/** Redondea a la decena para no aparentar una precisión que la foto no tiene. */
function aLaDecena(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) return null;
  return Math.round(numero / 10) * 10;
}

/**
 * Convierte el análisis en la línea de texto que leerá el asistente.
 * Se escribe para el modelo, no para el paciente: es un resumen denso.
 */
function comoTexto(analisis, comentario) {
  const partes = [MARCA_FOTO];

  if (!analisis.es_comida) {
    partes.push(
      `No se distingue comida en la foto (${analisis.descripcion || 'sin detalle'}). ` +
        'Pídale otra foto del plato completo y de frente. No dé cifras.',
    );
    if (comentario) partes.push(`El paciente escribió junto a la foto: "${comentario}"`);
    return partes.join(' ');
  }

  // El modelo a veces cierra la descripción con punto y a veces no.
  partes.push(`${analisis.descripcion.replace(/\.+$/, '')}.`);

  if (analisis.alimentos?.length) {
    const detalle = analisis.alimentos
      .slice(0, 8)
      .map((a) => {
        const carbohidratos = aLaDecena(a.carbohidratos_g);
        return `${a.nombre} (${a.porcion}${carbohidratos ? `, ~${carbohidratos} g HC` : ''})`;
      })
      .join('; ');
    partes.push(`Se distingue: ${detalle}.`);
  }

  const minimo = aLaDecena(analisis.calorias_min);
  const maximo = aLaDecena(analisis.calorias_max);
  if (minimo && maximo) {
    partes.push(`Estimación: ${minimo} a ${maximo} kcal en total.`);
  } else if (minimo || maximo) {
    partes.push(`Estimación: alrededor de ${minimo || maximo} kcal en total.`);
  }

  const carbohidratos = aLaDecena(analisis.carbohidratos_g);
  if (carbohidratos) partes.push(`Carbohidratos: unos ${carbohidratos} g.`);

  if (analisis.confianza === 'baja') {
    partes.push('La foto se ve regular, así que el cálculo es especialmente grueso: dígaselo.');
  }

  if (comentario) partes.push(`El paciente escribió junto a la foto: "${comentario}"`);

  return partes.join(' ');
}

/**
 * Mira la foto de un plato y devuelve el análisis ya convertido en texto.
 *
 * @param {object} opciones
 * @param {Buffer} opciones.buffer contenido de la imagen
 * @param {string} opciones.mimeType tipo declarado por Meta
 * @param {string} [opciones.comentario] lo que el paciente escribió con la foto
 * @returns {Promise<string|null>} texto para el asistente, o null si no se pudo
 */
export async function analizarPlato({ buffer, mimeType, comentario }) {
  if (!buffer || buffer.length === 0) return null;

  if (buffer.length > MAX_BYTES) {
    logger.warn(`Foto descartada por tamaño (${(buffer.length / 1024 / 1024).toFixed(1)} MB).`);
    return null;
  }

  // Un tipo raro se manda como JPEG: WhatsApp lo etiqueta mal de vez en
  // cuando y el modelo lo abre igual.
  const tipo = TIPOS_ACEPTADOS.includes(mimeType) ? mimeType : 'image/jpeg';

  try {
    const respuesta = await cliente.chat.completions.create({
      model: config.openai.modeloVision,
      max_tokens: config.openai.maxTokens,
      temperature: 0.2, // aquí menos aún: es un cálculo, no una redacción
      messages: [
        { role: 'system', content: ajuste('ia.promptComida') },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: comentario
                ? `Analice este plato. El paciente escribió: "${comentario}"`
                : 'Analice este plato.',
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${tipo};base64,${buffer.toString('base64')}`,
                detail: 'low', // basta para reconocer el plato y cuesta bastante menos
              },
            },
          ],
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'analisis_plato', strict: true, schema: ESQUEMA_PLATO },
      },
    });

    const contenido = respuesta.choices?.[0]?.message?.content;
    if (!contenido) {
      logger.error('El modelo de visión devolvió una respuesta vacía.');
      return null;
    }

    const analisis = JSON.parse(contenido);

    logger.info(
      analisis.es_comida
        ? `Foto de comida analizada: ${analisis.calorias_min}-${analisis.calorias_max} kcal, ` +
            `${analisis.carbohidratos_g} g de carbohidratos (confianza ${analisis.confianza}).`
        : 'Foto recibida: el modelo no reconoció comida en ella.',
    );

    return comoTexto(analisis, comentario);
  } catch (error) {
    logger.error('No se pudo analizar la foto del plato.', error);
    return null;
  }
}
