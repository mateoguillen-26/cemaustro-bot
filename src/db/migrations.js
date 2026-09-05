/**
 * Migraciones basadas en la versión del esquema (PRAGMA user_version).
 *
 * Para cambiar el esquema: añada una nueva entrada al arreglo MIGRACIONES.
 * Nunca modifique una migración ya publicada — agregue una nueva.
 */
import { pathToFileURL } from 'node:url';
import { obtenerDB } from './database.js';
import { logger } from '../utils/logger.js';

const MIGRACIONES = [
  {
    version: 1,
    nombre: 'padrón de pacientes, sesiones y verificación',
    sql: `
      -- El padrón que carga el doctor. Un teléfono solo recibe respuestas
      -- médicas si su dueño está aquí y está verificado.
      CREATE TABLE IF NOT EXISTS patients (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cedula TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          phone TEXT UNIQUE,                  -- NULL hasta que se vincule
          diabetes_type TEXT,                 -- '1' | '2' | 'gestacional' | 'prediabetes' | NULL
          notes TEXT,
          timezone TEXT DEFAULT 'America/Guayaquil',
          active INTEGER NOT NULL DEFAULT 1,  -- 0 = inactivo, el bot no le responde
          last_user_message_at DATETIME,      -- para la ventana de 24 h de WhatsApp
          created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE INDEX IF NOT EXISTS idx_patients_activos ON patients (active, name);

      -- Sesión verificada de un número. Una fila por teléfono.
      CREATE TABLE IF NOT EXISTS sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patient_id INTEGER NOT NULL,
          phone TEXT UNIQUE NOT NULL,
          verified_at DATETIME NOT NULL,
          expires_at DATETIME NOT NULL,
          last_seen_at DATETIME,
          revoked_at DATETIME,
          FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_paciente ON sessions (patient_id);

      -- Códigos de vinculación que el doctor genera en el panel y entrega en
      -- consulta. Se guarda solo el resumen (hash), nunca el código en claro.
      CREATE TABLE IF NOT EXISTS link_codes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patient_id INTEGER NOT NULL,
          code_hash TEXT NOT NULL,
          expires_at DATETIME NOT NULL,
          used_at DATETIME,
          used_by_phone TEXT,
          created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_link_codes_vigentes
          ON link_codes (used_at, expires_at);

      -- Bitácora de intentos de verificación. Es la base del bloqueo por
      -- fuerza bruta y de la auditoría. La cédula va enmascarada.
      CREATE TABLE IF NOT EXISTS auth_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          phone TEXT NOT NULL,
          cedula_masked TEXT,
          outcome TEXT NOT NULL,     -- 'ok' | 'fallo'
          reason TEXT,               -- por qué falló, para que el doctor lo entienda
          created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE INDEX IF NOT EXISTS idx_attempts_telefono
          ON auth_attempts (phone, created_at DESC);
    `,
  },
  {
    version: 2,
    nombre: 'conversaciones e idempotencia de webhooks',
    sql: `
      -- Historial de la conversación. Solo se guarda lo de pacientes ya
      -- verificados: los mensajes de un número desconocido no se archivan.
      CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patient_id INTEGER NOT NULL,
          wa_message_id TEXT UNIQUE,
          role TEXT NOT NULL,              -- 'user' | 'assistant'
          content TEXT NOT NULL,
          created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_paciente
          ON messages (patient_id, id DESC);

      -- Meta puede reenviar el mismo webhook varias veces: aquí se registran
      -- los message_id ya procesados para no responder dos veces.
      CREATE TABLE IF NOT EXISTS processed_messages (
          wa_message_id TEXT PRIMARY KEY,
          processed_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `,
  },
  {
    version: 3,
    nombre: 'registro de glucemias y alertas al doctor',
    sql: `
      -- Valores que el propio paciente reporta por el chat. NO son un
      -- registro clínico validado: son lo que el paciente dijo, con la hora
      -- en que lo dijo.
      CREATE TABLE IF NOT EXISTS glucose_readings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patient_id INTEGER NOT NULL,
          value_mgdl INTEGER NOT NULL,
          context TEXT,                    -- 'ayunas' | 'postprandial' | 'antes_dormir' | 'aleatoria'
          measured_at DATETIME NOT NULL,   -- UTC
          note TEXT,
          created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_glucosa_paciente
          ON glucose_readings (patient_id, measured_at DESC);

      -- Todo lo que el bot decidió que el doctor debe mirar.
      CREATE TABLE IF NOT EXISTS alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patient_id INTEGER NOT NULL,
          level TEXT NOT NULL,             -- 'aviso' | 'urgente'
          reason TEXT NOT NULL,
          excerpt TEXT,                    -- fragmento del mensaje que la disparó
          source TEXT NOT NULL,            -- 'glucemia' | 'sintomas' | 'peticion'
          notified_at DATETIME,            -- cuándo se le avisó al doctor
          notify_via TEXT,                 -- 'libre' | 'plantilla' | NULL
          resolved_at DATETIME,
          created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_alertas_pendientes
          ON alerts (resolved_at, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_alertas_paciente
          ON alerts (patient_id, created_at DESC);
    `,
  },
  {
    version: 4,
    nombre: 'base de conocimiento del doctor',
    sql: `
      -- Documentos que sube el doctor (guías, protocolos, respuestas frecuentes).
      CREATE TABLE IF NOT EXISTS documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          source TEXT,                     -- de dónde salió: archivo, guía, autor
          content TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      -- Cada documento se parte en fragmentos y cada fragmento lleva su
      -- vector (embedding) guardado como BLOB de Float32.
      CREATE TABLE IF NOT EXISTS chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          document_id INTEGER NOT NULL,
          ordinal INTEGER NOT NULL,
          content TEXT NOT NULL,
          embedding BLOB NOT NULL,
          created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_documento ON chunks (document_id, ordinal);
    `,
  },
  {
    version: 5,
    nombre: 'ajustes editables desde el panel',
    sql: `
      -- Ajustes que el doctor puede cambiar sin reiniciar el servidor
      -- (el prompt clínico, los textos fijos, el umbral de alertas...).
      -- Lo que esté aquí manda sobre el archivo .env.
      CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `,
  },
];

/** Aplica las migraciones que falten. Devuelve la versión final del esquema. */
export function ejecutarMigraciones() {
  const db = obtenerDB();
  const actual = db.pragma('user_version', { simple: true });

  const pendientes = MIGRACIONES.filter((m) => m.version > actual);
  if (pendientes.length === 0) {
    logger.info(`Base de datos al día (versión ${actual}).`);
    return actual;
  }

  for (const migracion of pendientes) {
    const aplicar = db.transaction(() => {
      db.exec(migracion.sql);
      db.pragma(`user_version = ${migracion.version}`);
    });

    try {
      aplicar();
      logger.info(`Migración ${migracion.version} aplicada: ${migracion.nombre}.`);
    } catch (error) {
      logger.error(`Falló la migración ${migracion.version} (${migracion.nombre}).`, error);
      throw error;
    }
  }

  return db.pragma('user_version', { simple: true });
}

// Permite ejecutarlas a mano con: npm run migrate
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = ejecutarMigraciones();
  console.log(`Esquema en la versión ${version}.`);
  process.exit(0);
}
