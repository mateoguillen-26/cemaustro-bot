/**
 * Registro de las glucemias que el paciente reporta por el chat.
 *
 * Dos cosas que conviene tener claras:
 *  - Es un autorreporte, no un dato de laboratorio. Sirve para que el doctor
 *    vea la tendencia entre consultas, no como registro clínico validado.
 *  - La clasificación de un valor como peligroso NO se le deja al modelo. El
 *    modelo puede equivocarse; los umbrales son aritmética y se comprueban
 *    aquí, en código, sobre el valor ya guardado.
 */
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { ahoraISO, enMinutos } from '../utils/datetime.js';
import * as db from '../db/queries.js';

/**
 * Tope de antigüedad que se le acepta a una medición reportada por chat.
 * Nadie cuenta por WhatsApp una glucemia de hace más de una semana; si el
 * modelo devuelve algo así, es más fiable la hora del propio mensaje.
 */
const MAX_MINUTOS_ATRAS = 7 * 24 * 60;

/**
 * Momento en que se tomó la medición, a partir de los minutos que devolvió
 * el modelo.
 *
 * Antes se le pedía una fecha ISO completa y se equivocaba de día: una
 * glucemia de hoy quedaba archivada ayer, y eso desplaza los picos en el
 * gráfico que mira el médico. Contar minutos hacia atrás elimina toda la
 * aritmética de calendario, que es donde fallaba.
 */
export function momentoDeLaMedicion(minutosAtras) {
  const minutos = Number(minutosAtras);
  if (!Number.isFinite(minutos) || minutos <= 0) return ahoraISO();
  return enMinutos(-Math.min(minutos, MAX_MINUTOS_ATRAS));
}

/** Cómo se lee cada contexto en los mensajes y en el panel. */
export const ETIQUETA_CONTEXTO = {
  ayunas: 'en ayunas',
  postprandial: 'después de comer',
  antes_dormir: 'antes de dormir',
  aleatoria: 'en cualquier momento',
};

/**
 * ¿El número es plausible como glucemia capilar?
 * Filtra los casos en que el modelo confundió un peso, una edad o un año.
 */
function esPlausible(valor) {
  return valor >= config.glucemia.minimoPlausible && valor <= config.glucemia.maximoPlausible;
}

/**
 * Clasifica un valor. Devuelve el nivel de atención que merece por sí solo,
 * sin mirar síntomas: eso lo aporta el modelo por separado.
 *
 * @returns {{nivel: 'ninguna'|'aviso'|'urgente', motivo: string|null}}
 */
export function clasificar(valor, contexto) {
  const u = config.glucemia;

  if (valor <= u.hipoGrave) {
    return { nivel: 'urgente', motivo: `Hipoglucemia grave: ${valor} mg/dL.` };
  }
  if (valor < u.hipo) {
    return { nivel: 'aviso', motivo: `Hipoglucemia: ${valor} mg/dL.` };
  }
  if (valor >= u.altaGrave) {
    return { nivel: 'urgente', motivo: `Hiperglucemia marcada: ${valor} mg/dL.` };
  }
  if (valor >= u.altaAviso) {
    return {
      nivel: 'aviso',
      motivo: `Glucemia alta: ${valor} mg/dL (${ETIQUETA_CONTEXTO[contexto] ?? contexto}).`,
    };
  }
  return { nivel: 'ninguna', motivo: null };
}

/**
 * Guarda las mediciones que trajo un mensaje.
 *
 * @param {object} paciente
 * @param {Array<{valor: number, contexto: string, minutosAtras: number, nota: string|null}>} lecturas
 * @returns {{guardadas: Array, descartadas: Array, nivel: string, motivos: string[]}}
 */
export function registrar(paciente, lecturas = []) {
  const guardadas = [];
  const descartadas = [];
  const motivos = [];
  let nivel = 'ninguna';

  for (const lectura of lecturas) {
    if (!esPlausible(lectura.valor)) {
      logger.warn(`Medición descartada por implausible: ${lectura.valor} mg/dL.`);
      descartadas.push(lectura.valor);
      continue;
    }

    const medidaEn = momentoDeLaMedicion(lectura.minutosAtras);

    const fila = db.guardarGlucemia(paciente.id, {
      valor: lectura.valor,
      contexto: lectura.contexto,
      medidaEn,
      nota: lectura.nota,
    });

    guardadas.push(fila);

    const juicio = clasificar(lectura.valor, lectura.contexto);
    if (juicio.nivel === 'urgente') nivel = 'urgente';
    else if (juicio.nivel === 'aviso' && nivel === 'ninguna') nivel = 'aviso';
    if (juicio.motivo) motivos.push(juicio.motivo);
  }

  if (guardadas.length > 0) {
    logger.info(`${guardadas.length} medición(es) registrada(s) del paciente #${paciente.id}.`);
  }

  return { guardadas, descartadas, nivel, motivos };
}

/**
 * Aviso que se le agrega a la respuesta cuando se descartó algún número.
 * Sin esto el paciente cree que su medición quedó anotada y no fue así.
 */
export function avisoDeDescartes(descartadas) {
  if (descartadas.length === 0) return '';
  return (
    `\n\nNo anoté ${descartadas.join(', ')} porque no parece un valor de glucosa. ` +
    '¿Me lo confirma en mg/dL?'
  );
}
