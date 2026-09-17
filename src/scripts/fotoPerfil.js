/**
 * Pone la foto de perfil del número de WhatsApp del bot.
 *
 *   npm run foto-perfil -- "img/foto diabuddy.jpeg"
 *
 * Meta la pide en dos pasos: primero se sube el archivo con la "Resumable
 * Upload API", que devuelve un identificador (handle), y luego se le indica
 * al perfil del número que use ese handle. La subida va contra la app de
 * Meta, no contra el número, así que el ID de la app se averigua a partir
 * del propio token.
 *
 * WhatsApp recorta la foto en círculo: conviene una imagen cuadrada con lo
 * importante en el centro. JPEG o PNG, hasta 5 MB.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const { token, phoneNumberId, baseUrl } = config.whatsapp;

async function graph(ruta, opciones = {}) {
  const respuesta = await fetch(`${baseUrl}/${ruta}`, {
    ...opciones,
    headers: { Authorization: `OAuth ${token}`, ...(opciones.headers ?? {}) },
  });
  const cuerpo = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok || cuerpo.error) {
    const detalle = cuerpo.error?.message ?? `HTTP ${respuesta.status}`;
    throw new Error(`${ruta}: ${detalle}`);
  }
  return cuerpo;
}

async function ponerFoto() {
  const archivo = process.argv[2];
  if (!archivo) {
    console.error('Uso: npm run foto-perfil -- <imagen.jpg|png>');
    process.exit(1);
  }
  if (!token || !phoneNumberId) {
    console.error('Faltan WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID en el .env.');
    process.exit(1);
  }

  const ruta = path.resolve(archivo);
  const bytes = fs.readFileSync(ruta);
  const extension = path.extname(ruta).toLowerCase();
  const tipo = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }[extension];
  if (!tipo) {
    console.error('La imagen tiene que ser JPEG o PNG.');
    process.exit(1);
  }
  if (bytes.length > 5 * 1024 * 1024) {
    console.error('La imagen pesa más de 5 MB.');
    process.exit(1);
  }

  const app = await graph('app?fields=id,name');
  console.log(`App de Meta: ${app.name} (${app.id}). Imagen: ${path.basename(ruta)}, ${Math.round(bytes.length / 1024)} KB.`);

  // 1. Abrir la sesión de subida y mandar los bytes.
  const sesion = await graph(
    `${app.id}/uploads?file_name=${encodeURIComponent(path.basename(ruta))}&file_length=${bytes.length}&file_type=${tipo}`,
    { method: 'POST' },
  );
  const subida = await graph(sesion.id, {
    method: 'POST',
    headers: { file_offset: '0', 'Content-Type': tipo },
    body: bytes,
  });

  // 2. Decirle al perfil que use lo que se acaba de subir.
  await graph(`${phoneNumberId}/whatsapp_business_profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', profile_picture_handle: subida.h }),
  });

  const perfil = await graph(`${phoneNumberId}/whatsapp_business_profile?fields=profile_picture_url`);
  console.log('Foto de perfil actualizada.');
  console.log(`Puede verla aquí: ${perfil.data?.[0]?.profile_picture_url ?? '(sin URL todavía)'}`);
}

ponerFoto().catch((error) => {
  console.error('No se pudo poner la foto:', error.message);
  process.exit(1);
});
