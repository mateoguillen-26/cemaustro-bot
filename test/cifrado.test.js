import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';

// Una base de prueba en una carpeta temporal: nunca la de data/.
const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'cemaustro-cifrado-'));
const ruta = path.join(carpeta, 'prueba.db');
const CLAVE = 'clave-de-prueba-0123456789abcdef-0123456789';
process.env.DATABASE_PATH = ruta;
process.env.DB_ENCRYPTION_KEY = CLAVE;
process.env.LOG_CONSOLE = 'false';
process.env.LOG_FILE = path.join(carpeta, 'prueba.log');

const { obtenerDB, cerrarDB, archivoSinCifrar, baseCifrada, cifrarSiHaceFalta } = await import(
  '../src/db/database.js'
);
const { ejecutarMigraciones } = await import('../src/db/migrations.js');

/** Intenta leer la base con una clave (o sin ella). Devuelve el error, si hay. */
function leerCon(clave) {
  const conexion = new Database(ruta);
  try {
    if (clave) {
      conexion.pragma(`cipher = 'sqlcipher'`);
      conexion.pragma('legacy = 4');
      conexion.pragma(`key = '${clave}'`);
    }
    return conexion.prepare('SELECT name FROM patients').pluck().all();
  } catch (error) {
    return error;
  } finally {
    conexion.close();
  }
}

test('una base sin cifrar, como la de hoy, se cifra al arrancar sin perder nada', () => {
  // Así está hoy: sin cifrar, en WAL, con datos y con escrituras aún en el WAL.
  const plana = new Database(ruta);
  plana.pragma('journal_mode = WAL');
  plana.exec(`
    CREATE TABLE patients (id INTEGER PRIMARY KEY, cedula TEXT, name TEXT, phone TEXT);
    INSERT INTO patients (cedula, name, phone) VALUES ('0102030405', 'María Elena', '593991234567');
    INSERT INTO patients (cedula, name, phone) VALUES ('0912345678', 'Luis Mora', NULL);
  `);
  plana.pragma('user_version = 3');
  plana.pragma('wal_autocheckpoint = 0'); // que lo último quede en el WAL
  plana.exec("INSERT INTO patients (cedula, name) VALUES ('0102030406', 'Solo en el WAL')");
  plana.close();
  assert.equal(archivoSinCifrar(ruta), true);

  const db = obtenerDB();

  assert.equal(archivoSinCifrar(ruta), false);
  assert.equal(baseCifrada(), true);
  assert.deepEqual(db.prepare('SELECT name FROM patients ORDER BY id').pluck().all(), [
    'María Elena',
    'Luis Mora',
    'Solo en el WAL',
  ]);
  assert.equal(db.pragma('user_version', { simple: true }), 3);
  assert.equal(fs.existsSync(`${ruta}.cifrando`), false);

  // Y el bot sigue funcionando encima: las migraciones corren sobre la cifrada.
  db.exec('DROP TABLE patients');
  db.pragma('user_version = 0');
  ejecutarMigraciones();
  db.prepare("INSERT INTO patients (cedula, name) VALUES ('0102030405', 'Ana')").run();
  cerrarDB();
});

test('en el archivo no se ve nada legible', () => {
  const bytes = fs.readFileSync(ruta);
  assert.equal(bytes.includes('0102030405'), false);
  assert.equal(bytes.includes('Ana'), false);
  assert.equal(bytes.includes('CREATE TABLE'), false);
});

test('sin clave o con otra clave no se puede leer', () => {
  assert.equal(leerCon(null).code, 'SQLITE_NOTADB');
  assert.equal(leerCon('otra-clave').code, 'SQLITE_NOTADB');
  assert.deepEqual(leerCon(CLAVE), ['Ana']);
});

test('una base ya cifrada no se vuelve a tocar', () => {
  const antes = fs.readFileSync(ruta);
  assert.equal(cifrarSiHaceFalta(ruta, CLAVE), false);
  assert.deepEqual(fs.readFileSync(ruta), antes);
});

test('si la copia no se puede cifrar, el original queda intacto', () => {
  const otra = path.join(carpeta, 'otra.db');
  const plana = new Database(otra);
  plana.exec("CREATE TABLE t (x); INSERT INTO t VALUES ('dato')");
  plana.close();
  const antes = fs.readFileSync(otra);

  // Con una clave vacía la copia queda sin cifrar: la comprobación tiene que
  // detectarlo y no tocar el original.
  assert.throws(() => cifrarSiHaceFalta(otra, ''), /el original quedó intacto/);
  assert.equal(fs.existsSync(`${otra}.cifrando`), false);
  assert.deepEqual(fs.readFileSync(otra), antes);
  assert.equal(archivoSinCifrar(otra), true);

  fs.rmSync(carpeta, { recursive: true, force: true });
});
