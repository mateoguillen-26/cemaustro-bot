/**
 * Recorre el consentimiento por el webhook de verdad: los mensajes entran
 * firmados como los manda Meta, y lo que el bot envía lo recibe un WhatsApp
 * de mentira levantado aquí mismo. Nada sale a internet.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'cemaustro-consentimiento-'));
const SECRETO = 'secreto-de-prueba';
const PUERTO_BOT = 3217;
const PUERTO_WHATSAPP = 3218;

Object.assign(process.env, {
  DATABASE_PATH: path.join(carpeta, 'prueba.db'),
  DB_ENCRYPTION_KEY: 'clave-de-prueba-0123456789abcdef-0123456789',
  LOG_CONSOLE: 'false',
  LOG_FILE: path.join(carpeta, 'prueba.log'),
  PORT: String(PUERTO_BOT),
  WHATSAPP_APP_SECRET: SECRETO,
  WHATSAPP_TOKEN: 'token-de-prueba',
  WHATSAPP_PHONE_NUMBER_ID: '123',
  WHATSAPP_BASE_URL: `http://127.0.0.1:${PUERTO_WHATSAPP}`,
  CLINICA_TELEFONO: '+593 99 000 0000',
});

/* --- WhatsApp de mentira: guarda cada envío --- */
const enviados = [];
const whatsappFalso = http.createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (d) => (cuerpo += d));
  req.on('end', () => {
    const json = JSON.parse(cuerpo || '{}');
    if (json.type) enviados.push(json); // los "leído" no traen type
    res.setHeader('content-type', 'application/json');
    res.end('{"messages":[{"id":"wamid.salida"}]}');
  });
});

let db;
let queries;
let servidor;

before(async () => {
  await new Promise((r) => whatsappFalso.listen(PUERTO_WHATSAPP, '127.0.0.1', r));
  ({ servidor } = await import('../src/index.js'));
  await new Promise((r) => setTimeout(r, 300));
  db = (await import('../src/db/database.js')).obtenerDB();
  queries = await import('../src/db/queries.js');
});

after(async () => {
  whatsappFalso.close();
  servidor?.close();
  (await import('../src/db/database.js')).cerrarDB();
  fs.rmSync(carpeta, { recursive: true, force: true });
});

/* --- Ayudas --- */
let contador = 0;

/** Manda un mensaje al webhook como lo haría Meta y espera lo que responda el bot. */
async function llega(telefono, contenido) {
  const antes = enviados.length;
  const mensaje = { from: telefono, id: `wamid.prueba.${++contador}`, timestamp: '0', ...contenido };
  const cuerpo = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages: [mensaje] } }] }],
  });
  const firma = crypto.createHmac('sha256', SECRETO).update(cuerpo).digest('hex');
  const r = await fetch(`http://127.0.0.1:${PUERTO_BOT}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${firma}` },
    body: cuerpo,
  });
  assert.equal(r.status, 200);

  for (let i = 0; i < 100 && enviados.length === antes; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return enviados.slice(antes);
}

const texto = (body) => ({ type: 'text', text: { body } });
const boton = (id, title) => ({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } });
const cuenta = (tabla, donde = '1=1', ...p) =>
  db.prepare(`SELECT COUNT(*) FROM ${tabla} WHERE ${donde}`).pluck().get(...p);

/* --- Casos --- */
const NUEVO = '593990000001';

test('un número nuevo recibe primero el aviso con los botones, y nada más', async () => {
  const [salida] = await llega(NUEVO, texto('Hola'));
  assert.equal(salida.type, 'interactive');
  assert.match(salida.interactive.body.text, /Antes de empezar: sus datos/);
  assert.ok(salida.interactive.body.text.length <= 1024);
  const botones = salida.interactive.action.buttons.map((b) => b.reply);
  assert.deepEqual(botones.map((b) => b.title), ['Acepto', 'No acepto']);
  assert.equal(botones[0].id, 'consentimiento:acepto:v1');
});

test('si escribe su cédula sin aceptar, no se procesa ni se guarda: se repite el aviso', async () => {
  const [salida] = await llega(NUEVO, texto('0102030400'));
  assert.equal(salida.type, 'interactive');
  assert.equal(cuenta('auth_attempts'), 0);
  assert.equal(cuenta('consents'), 0);
});

test('"No acepto" recibe la explicación y no deja nada guardado', async () => {
  const [salida] = await llega(NUEVO, boton('consentimiento:no', 'No acepto'));
  assert.equal(salida.type, 'text');
  assert.match(salida.text.body, /no he guardado ningún dato suyo/);
  assert.match(salida.text.body, /\+593 99 000 0000/);
  assert.equal(cuenta('consents'), 0);
});

test('un botón con una versión que no existe no cuenta como aceptación', async () => {
  const [salida] = await llega(NUEVO, boton('consentimiento:acepto:v999', 'Acepto'));
  assert.equal(salida.type, 'interactive');
  assert.equal(cuenta('consents'), 0);
});

test('"Acepto" guarda la aceptación con su versión y pasa a pedir la cédula', async () => {
  const [salida] = await llega(NUEVO, boton('consentimiento:acepto:v1', 'Acepto'));
  assert.equal(salida.type, 'text');
  assert.match(salida.text.body, /cédula/);
  const fila = db.prepare('SELECT * FROM consents WHERE phone = ?').get(NUEVO);
  assert.equal(fila.text_version, 1);
  assert.equal(fila.patient_id, null);
  assert.equal(fila.wa_message_id, `wamid.prueba.${contador}`);
  assert.match(
    db.prepare('SELECT text FROM consent_texts WHERE version = 1').pluck().get(),
    /Antes de empezar: sus datos/,
  );
});

test('ya aceptado, sigue la verificación de siempre y la aceptación pasa a su ficha', async () => {
  const paciente = queries.crearPaciente({ cedula: '0102030400', name: 'Paciente Nueva', phone: NUEVO });
  const [salida] = await llega(NUEVO, texto('0102030400'));
  assert.equal(salida.type, 'text');
  assert.notEqual(salida.type, 'interactive');
  assert.equal(cuenta('sessions', 'phone = ?', NUEVO), 1);
  assert.equal(queries.consentimientoDe(paciente.id).text_version, 1);
});

test('un paciente que ya usaba el bot NO recibe el aviso aunque su sesión haya vencido', async () => {
  const ANTIGUO = '593990000002';
  const p = queries.crearPaciente({ cedula: '0102030418', name: 'Paciente Antiguo', phone: ANTIGUO });
  queries.abrirSesion(p.id, ANTIGUO, 90);
  db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE phone = ?").run(ANTIGUO);

  const [salida] = await llega(ANTIGUO, texto('Hola'));
  assert.equal(salida.type, 'text');
  assert.match(salida.text.body, /cédula/);
  assert.equal(cuenta('consents', 'phone = ?', ANTIGUO), 0);
});

test('si el doctor cambia el texto, los nuevos ven la versión 2', async () => {
  const { guardarAjuste } = await import('../src/services/ajustes.js');
  assert.equal(guardarAjuste('consentimiento.texto', 'x'.repeat(1025)), 'Tiene 1025 caracteres; el máximo es 1024.');
  assert.equal(guardarAjuste('consentimiento.texto', 'Texto revisado por el abogado. ¿Acepta?'), null);

  const [salida] = await llega('593990000003', texto('Hola'));
  assert.equal(salida.interactive.body.text, 'Texto revisado por el abogado. ¿Acepta?');
  assert.equal(salida.interactive.action.buttons[0].reply.id, 'consentimiento:acepto:v2');
});
