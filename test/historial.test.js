/**
 * Historial de cambios, confirmación al cambiar el teléfono de un paciente
 * verificado, y ver/descargar documentos del conocimiento (ver ayudas/bot.js).
 *
 * El primer bloque reproduce el caso del 01/10/2026 (casos/): un paciente
 * verificado al que le cambian el teléfono en el panel.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { levantarBot, texto, boton } from './ayudas/bot.js';

let bot;
let db;
let queries;
let llega;
let admin;
let doctora;

const CEDULA = '0102030400';
const TEL_VIEJO = '593990000071';
const TEL_NUEVO = '593990000072';

before(async () => {
  bot = await levantarBot({ puertoBot: 3227, puertoWhatsapp: 3228 });
  ({ db, queries, llega } = bot);
  admin = await bot.entrar('jefe', 'Contraseña-de-prueba-1!', 'administrador');
  doctora = await bot.entrar('doctora', 'Contraseña-de-prueba-2!', 'doctor');
});

after(() => bot.cerrar());

/** Un número nuevo acepta el aviso de datos y escribe la cédula. */
async function verificarse(telefono, cedula) {
  const [aviso] = await llega(telefono, texto('Hola'));
  await llega(telefono, boton(aviso.interactive.action.buttons[0].reply.id));
  const [salida] = await llega(telefono, texto(cedula));
  return salida;
}

const paciente = () => db.prepare('SELECT * FROM patients WHERE cedula = ?').get(CEDULA);
const eventos = (id) => db.prepare('SELECT * FROM audit_log WHERE patient_id = ? ORDER BY id').all(id);

/** Lo que manda el formulario de la ficha, con lo que se quiera cambiar. */
const formulario = (p, cambios = {}) => ({
  name: p.name,
  phone: p.phone ?? '',
  diabetes_type: p.diabetes_type ?? '',
  active: p.active ? '1' : '0',
  notes: p.notes ?? '',
  age: p.age ?? '',
  food_allergies: '',
  medications: '',
  other_conditions: '',
  ...cambios,
});

test('al verificarse queda anotado desde qué número', async () => {
  queries.crearPaciente({ cedula: CEDULA, name: 'Pedro Prueba', phone: TEL_VIEJO });
  const salida = await verificarse(TEL_VIEJO, CEDULA);
  assert.match(salida.text.body, /quedó verificado/);

  const [verificado] = eventos(paciente().id);
  assert.equal(verificado.action, 'sesion.verificada');
  assert.equal(verificado.actor, 'paciente');
  assert.match(verificado.detail, /0990000071/);
});

test('cambiar el teléfono de un paciente verificado pide confirmación y no guarda nada', async () => {
  const p = paciente();
  const r = await admin(`/admin/pacientes/${p.id}`, formulario(p, { phone: '0990000072' }));
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /perderá el acceso/);
  assert.match(html, /name="confirmado" value="1"/);
  assert.match(html, /name="phone" value="0990000072"/);

  assert.equal(paciente().phone, TEL_VIEJO, 'el teléfono sigue igual');
  assert.ok(queries.sesionVigente(TEL_VIEJO), 'la sesión sigue abierta');
});

test('al confirmar, se guarda, se cierra la sesión y queda anotado quién lo hizo', async () => {
  const p = paciente();
  const r = await admin(`/admin/pacientes/${p.id}`, formulario(p, { phone: '0990000072', confirmado: '1' }));
  assert.equal(r.status, 302);

  assert.equal(paciente().phone, TEL_NUEVO);
  assert.equal(queries.sesionVigente(TEL_VIEJO), null);

  const cambio = eventos(p.id).find((e) => e.action === 'paciente.telefono');
  assert.equal(cambio.actor, 'panel:jefe');
  assert.match(cambio.detail, /0990000071 → 0990000072/);
  assert.match(cambio.detail, /Se cerró su sesión/);
});

test('cambiar datos que no cortan el acceso no pide confirmación y anota solo qué cambió', async () => {
  const p = paciente();
  const r = await doctora(`/admin/pacientes/${p.id}`, formulario(p, { notes: 'Usa insulina basal', age: '70' }));
  assert.equal(r.status, 302);

  const datos = eventos(p.id).find((e) => e.action === 'paciente.datos');
  assert.equal(datos.actor, 'panel:doctora');
  assert.equal(datos.detail, 'Cambió: notas para el asistente, edad');
  assert.doesNotMatch(datos.detail, /insulina/, 'no guarda los valores');
});

test('la ficha muestra la cédula, desde dónde se verificó, quién cerró la sesión y los intentos con otra cédula', async () => {
  // Desde el número nuevo alguien escribe una cédula que no es la suya.
  await verificarse(TEL_NUEVO, '0102030418');

  const html = await (await admin(`/admin/pacientes/${paciente().id}`)).text();
  assert.match(html, /value="0102030400" readonly/);
  assert.match(html, /Se verificó desde/);
  assert.match(html, /0990000071/);
  assert.match(html, /Cambió el teléfono — jefe/);
  assert.match(html, /no es el que tiene registrado ahora|el número registrado ahora es/);
  assert.match(html, /otra cédula/);
});

test('el historial es solo del administrador y encuentra el caso buscando el número', async () => {
  assert.equal((await doctora('/admin/historial')).status, 403);

  const html = await (await admin('/admin/historial?q=0990000072')).text();
  assert.match(html, /Cambió el teléfono/);
  assert.match(html, /Intento fallido/);

  const soloPanel = await (await admin('/admin/historial?quien=panel%3Adoctora')).text();
  assert.match(soloPanel, /Editó la ficha/);
  assert.doesNotMatch(soloPanel, /Cambió el teléfono/);
});

test('el "salir" del paciente queda en el historial aunque no se guarde en la conversación', async () => {
  queries.crearPaciente({ cedula: '0102030426', name: 'Sale Pronto', phone: '593990000073' });
  await verificarse('593990000073', '0102030426');
  await llega('593990000073', texto('salir'));

  const p = db.prepare('SELECT * FROM patients WHERE cedula = ?').get('0102030426');
  assert.ok(eventos(p.id).some((e) => e.action === 'sesion.cerrada_paciente'));
});

test('un paciente con sesiones en dos números sale una sola vez en la lista', async () => {
  const p = paciente();
  // Una sesión vieja (cerrada) y una abierta, como quien cambió de celular.
  queries.abrirSesion(p.id, TEL_NUEVO, 90);
  const html = await (await admin('/admin/pacientes?q=Pedro')).text();
  assert.equal(html.match(/Pedro Prueba<\/a>/g).length, 1);
  assert.match(html, /Verificado/);

  const sinVerificar = await (await admin('/admin/pacientes?estado=sin_verificar')).text();
  assert.doesNotMatch(sinVerificar, /Pedro Prueba/);
});

test('el borrado total se lleva el historial del paciente y sus números', async () => {
  const p = paciente();
  const r = await admin(`/admin/pacientes/${p.id}/borrar`, { confirmar_cedula: CEDULA });
  assert.equal(r.status, 302);

  assert.equal(eventos(p.id).length, 0);
  const restos = db.prepare("SELECT * FROM audit_log WHERE detail LIKE '%0990000071%' OR detail LIKE '%0990000072%'").all();
  assert.equal(restos.length, 0);
  const constancia = db.prepare("SELECT * FROM audit_log WHERE action = 'paciente.borrado'").get();
  assert.equal(constancia.patient_id, null);
  assert.equal(constancia.detail, `Ficha #${p.id}`);
});

/* ------------------------------------------------------------------ */
/* Conocimiento: ver y descargar                                       */
/* ------------------------------------------------------------------ */

/** Sube un archivo como lo haría el navegador (multipart), con la sesión de la doctora. */
async function subir(nombre, contenido) {
  const origen = bot.url('');
  const entrada = await fetch(bot.url('/admin/entrar'), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: origen },
    body: new URLSearchParams({ usuario: 'doctora', password: 'Contraseña-de-prueba-2!' }),
  });
  const cookie = entrada.headers.get('set-cookie').split(';')[0];

  const formulario = new FormData();
  formulario.append('archivo', new Blob([contenido], { type: 'text/plain' }), nombre);
  const r = await fetch(bot.url('/admin/conocimiento/subir'), {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, origin: origen },
    body: formulario,
  });
  return r.text();
}

test('un archivo subido guarda el original, y se puede ver y descargar', async () => {
  const contenido = 'Hipoglucemia: regla del 15.\n\nTome 15 g de azúcar y vuelva a medir en 15 minutos.';
  const revisar = await subir('Guía de hipoglucemia.txt', contenido);
  const token = revisar.match(/name="archivo" value="([^"]+)"/)?.[1];
  assert.ok(token, 'la pantalla de revisión lleva el token del original');

  await doctora('/admin/conocimiento', {
    titulo: 'Hipoglucemia',
    fuente: 'Guía de hipoglucemia.txt',
    contenido,
    archivo: token,
  });
  const doc = db.prepare("SELECT * FROM documents WHERE title = 'Hipoglucemia'").get();
  assert.ok(doc);

  const pagina = await (await doctora(`/admin/conocimiento/${doc.id}`)).text();
  assert.match(pagina, /Guía de hipoglucemia\.txt/);
  assert.match(pagina, /regla del 15/);

  const original = await doctora(`/admin/conocimiento/${doc.id}/original`);
  assert.equal(original.status, 200);
  assert.match(original.headers.get('content-disposition'), /^attachment;/);
  assert.equal(original.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await original.text(), contenido);

  const textoGuardado = await doctora(`/admin/conocimiento/${doc.id}/texto`);
  assert.match(textoGuardado.headers.get('content-disposition'), /Hipoglucemia\.txt/);
  assert.equal(await textoGuardado.text(), contenido);

  const lista = await (await doctora('/admin/conocimiento')).text();
  assert.match(lista, /Original guardado/);
});

test('un documento pegado como texto se ve y se descarga, pero no tiene original', async () => {
  await doctora('/admin/conocimiento', { titulo: 'Pegado', contenido: 'Texto pegado a mano.' });
  const doc = db.prepare("SELECT * FROM documents WHERE title = 'Pegado'").get();

  const pagina = await (await doctora(`/admin/conocimiento/${doc.id}`)).text();
  assert.match(pagina, /no tiene archivo original/);
  assert.equal((await doctora(`/admin/conocimiento/${doc.id}/original`)).status, 404);
  assert.equal(await (await doctora(`/admin/conocimiento/${doc.id}/texto`)).text(), 'Texto pegado a mano.');
});

test('el original que nadie guardó se descarta pasado un día, y borrar el documento borra su original', async () => {
  queries.guardarArchivoPendiente({ token: 'viejo', nombre: 'x.txt', tipo: 'text/plain', datos: Buffer.from('x') });
  db.prepare("UPDATE document_files SET created_at = '2000-01-01T00:00:00.000Z' WHERE token = 'viejo'").run();
  assert.equal(queries.descartarArchivosPendientes(new Date().toISOString()), 1);

  const doc = db.prepare("SELECT * FROM documents WHERE title = 'Hipoglucemia'").get();
  await doctora(`/admin/conocimiento/${doc.id}/borrar`, {});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM document_files').get().n, 0);
});
