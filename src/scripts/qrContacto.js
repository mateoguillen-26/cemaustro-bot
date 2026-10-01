/**
 * Saca el código QR (y el link corto) para abrir un chat con el bot.
 *
 *   npm run qr-contacto
 *   npm run qr-contacto -- "Hola Buddy"
 *
 * El número del bot está en la Cloud API, así que no se puede abrir en la app
 * de WhatsApp Business para sacar el QR desde ahí. Meta lo da por la API:
 * cada QR lleva un mensaje ya escrito que el paciente solo tiene que enviar.
 * Si ya existe un QR con el mismo mensaje se reutiliza en vez de crear otro.
 *
 * La imagen se guarda en img/qr-contacto.png.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const { token, phoneNumberId, baseUrl } = config.whatsapp;

async function graph(ruta, opciones = {}) {
  const respuesta = await fetch(`${baseUrl}/${ruta}`, {
    ...opciones,
    headers: { Authorization: `Bearer ${token}`, ...(opciones.headers ?? {}) },
  });
  const cuerpo = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok || cuerpo.error) {
    const detalle = cuerpo.error?.message ?? `HTTP ${respuesta.status}`;
    throw new Error(`${ruta}: ${detalle}`);
  }
  return cuerpo;
}

async function sacarQr() {
  const mensaje = process.argv[2] ?? 'Hola';
  if (!token || !phoneNumberId) {
    console.error('Faltan WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID en el .env.');
    process.exit(1);
  }

  // 1. Buscar uno que ya tenga el mismo mensaje, o crear uno nuevo.
  const existentes = await graph(`${phoneNumberId}/message_qrdls`);
  let qr = existentes.data?.find((q) => q.prefilled_message === mensaje);
  if (qr) {
    console.log(`Ya había un QR con el mensaje "${mensaje}" (${qr.code}).`);
  } else {
    qr = await graph(`${phoneNumberId}/message_qrdls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefilled_message: mensaje, generate_qr_image: 'PNG' }),
    });
    console.log(`QR nuevo creado con el mensaje "${mensaje}" (${qr.code}).`);
  }

  // 2. La lista no trae la imagen; se pide aparte con el código.
  if (!qr.qr_image_url) {
    const conImagen = await graph(`${phoneNumberId}/message_qrdls/${qr.code}?fields=qr_image_url.format(PNG)`);
    qr.qr_image_url = conImagen.data?.[0]?.qr_image_url ?? conImagen.qr_image_url;
  }

  console.log(`Link: ${qr.deep_link_url}`);
  if (!qr.qr_image_url) {
    console.log('Meta no devolvió la imagen; puede armar el QR con el link de arriba.');
    return;
  }

  const imagen = await fetch(qr.qr_image_url);
  if (!imagen.ok) throw new Error(`descarga del QR: HTTP ${imagen.status}`);
  const destino = path.resolve('img/qr-contacto.png');
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, Buffer.from(await imagen.arrayBuffer()));
  console.log(`QR guardado en ${path.relative(process.cwd(), destino)}`);
}

sacarQr().catch((error) => {
  console.error('No se pudo sacar el QR:', error.message);
  process.exit(1);
});
