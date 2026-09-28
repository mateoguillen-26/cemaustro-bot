/**
 * Datos clínicos del paciente en el panel (ver ayudas/bot.js).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { levantarBot, texto } from './ayudas/bot.js';

let bot;
let db;
let queries;
let pedir;

before(async () => {
  bot = await levantarBot({ puertoBot: 3225, puertoWhatsapp: 3226 });
  ({ db, queries } = bot);
  pedir = await bot.entrar('doctora', 'Contraseña-de-prueba-1!', 'doctor');
});

after(() => bot.cerrar());

const fila = (cedula) => db.prepare('SELECT * FROM patients WHERE cedula = ?').get(cedula);

test('el formulario de agregar trae los cuatro campos', async () => {
  const html = await (await pedir('/admin/pacientes')).text();
  for (const campo of ['age', 'food_allergies', 'medications', 'other_conditions']) {
    assert.match(html, new RegExp(`name="${campo}"`), campo);
  }
});

test('al agregar un paciente se guardan edad, alergias, medicamentos y otras enfermedades', async () => {
  await pedir('/admin/pacientes', {
    cedula: '0102030400',
    name: 'Rosa Paredes',
    phone: '0990000041',
    diabetes_type: '2',
    age: '67',
    food_allergies: 'Maní',
    medications: 'Metformina 850 mg c/12 h',
    other_conditions: 'Hipertensión',
  });
  const p = fila('0102030400');
  assert.equal(p.age, 67);
  assert.equal(p.food_allergies, 'Maní');
  assert.equal(p.medications, 'Metformina 850 mg c/12 h');
  assert.equal(p.other_conditions, 'Hipertensión');
});

test('se pueden dejar vacíos', async () => {
  await pedir('/admin/pacientes', { cedula: '0102030418', name: 'Sin Datos' });
  const p = fila('0102030418');
  assert.equal(p.age, null);
  assert.equal(p.food_allergies, null);
});

test('una edad que no es un número entre 0 y 120 no se guarda', async () => {
  for (const mala of ['200', '-1', '6.5', 'setenta']) {
    await pedir('/admin/pacientes', { cedula: '0102030426', name: 'Edad Mala', age: mala });
    assert.equal(fila('0102030426'), undefined, mala);
  }
});

test('en la ficha se ven y se pueden cambiar o borrar', async () => {
  const p = fila('0102030400');
  const html = await (await pedir(`/admin/pacientes/${p.id}`)).text();
  assert.match(html, /value="67"/);
  assert.match(html, />Metformina 850 mg c\/12 h</);

  await pedir(`/admin/pacientes/${p.id}`, {
    name: p.name,
    phone: p.phone,
    diabetes_type: '2',
    active: '1',
    notes: '',
    age: '68',
    food_allergies: '',
    medications: 'Metformina 1000 mg',
    other_conditions: 'Hipertensión',
  });
  const despues = fila('0102030400');
  assert.equal(despues.age, 68);
  assert.equal(despues.food_allergies, null);
  assert.equal(despues.medications, 'Metformina 1000 mg');
});

test('actualizar desde el CSV no borra los datos clínicos', () => {
  const p = fila('0102030400');
  queries.actualizarPaciente(p.id, { name: p.name, phone: p.phone, diabetesType: '2', notes: null, active: true });
  assert.equal(fila('0102030400').medications, 'Metformina 1000 mg');
});

test('estos datos no se le mandan al modelo', async () => {
  const p = fila('0102030400');
  queries.abrirSesion(p.id, p.phone, 90);
  queries.actualizarDatosClinicos(p.id, {
    edad: 68,
    alergias: 'ALERGIA-SECRETA',
    medicamentos: 'MEDICAMENTO-SECRETO',
    otrasEnfermedades: 'ENFERMEDAD-SECRETA',
  });

  await bot.llega(p.phone, texto('¿Qué puedo desayunar?'));
  const alModelo = bot.peticiones.filter((x) => x.ruta.startsWith('/openai'));
  assert.ok(alModelo.length > 0, 'el mensaje llegó al modelo');
  const todo = JSON.stringify(alModelo);
  assert.match(todo, /Qué puedo desayunar/);
  assert.doesNotMatch(todo, /SECRET[OA]/);
});
