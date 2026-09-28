/**
 * Borrado total de datos, por WhatsApp y desde el panel (ver ayudas/bot.js).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { levantarBot, texto, boton } from './ayudas/bot.js';

const DOCTOR = '593990009999';

let bot;
let db;
let queries;
let llega;

before(async () => {
  bot = await levantarBot({
    puertoBot: 3219,
    puertoWhatsapp: 3220,
    entorno: { DOCTOR_TELEFONO: DOCTOR },
  });
  ({ db, queries, llega } = bot);
});

after(() => bot.cerrar());

const cuenta = (tabla, donde = '1=1', ...p) =>
  db.prepare(`SELECT COUNT(*) FROM ${tabla} WHERE ${donde}`).pluck().get(...p);

/** Un paciente verificado con de todo: glucemias, conversación, alerta, consentimiento. */
function pacienteCompleto(cedula, telefono) {
  const p = queries.crearPaciente({ cedula, name: `Paciente ${cedula}`, phone: telefono });
  queries.abrirSesion(p.id, telefono, 90);
  queries.registrarIntento(telefono, '01******00', 'ok', 'teléfono ya registrado');
  const version = queries.versionDeTextoConsentimiento('Aviso de prueba', 'resumen-de-prueba');
  queries.registrarConsentimiento(telefono, version, 'wamid.x');
  queries.ligarConsentimientos(telefono, p.id);
  queries.guardarGlucemia(p.id, { valor: 48, contexto: 'ayunas', medidaEn: new Date().toISOString(), nota: null });
  queries.guardarMensaje(p.id, 'user', 'me siento mareado', null);
  queries.crearAlerta(p.id, { nivel: 'urgente', motivo: 'Hipoglucemia grave (48 mg/dL)', extracto: null, origen: 'glucemia' });
  return p;
}

/** Todo lo que queda de un paciente y sus teléfonos, tabla por tabla. */
function restos(pacienteId, telefono) {
  return {
    patients: cuenta('patients', 'id = ?', pacienteId),
    sessions: cuenta('sessions', 'patient_id = ? OR phone = ?', pacienteId, telefono),
    messages: cuenta('messages', 'patient_id = ?', pacienteId),
    glucose_readings: cuenta('glucose_readings', 'patient_id = ?', pacienteId),
    alerts: cuenta('alerts', 'patient_id = ?', pacienteId),
    consents: cuenta('consents', 'patient_id = ? OR phone = ?', pacienteId, telefono),
    auth_attempts: cuenta('auth_attempts', 'phone = ?', telefono),
    link_codes: cuenta('link_codes', 'patient_id = ?', pacienteId),
  };
}
const nada = (r) => Object.values(r).every((n) => n === 0);

/* ------------------------------------------------------------------ */
/* Reconocer el pedido                                                 */
/* ------------------------------------------------------------------ */

test('se reconoce cuando alguien pide borrar sus datos, y no se confunde con otra cosa', async () => {
  const { pidioBorrar } = await import('../src/services/borrado.js');
  for (const si of [
    'Quiero borrar mis datos',
    'eliminar mis datos por favor',
    'Por favor ELIMINEN TODOS MIS DATOS',
    'borren mi información',
    'quiero que supriman mis datos',
    'Borrar datos',
  ]) {
    assert.equal(pidioBorrar(si), true, si);
  }
  for (const no of ['borré la glucosa de ayer', 'mis datos de glucosa están bien?', 'hola', 'me equivoqué, borra ese dato']) {
    assert.equal(pidioBorrar(no), false, no);
  }
});

/* ------------------------------------------------------------------ */
/* Por WhatsApp                                                        */
/* ------------------------------------------------------------------ */

const TEL = '593990000011';
let paciente;

test('pedirlo muestra la confirmación con botones y no guarda el pedido', async () => {
  paciente = pacienteCompleto('0102030400', TEL);
  const mensajesAntes = cuenta('messages', 'patient_id = ?', paciente.id);

  const [salida] = await llega(TEL, texto('Quiero borrar mis datos'));
  assert.equal(salida.type, 'interactive');
  assert.match(salida.interactive.body.text, /No se puede deshacer/);
  assert.deepEqual(
    salida.interactive.action.buttons.map((b) => b.reply.id),
    ['borrado:si', 'borrado:cancelar'],
  );
  assert.equal(cuenta('messages', 'patient_id = ?', paciente.id), mensajesAntes);
});

test('"Cancelar" no borra nada', async () => {
  const [salida] = await llega(TEL, boton('borrado:cancelar'));
  assert.match(salida.text.body, /no borré nada/);
  assert.equal(restos(paciente.id, TEL).patients, 1);
});

test('un "Sí" sin confirmación pendiente no borra: se vuelve a preguntar', async () => {
  const salidas = await llega(TEL, boton('borrado:si'), { esperar: 2 });
  assert.match(salidas[0].text.body, /venció/);
  assert.equal(salidas[1].type, 'interactive');
  assert.equal(restos(paciente.id, TEL).patients, 1);
});

test('"Sí, borrar todo" avisa al doctor de la alerta abierta, borra todo y lo confirma', async () => {
  const salidas = await llega(TEL, boton('borrado:si'), { esperar: 2 });

  const alDoctor = salidas.find((s) => s.to === DOCTOR);
  assert.ok(alDoctor, 'el doctor recibió el aviso');
  assert.match(alDoctor.text.body, /pidió borrar todos sus datos/);
  assert.match(alDoctor.text.body, /Hipoglucemia grave/);
  assert.ok(salidas.indexOf(alDoctor) < salidas.findIndex((s) => s.to === TEL), 'el aviso sale antes');

  const alPaciente = salidas.find((s) => s.to === TEL);
  assert.match(alPaciente.text.body, /Borré todos sus datos/);

  assert.ok(nada(restos(paciente.id, TEL)), JSON.stringify(restos(paciente.id, TEL)));

  const constancia = db.prepare('SELECT * FROM deletions ORDER BY id DESC LIMIT 1').get();
  assert.equal(constancia.patient_ref, paciente.id);
  assert.equal(constancia.requested_by, 'paciente');
  assert.equal(constancia.had_open_alerts, 1);
  assert.equal(constancia.doctor_notified, 1);
});

test('después del borrado, el número empieza de cero (le llega el aviso de datos)', async () => {
  const [salida] = await llega(TEL, texto('Hola'));
  assert.equal(salida.type, 'interactive');
  assert.match(salida.interactive.body.text, /sus datos/);
  assert.equal(cuenta('consents', 'phone = ?', TEL), 0);
});

test('un número que aceptó el aviso pero no se verificó también puede borrar lo suyo', async () => {
  const SIN_FICHA = '593990000012';
  const [aviso] = await llega(SIN_FICHA, texto('Hola'));
  const acepto = aviso.interactive.action.buttons[0].reply.id;
  await llega(SIN_FICHA, boton(acepto));
  await llega(SIN_FICHA, texto('0999999999')); // un intento fallido de cédula
  assert.equal(cuenta('consents', 'phone = ?', SIN_FICHA), 1);

  const [confirmar] = await llega(SIN_FICHA, texto('eliminar mis datos'));
  assert.match(confirmar.interactive.body.text, /de este número/);
  await llega(SIN_FICHA, boton('borrado:si'));

  assert.equal(cuenta('consents', 'phone = ?', SIN_FICHA), 0);
  assert.equal(cuenta('auth_attempts', 'phone = ?', SIN_FICHA), 0);
  const constancia = db.prepare('SELECT * FROM deletions ORDER BY id DESC LIMIT 1').get();
  assert.equal(constancia.patient_ref, null);
});

/* ------------------------------------------------------------------ */
/* Desde el panel                                                      */
/* ------------------------------------------------------------------ */

async function entrar(usuario, password) {
  const { resumirPassword } = await import('../src/admin/auth.js');
  queries.crearUsuarioPanel({ usuario, hash: resumirPassword(password), rol: usuario === 'jefe' ? 'administrador' : 'doctor' });
  const r = await fetch(bot.url('/admin/entrar'), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: bot.url('') },
    body: new URLSearchParams({ usuario, password }),
  });
  assert.equal(r.status, 303);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return (ruta, cuerpo) =>
    fetch(bot.url(ruta), {
      method: cuerpo ? 'POST' : 'GET',
      redirect: 'manual',
      headers: { cookie, origin: bot.url(''), 'content-type': 'application/x-www-form-urlencoded' },
      body: cuerpo ? new URLSearchParams(cuerpo) : undefined,
    });
}

test('el doctor no ve el botón de borrar ni puede usarlo', async () => {
  const p = pacienteCompleto('0102030418', '593990000013');
  const comoDoctor = await entrar('doctora', 'Contraseña-de-prueba-1!');

  const ficha = await (await comoDoctor(`/admin/pacientes/${p.id}`)).text();
  assert.doesNotMatch(ficha, /Eliminar todos los datos/);

  const r = await comoDoctor(`/admin/pacientes/${p.id}/borrar`, { confirmar_cedula: '0102030418' });
  assert.equal(r.status, 403);
  assert.equal(cuenta('patients', 'id = ?', p.id), 1);
});

test('el administrador borra solo si escribe bien la cédula', async () => {
  const p = db.prepare("SELECT * FROM patients WHERE cedula = '0102030418'").get();
  const comoJefe = await entrar('jefe', 'Contraseña-de-prueba-2!');

  const ficha = await (await comoJefe(`/admin/pacientes/${p.id}`)).text();
  assert.match(ficha, /Eliminar todos los datos/);
  assert.match(ficha, /1 alerta\(s\) sin revisar/);

  await comoJefe(`/admin/pacientes/${p.id}/borrar`, { confirmar_cedula: '0102030400' });
  assert.equal(cuenta('patients', 'id = ?', p.id), 1, 'con otra cédula no se borra');

  const r = await comoJefe(`/admin/pacientes/${p.id}/borrar`, { confirmar_cedula: '0102030418' });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /\/admin\/pacientes/);
  assert.ok(nada(restos(p.id, '593990000013')));

  const constancia = db.prepare('SELECT * FROM deletions ORDER BY id DESC LIMIT 1').get();
  assert.equal(constancia.requested_by, 'panel:jefe');

  const seguridad = await (await comoJefe('/admin/seguridad')).text();
  assert.match(seguridad, /Panel: jefe/);
  assert.doesNotMatch(seguridad, /0102030418/);
});
