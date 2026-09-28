/**
 * Levanta el bot entero para una prueba: base cifrada en una carpeta
 * temporal, y un WhatsApp de mentira que recibe todo lo que el bot envía.
 * Los mensajes entran al webhook firmados como los manda Meta. Nada sale a
 * internet.
 *
 * Cada archivo de prueba corre en su propio proceso, así que cada uno tiene
 * su bot y su base; los puertos se pasan para que no choquen.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const SECRETO = 'secreto-de-prueba';

export async function levantarBot({ puertoBot, puertoWhatsapp, entorno = {} }) {
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'cemaustro-prueba-'));

  Object.assign(process.env, {
    DATABASE_PATH: path.join(carpeta, 'prueba.db'),
    DB_ENCRYPTION_KEY: 'clave-de-prueba-0123456789abcdef-0123456789',
    LOG_CONSOLE: 'false',
    LOG_FILE: path.join(carpeta, 'prueba.log'),
    PORT: String(puertoBot),
    WHATSAPP_APP_SECRET: SECRETO,
    WHATSAPP_TOKEN: 'token-de-prueba',
    WHATSAPP_PHONE_NUMBER_ID: '123',
    WHATSAPP_BASE_URL: `http://127.0.0.1:${puertoWhatsapp}`,
    CLINICA_TELEFONO: '+593 99 000 0000',
    ...entorno,
  });

  /* WhatsApp de mentira: guarda cada envío. */
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
  await new Promise((r) => whatsappFalso.listen(puertoWhatsapp, '127.0.0.1', r));

  const { servidor } = await import('../../src/index.js');
  await new Promise((r) => setTimeout(r, 300));
  const database = await import('../../src/db/database.js');
  const db = database.obtenerDB();
  const queries = await import('../../src/db/queries.js');

  let contador = 0;

  /** Manda un mensaje al webhook como lo haría Meta y devuelve lo que el bot envió. */
  async function llega(telefono, contenido, { esperar = 1 } = {}) {
    const antes = enviados.length;
    const mensaje = { from: telefono, id: `wamid.prueba.${++contador}`, timestamp: '0', ...contenido };
    const cuerpo = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { messages: [mensaje] } }] }],
    });
    const firma = crypto.createHmac('sha256', SECRETO).update(cuerpo).digest('hex');
    const r = await fetch(`http://127.0.0.1:${puertoBot}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${firma}` },
      body: cuerpo,
    });
    assert.equal(r.status, 200);

    for (let i = 0; i < 100 && enviados.length < antes + esperar; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 30)); // por si llega algo más
    return enviados.slice(antes);
  }

  async function cerrar() {
    whatsappFalso.close();
    servidor?.close();
    database.cerrarDB();
    fs.rmSync(carpeta, { recursive: true, force: true });
  }

  return {
    db,
    queries,
    enviados,
    llega,
    cerrar,
    ultimoId: () => `wamid.prueba.${contador}`,
    url: (ruta) => `http://127.0.0.1:${puertoBot}${ruta}`,
  };
}

export const texto = (body) => ({ type: 'text', text: { body } });
export const boton = (id, title = '') => ({
  type: 'interactive',
  interactive: { type: 'button_reply', button_reply: { id, title } },
});
