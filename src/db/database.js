/**
 * Conexión a SQLite (better-sqlite3).
 *
 * Se usa una sola conexión compartida en toda la aplicación.
 * El diseño es simple a propósito, para facilitar una futura migración a PostgreSQL.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let db = null;

/** Devuelve la conexión (la crea la primera vez). */
export function obtenerDB() {
  if (db) return db;

  const carpeta = path.dirname(config.db.ruta);
  if (!fs.existsSync(carpeta)) {
    fs.mkdirSync(carpeta, { recursive: true });
    logger.info(`Carpeta de base de datos creada: ${carpeta}`);
  }

  db = new Database(config.db.ruta);
  db.pragma('journal_mode = WAL'); // mejor concurrencia lectura/escritura
  db.pragma('foreign_keys = ON');

  logger.info(`Base de datos conectada: ${config.db.ruta}`);
  return db;
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
