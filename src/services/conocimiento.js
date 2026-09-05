/**
 * Base de conocimiento del doctor (búsqueda por significado, no por palabras).
 *
 * Cada documento que sube el doctor se parte en fragmentos, y de cada
 * fragmento se guarda un vector (embedding). Cuando llega la pregunta de un
 * paciente se calcula su vector y se traen los fragmentos más parecidos, que
 * son los que se le pasan al modelo como material de apoyo.
 *
 * Los vectores se guardan YA NORMALIZADOS (longitud 1). Así la similitud del
 * coseno es un simple producto punto y buscar entre unos miles de fragmentos
 * cuesta milisegundos, sin necesidad de una base vectorial aparte.
 */
import { cliente } from './openaiCliente.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import * as db from '../db/queries.js';

/* ------------------------------------------------------------------ */
/* Partir en fragmentos                                                */
/* ------------------------------------------------------------------ */

/**
 * Parte un texto largo en pedazos manejables.
 *
 * Se corta por párrafos, no por número de caracteres, para no partir una idea
 * a la mitad. Cada fragmento arrastra el final del anterior (el solape) para
 * que una frase que quedó justo en el borde siga teniendo contexto.
 */
export function partirEnFragmentos(
  texto,
  tamano = config.conocimiento.tamanoFragmento,
  solape = config.conocimiento.solapeFragmento,
) {
  const parrafos = String(texto)
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const fragmentos = [];
  let actual = '';

  const cerrar = () => {
    if (!actual.trim()) return;
    fragmentos.push(actual.trim());
    // El siguiente arranca con la cola del que acabamos de cerrar.
    actual = solape > 0 ? `${actual.slice(-solape)}\n\n` : '';
  };

  for (const parrafo of parrafos) {
    // Un párrafo que por sí solo no cabe se parte por oraciones.
    if (parrafo.length > tamano) {
      cerrar();
      const oraciones = parrafo.match(/[^.!?]+[.!?]*\s*/g) ?? [parrafo];
      for (const oracion of oraciones) {
        if (actual.length + oracion.length > tamano) cerrar();
        actual += oracion;
      }
      continue;
    }

    if (actual.length + parrafo.length + 2 > tamano) cerrar();
    actual += `${parrafo}\n\n`;
  }

  if (actual.trim()) fragmentos.push(actual.trim());
  return fragmentos;
}

/* ------------------------------------------------------------------ */
/* Vectores                                                            */
/* ------------------------------------------------------------------ */

/** Deja el vector con longitud 1 para que el coseno sea un producto punto. */
function normalizar(vector) {
  let suma = 0;
  for (const v of vector) suma += v * v;
  const longitud = Math.sqrt(suma) || 1;
  return Float32Array.from(vector, (v) => v / longitud);
}

/** Float32Array -> BLOB para guardar en SQLite. */
function aBlob(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** BLOB de SQLite -> Float32Array. */
function aVector(blob) {
  // Se copia el buffer: el de SQLite puede no estar alineado a 4 bytes.
  const copia = Buffer.from(blob);
  return new Float32Array(copia.buffer, copia.byteOffset, copia.length / 4);
}

/**
 * Calcula los vectores de varios textos de una sola llamada.
 * @returns {Promise<Float32Array[]|null>}
 */
async function calcularVectores(textos) {
  if (textos.length === 0) return [];

  try {
    const respuesta = await cliente.embeddings.create({
      model: config.openai.modeloEmbeddings,
      input: textos,
    });

    // La API puede devolver los resultados desordenados: cada uno trae su índice.
    const ordenados = [...respuesta.data].sort((a, b) => a.index - b.index);
    return ordenados.map((d) => normalizar(d.embedding));
  } catch (error) {
    logger.error('No se pudieron calcular los vectores del texto.', error);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Caché en memoria                                                    */
/* ------------------------------------------------------------------ */

let cache = null;

/** Los fragmentos activos, ya convertidos a vectores. Se carga una sola vez. */
function fragmentos() {
  if (cache) return cache;

  cache = db.fragmentosActivos().map((fila) => ({
    id: fila.id,
    contenido: fila.content,
    titulo: fila.title,
    fuente: fila.source,
    vector: aVector(fila.embedding),
  }));

  logger.info(`Base de conocimiento cargada: ${cache.length} fragmento(s).`);
  return cache;
}

/** Obliga a releer los fragmentos en la próxima búsqueda. */
export function invalidarCache() {
  cache = null;
}

/** Cuántos fragmentos hay listos para buscar. */
export function fragmentosCargados() {
  return fragmentos().length;
}

/* ------------------------------------------------------------------ */
/* Indexar                                                             */
/* ------------------------------------------------------------------ */

/**
 * Parte un documento, calcula sus vectores y los guarda.
 * @returns {Promise<{ok: boolean, fragmentos: number, error?: string}>}
 */
export async function indexarDocumento(documentoId) {
  const documento = db.obtenerDocumento(documentoId);
  if (!documento) return { ok: false, fragmentos: 0, error: 'El documento no existe.' };

  const pedazos = partirEnFragmentos(documento.content);
  if (pedazos.length === 0) {
    return { ok: false, fragmentos: 0, error: 'El documento está vacío.' };
  }

  // Se manda por tandas: un documento largo excede el límite de una llamada.
  const TANDA = 96;
  const vectores = [];

  for (let i = 0; i < pedazos.length; i += TANDA) {
    const tanda = await calcularVectores(pedazos.slice(i, i + TANDA));
    if (!tanda) {
      return {
        ok: false,
        fragmentos: 0,
        error: 'No se pudo contactar a OpenAI para procesar el documento. Inténtelo de nuevo.',
      };
    }
    vectores.push(...tanda);
  }

  db.reemplazarFragmentos(
    documentoId,
    pedazos.map((contenido, i) => ({ contenido, embedding: aBlob(vectores[i]) })),
  );

  invalidarCache();
  logger.info(`Documento #${documentoId} indexado en ${pedazos.length} fragmento(s).`);

  return { ok: true, fragmentos: pedazos.length };
}

/* ------------------------------------------------------------------ */
/* Buscar                                                              */
/* ------------------------------------------------------------------ */

/**
 * Fragmentos más parecidos a una consulta.
 *
 * @param {string} consulta la pregunta del paciente
 * @param {number} cuantos cuántos devolver
 * @returns {Promise<Array<{contenido: string, titulo: string, similitud: number}>>}
 */
export async function buscar(consulta, cuantos = config.conocimiento.fragmentos) {
  if (!consulta?.trim() || cuantos <= 0) return [];

  const disponibles = fragmentos();
  if (disponibles.length === 0) return [];

  const [vectorConsulta] = (await calcularVectores([consulta])) ?? [];
  if (!vectorConsulta) return [];

  const puntuados = disponibles.map((fragmento) => {
    let similitud = 0;
    for (let i = 0; i < vectorConsulta.length; i += 1) {
      similitud += vectorConsulta[i] * fragmento.vector[i];
    }
    return { ...fragmento, similitud };
  });

  return puntuados
    .filter((f) => f.similitud >= config.conocimiento.similitudMinima)
    .sort((a, b) => b.similitud - a.similitud)
    .slice(0, cuantos)
    .map(({ contenido, titulo, fuente, similitud }) => ({ contenido, titulo, fuente, similitud }));
}

/**
 * Arma el bloque de texto que se le pasa al modelo con el material encontrado.
 * Si no hay nada, se le dice explícitamente: así no se inventa que lo hubo.
 */
export function comoContexto(encontrados) {
  if (encontrados.length === 0) {
    return 'MATERIAL DEL CONSULTORIO: no hay material específico para esta pregunta. Responda con criterio general y prudente, o derive.';
  }

  const bloques = encontrados
    .map((f, i) => `--- Fragmento ${i + 1} (${f.titulo}) ---\n${f.contenido}`)
    .join('\n\n');

  return `MATERIAL DEL CONSULTORIO:\n${bloques}`;
}
