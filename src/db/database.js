/**
 * Conexión a SQLite (better-sqlite3-multiple-ciphers).
 *
 * Se usa una sola conexión compartida en toda la aplicación.
 * El diseño es simple a propósito, para facilitar una futura migración a PostgreSQL.
 *
 * El archivo va CIFRADO cuando hay clave (DB_ENCRYPTION_KEY): quien se lleve
 * una copia del archivo o de un respaldo no puede leer cédulas, conversaciones
 * ni glucemias. Se usa el formato de SQLCipher 4, el mismo que abre DB Browser
 * for SQLite, para poder mirar la base a mano si algún día hace falta.
 *
 * Una base que todavía no está cifrada se cifra sola la primera vez que se
 * arranca con clave (ver cifrarSiHaceFalta). Lo que NO hay es vuelta atrás sin
 * la clave: si se pierde, los datos se pierden con ella.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let db = null;

/** Así empieza todo archivo SQLite sin cifrar. Uno cifrado empieza con bytes al azar. */
const CABECERA_SIN_CIFRAR = Buffer.from('SQLite format 3\0', 'latin1');

/** Pone la clave en una conexión recién abierta, en formato SQLCipher 4. */
function aplicarClave(conexion, clave, pragma = 'key') {
  conexion.pragma(`cipher = 'sqlcipher'`);
  conexion.pragma('legacy = 4');
  conexion.pragma(`${pragma} = '${clave.replace(/'/g, "''")}'`);
}

/**
 * true si el archivo existe y NO está cifrado. Un archivo que no existe o está
 * vacío no cuenta: se creará ya cifrado.
 */
export function archivoSinCifrar(ruta) {
  if (!fs.existsSync(ruta) || fs.statSync(ruta).size === 0) return false;
  const cabecera = Buffer.alloc(CABECERA_SIN_CIFRAR.length);
  const fd = fs.openSync(ruta, 'r');
  try {
    fs.readSync(fd, cabecera, 0, cabecera.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  return cabecera.equals(CABECERA_SIN_CIFRAR);
}

/** Cuántas filas tiene cada tabla, para comparar antes y después de cifrar. */
function conteoDeFilas(conexion) {
  const tablas = conexion
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .pluck()
    .all();
  return Object.fromEntries(
    tablas.map((t) => [t, conexion.prepare(`SELECT COUNT(*) FROM "${t.replace(/"/g, '""')}"`).pluck().get()]),
  );
}

/** Borra un archivo si existe. */
function borrarSiExiste(ruta) {
  if (fs.existsSync(ruta)) fs.rmSync(ruta);
}

/**
 * Cifra una base que está sin cifrar. Se hace sobre una COPIA:
 *
 *   1. Se copia la base (VACUUM INTO) a un archivo aparte.
 *   2. Se cifra la copia.
 *   3. Se comprueba que la copia abre con la clave, pasa la revisión de
 *      integridad y tiene las mismas filas en cada tabla que el original.
 *   4. Solo entonces la copia cifrada reemplaza al original.
 *
 * Si cualquier paso falla, el original queda como estaba y se lanza el error:
 * es preferible que el bot no arranque a que arranque con datos a medias.
 */
export function cifrarSiHaceFalta(ruta, clave) {
  if (!archivoSinCifrar(ruta)) return false;

  const temporal = `${ruta}.cifrando`;
  borrarSiExiste(temporal);
  logger.info('La base de datos está sin cifrar: se va a cifrar ahora.');

  try {
    // 1. Copia limpia del original, con lo que hubiera pendiente en el WAL.
    const original = new Database(ruta, { fileMustExist: true });
    let filasAntes;
    let versionAntes;
    try {
      original.pragma('wal_checkpoint(TRUNCATE)');
      filasAntes = conteoDeFilas(original);
      versionAntes = original.pragma('user_version', { simple: true });
      original.prepare('VACUUM INTO ?').run(temporal);
    } finally {
      original.close();
    }

    // 2. Cifrar la copia. rekey no funciona en modo WAL.
    const copia = new Database(temporal, { fileMustExist: true });
    try {
      copia.pragma('journal_mode = DELETE');
      aplicarClave(copia, clave, 'rekey');
    } finally {
      copia.close();
    }

    // 3. Comprobar la copia abriéndola como se abrirá de aquí en adelante.
    if (archivoSinCifrar(temporal)) throw new Error('la copia quedó sin cifrar');
    const cifrada = new Database(temporal, { fileMustExist: true });
    try {
      aplicarClave(cifrada, clave);
      const integridad = cifrada.pragma('integrity_check', { simple: true });
      if (integridad !== 'ok') throw new Error(`la copia no pasa la revisión de integridad (${integridad})`);
      if (cifrada.pragma('user_version', { simple: true }) !== versionAntes) {
        throw new Error('la copia no tiene la misma versión de esquema');
      }
      const filasDespues = conteoDeFilas(cifrada);
      if (JSON.stringify(filasDespues) !== JSON.stringify(filasAntes)) {
        throw new Error('la copia no tiene las mismas filas que el original');
      }
    } finally {
      cifrada.close();
    }

    // 4. Reemplazar. El WAL del original ya se vació en el paso 1.
    borrarSiExiste(`${ruta}-wal`);
    borrarSiExiste(`${ruta}-shm`);
    fs.renameSync(temporal, ruta);

    const total = Object.values(filasAntes).reduce((a, b) => a + b, 0);
    logger.info(`Base de datos cifrada: ${Object.keys(filasAntes).length} tablas, ${total} filas comprobadas.`);
    return true;
  } catch (error) {
    borrarSiExiste(temporal);
    throw new Error(`No se pudo cifrar la base de datos; el original quedó intacto: ${error.message}`, {
      cause: error,
    });
  }
}

/** Devuelve la conexión (la crea la primera vez). */
export function obtenerDB() {
  if (db) return db;

  const { ruta, clave, exigirCifrado } = config.db;

  const carpeta = path.dirname(ruta);
  if (!fs.existsSync(carpeta)) {
    fs.mkdirSync(carpeta, { recursive: true });
    logger.info(`Carpeta de base de datos creada: ${carpeta}`);
  }

  if (!clave && exigirCifrado) {
    throw new Error(
      'Falta DB_ENCRYPTION_KEY. En producción la base de datos no se abre sin cifrar: ' +
        'guarda cédulas y datos de salud.',
    );
  }

  if (clave) cifrarSiHaceFalta(ruta, clave);

  const conexion = new Database(ruta);
  try {
    if (clave) aplicarClave(conexion, clave);
    // La clave no se comprueba hasta la primera lectura: se lee ya, para que
    // una clave equivocada se diga con claridad y no como un error cualquiera.
    conexion.prepare('SELECT COUNT(*) FROM sqlite_master').get();
  } catch (error) {
    conexion.close();
    if (error.code === 'SQLITE_NOTADB') {
      throw new Error(
        clave
          ? 'La clave DB_ENCRYPTION_KEY no abre la base de datos: no es la misma con la que se cifró.'
          : 'La base de datos está cifrada y falta DB_ENCRYPTION_KEY para abrirla.',
        { cause: error },
      );
    }
    throw error;
  }

  conexion.pragma('journal_mode = WAL'); // mejor concurrencia lectura/escritura
  conexion.pragma('foreign_keys = ON');
  db = conexion;

  logger.info(`Base de datos conectada${clave ? ' (cifrada)' : ' (SIN cifrar)'}: ${ruta}`);
  return db;
}

/** true si la base abierta está cifrada. Para el panel de Seguridad. */
export function baseCifrada() {
  return Boolean(config.db.clave) && !archivoSinCifrar(config.db.ruta);
}

/** Cierra la conexión (usado en el apagado ordenado). */
export function cerrarDB() {
  if (!db) return;
  try {
    db.close();
    logger.info('Base de datos cerrada correctamente.');
  } catch (error) {
    logger.error('No se pudo cerrar la base de datos.', error);
  } finally {
    db = null;
  }
}
