/**
 * Mensajes de la verificación por cédula (ver ayudas/bot.js).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { levantarBot, texto, boton } from './ayudas/bot.js';

let bot;
let queries;
let llega;

before(async () => {
  bot = await levantarBot({ puertoBot: 3223, puertoWhatsapp: 3224 });
  ({ queries, llega } = bot);
  queries.crearPaciente({ cedula: '0102030400', name: 'Ana Registrada', phone: '593990000021' });
});

after(() => bot.cerrar());

/** Un número nuevo que ya aceptó el aviso de datos. */
async function numeroQueAcepto(telefono) {
  const [aviso] = await llega(telefono, texto('Hola'));
  const [trasAceptar] = await llega(telefono, boton(aviso.interactive.action.buttons[0].reply.id));
  return trasAceptar;
}

test('tras aceptar el aviso, se pide la cédula sin volver a saludar', async () => {
  const salida = await numeroQueAcepto('593990000020');
  assert.match(salida.text.body, /^Gracias ✅/);
  assert.match(salida.text.body, /cédula/);
  assert.doesNotMatch(salida.text.body, /Hola/);
});

test('una cédula mal escrita recibe el error de formato', async () => {
  for (const malo of ['0102030401', '010203040', '1234567', '01-02-03-04-01']) {
    const [salida] = await llega('593990000020', texto(malo));
    assert.match(salida.text.body, /no parece correcto/, malo);
  }
});

test('una cédula bien escrita que no está en el padrón dice que no está registrada', async () => {
  const TEL = '593990000030';
  await numeroQueAcepto(TEL);
  const [salida] = await llega(TEL, texto('0102030418'));
  assert.match(salida.text.body, /no está registrada en la plataforma/);
  assert.doesNotMatch(salida.text.body, /código/);
});

test('un paciente registrado que escribe desde otro número recibe el pedido de código', async () => {
  const TEL = '593990000031';
  await numeroQueAcepto(TEL);
  const [salida] = await llega(TEL, texto('0102030400'));
  assert.match(salida.text.body, /código de 6 dígitos/);
});

test('desde su número registrado, entra directo', async () => {
  const TEL = '593990000021';
  await numeroQueAcepto(TEL);
  const [salida] = await llega(TEL, texto('0102030400'));
  assert.match(salida.text.body, /quedó verificado/);
});

test('preguntar por cédulas ajenas cuenta como intento fallido y termina bloqueando', async () => {
  const TEL = '593990000032';
  await numeroQueAcepto(TEL);
  for (let i = 0; i < 5; i++) await llega(TEL, texto('0102030418'));
  const [salida] = await llega(TEL, texto('0102030400'));
  assert.match(salida.text.body, /bloqueado/);
});
