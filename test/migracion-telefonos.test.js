import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Una base de prueba en una carpeta temporal: nunca la de data/.
const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'cemaustro-test-'));
process.env.DATABASE_PATH = path.join(carpeta, 'prueba.db');
process.env.LOG_CONSOLE = 'false';
process.env.LOG_FILE = path.join(carpeta, 'prueba.log');

const { obtenerDB, cerrarDB } = await import('../src/db/database.js');
const { ejecutarMigraciones } = await import('../src/db/migrations.js');

test('la migración 8 pasa los 09… del padrón al formato de WhatsApp', () => {
  const db = obtenerDB();

  // Una base como estaba antes del cambio: hasta la versión 7.
  ejecutarMigraciones(7);
  const insertar = db.prepare('INSERT INTO patients (cedula, name, phone) VALUES (?, ?, ?)');
  insertar.run('0102030405', 'Local', '0991234567');
  insertar.run('0102030406', 'Con 593 y 0', '5930981234567');
  insertar.run('0102030407', 'Ya bien', '593971234567');
  insertar.run('0102030408', 'Sin número', null);
  insertar.run('0102030409', 'Choca', '0971234567'); // su versión corregida ya es de "Ya bien"

  ejecutarMigraciones();

  const telefonoDe = (cedula) =>
    db.prepare('SELECT phone FROM patients WHERE cedula = ?').get(cedula).phone;
  assert.equal(telefonoDe('0102030405'), '593991234567');
  assert.equal(telefonoDe('0102030406'), '593981234567');
  assert.equal(telefonoDe('0102030407'), '593971234567');
  assert.equal(telefonoDe('0102030408'), null);
  assert.equal(telefonoDe('0102030409'), '0971234567');
  assert.ok(db.pragma('user_version', { simple: true }) >= 8);

  cerrarDB();
  fs.rmSync(carpeta, { recursive: true, force: true });
});
