/**
 * Recorre el consentimiento por el webhook de verdad (ver ayudas/bot.js).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { levantarBot, texto, boton } from './ayudas/bot.js';

let bot;
let db;
let queries;
let llega;

before(async () => {
  bot = await levantarBot({ puertoBot: 3217, puertoWhatsapp: 3218 });
  ({ db, queries, llega } = bot);
});

after(() => bot.cerrar());

const cuenta = (tabla, donde = '1=1', ...p) =>
  db.prepare(`SELECT COUNT(*) FROM ${tabla} WHERE ${donde}`).pluck().get(...p);

/* --- Casos --- */
const NUEVO = '593990000001';

test('un número nuevo recibe primero el aviso con los botones, y nada más', async () => {
  const [salida] = await llega(NUEVO, texto('Hola'));
  assert.equal(salida.type, 'interactive');
  assert.match(salida.interactive.body.text, /política de tratamiento de datos/);
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
  assert.equal(fila.wa_message_id, bot.ultimoId());
  assert.match(
    db.prepare('SELECT text FROM consent_texts WHERE version = 1').pluck().get(),
    /política de tratamiento de datos/,
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
