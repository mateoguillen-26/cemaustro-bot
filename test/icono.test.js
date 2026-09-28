/**
 * El icono de la pestaña se sirve sin sesión y las páginas lo enlazan.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { levantarBot } from './ayudas/bot.js';

let bot;
before(async () => {
  bot = await levantarBot({ puertoBot: 3221, puertoWhatsapp: 3222 });
});
after(() => bot.cerrar());

test('el icono se sirve como PNG, también en /favicon.ico', async () => {
  for (const ruta of ['/publico/icono.png', '/publico/icono-180.png', '/favicon.ico']) {
    const r = await fetch(bot.url(ruta));
    assert.equal(r.status, 200, ruta);
    assert.equal(r.headers.get('content-type'), 'image/png', ruta);
    const firma = Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString('latin1');
    assert.equal(firma, '\x89PNG', ruta);
  }
});

test('la pantalla de entrada enlaza el icono', async () => {
  const html = await (await fetch(bot.url('/admin/entrar'))).text();
  assert.match(html, /<link rel="icon" type="image\/png" href="\/publico\/icono.png">/);
});
