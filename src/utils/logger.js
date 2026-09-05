/**
 * Logger simple con marca de tiempo en la zona horaria configurada.
 *
 * Regla que no se rompe: aquí nunca entra información de salud identificable.
 * No se registran cédulas, ni el contenido de los mensajes del paciente, ni
 * los tokens. Los teléfonos van siempre ofuscados.
 */
import fs from 'node:fs';
import path from 'node:path';
import { formatInTimeZone } from 'date-fns-tz';
import { config } from '../config.js';

function marcaDeTiempo() {
  return formatInTimeZone(new Date(), config.zonaHoraria, 'yyyy-MM-dd HH:mm:ss');
}

/* ------------------------------------------------------------------ */
/* Archivo de registro                                                 */
/* ------------------------------------------------------------------ */

/**
 * El archivo se abre una sola vez y se escribe con writeSync sobre el mismo
 * descriptor: es rápido y deja cada línea en disco al momento, así que un
 * corte inesperado no se lleva por delante lo último que pasó.
 */
let descriptor = null;
let bytesEnArchivo = 0;

function abrirArchivo() {
  const carpeta = path.dirname(config.logs.archivo);
  if (!fs.existsSync(carpeta)) fs.mkdirSync(carpeta, { recursive: true });
  descriptor = fs.openSync(config.logs.archivo, 'a');
  bytesEnArchivo = fs.fstatSync(descriptor).size;
}

/**
 * Al pasarse del tamaño máximo el archivo se guarda como ".1" y se empieza
 * uno nuevo. Solo se conserva una copia anterior: esto es un registro de
 * operación, no un archivo histórico.
 */
function rotarSiHaceFalta() {
  if (bytesEnArchivo < config.logs.maxMegas * 1024 * 1024) return;
  fs.closeSync(descriptor);
  descriptor = null;
  fs.rmSync(`${config.logs.archivo}.1`, { force: true });
  fs.renameSync(config.logs.archivo, `${config.logs.archivo}.1`);
  abrirArchivo();
}

function escribirEnArchivo(linea) {
  try {
    if (descriptor === null) abrirArchivo();
    rotarSiHaceFalta();
    bytesEnArchivo += fs.writeSync(descriptor, `${linea}\n`);
  } catch {
    // Si el archivo no se deja escribir, perder el registro es mejor que
    // tumbar el proceso por ello. La consola, si está activa, sigue.
  }
}

/** Convierte el dato extra en texto para el archivo. */
function textoExtra(extra) {
  if (extra === undefined) return '';
  if (extra instanceof Error) return ` ${extra.stack ?? extra.message}`;
  if (extra !== null && typeof extra === 'object') {
    try {
      return ` ${JSON.stringify(extra)}`;
    } catch {
      return ` ${String(extra)}`;
    }
  }
  return ` ${String(extra)}`;
}

/**
 * Últimos avisos y errores, para poder verlos en /admin/estado sin entrar al
 * servidor. Solo viven en memoria (se pierden al reiniciar).
 */
const MAXIMO_INCIDENCIAS = 60;
const incidencias = [];

function recordarIncidencia(nivel, mensaje, extra) {
  const detalle =
    extra instanceof Error
      ? extra.message
      : extra && typeof extra === 'object'
        ? String(extra.mensaje ?? '')
        : extra === undefined
          ? ''
          : String(extra);

  incidencias.push({
    cuando: new Date().toISOString(),
    nivel,
    mensaje: String(mensaje),
    detalle: detalle.slice(0, 300),
  });

  if (incidencias.length > MAXIMO_INCIDENCIAS) incidencias.shift();
}

function escribir(nivel, mensaje, extra) {
  const linea = `[${marcaDeTiempo()}] [${nivel}] ${mensaje}`;
  if (nivel === 'WARN' || nivel === 'ERROR') recordarIncidencia(nivel, mensaje, extra);

  escribirEnArchivo(linea + textoExtra(extra));

  if (!config.logs.consola) return;
  if (extra !== undefined) {
    console.log(linea, extra);
  } else {
    console.log(linea);
  }
}

/** Avisos y errores recientes, del más nuevo al más viejo. */
export function incidenciasRecientes(limite = 25) {
  return incidencias.slice(-limite).reverse();
}

export const logger = {
  info: (mensaje, extra) => escribir('INFO', mensaje, extra),
  warn: (mensaje, extra) => escribir('WARN', mensaje, extra),
  error: (mensaje, error) => {
    const detalle =
      error instanceof Error ? { mensaje: error.message, stack: error.stack } : error;
    escribir('ERROR', mensaje, detalle);
  },
  debug: (mensaje, extra) => {
    if (config.entorno !== 'production') escribir('DEBUG', mensaje, extra);
  },
};

/**
 * Oculta la mayor parte de un número de teléfono para los registros.
 * "593987654321" -> "593*****4321"
 */
export function ofuscarTelefono(telefono) {
  if (!telefono || telefono.length < 7) return '***';
  return `${telefono.slice(0, 3)}*****${telefono.slice(-4)}`;
}

/**
 * Oculta una cédula. "0102030405" -> "01****0405"
 * Se usa solo cuando hace falta rastrear un intento fallido de verificación.
 */
export function ofuscarCedula(cedula) {
  if (!cedula || cedula.length < 6) return '***';
  return `${cedula.slice(0, 2)}****${cedula.slice(-4)}`;
}
