import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esTelefonoValido, normalizarTelefono } from '../src/utils/telefono.js';

test('un celular en formato local pasa al de WhatsApp, sea 099, 098, 097…', () => {
  assert.equal(normalizarTelefono('0991234567'), '593991234567');
  assert.equal(normalizarTelefono('0981234567'), '593981234567');
  assert.equal(normalizarTelefono('0971234567'), '593971234567');
  assert.equal(normalizarTelefono('0961234567'), '593961234567');
  assert.equal(normalizarTelefono('099 123 4567'), '593991234567');
  assert.equal(normalizarTelefono('099-123-4567'), '593991234567');
});

test('las otras maneras de escribir el mismo número dan lo mismo', () => {
  assert.equal(normalizarTelefono('991234567'), '593991234567');
  assert.equal(normalizarTelefono('+593 99 123 4567'), '593991234567');
  assert.equal(normalizarTelefono('593991234567'), '593991234567');
  assert.equal(normalizarTelefono('5930991234567'), '593991234567');
  assert.equal(normalizarTelefono('00593991234567'), '593991234567');
});

test('un número extranjero se deja tal cual', () => {
  assert.equal(normalizarTelefono('+1 (305) 555-0100'), '13055550100');
  assert.equal(normalizarTelefono('34612345678'), '34612345678');
});

test('vacío es null', () => {
  assert.equal(normalizarTelefono(''), null);
  assert.equal(normalizarTelefono(null), null);
  assert.equal(normalizarTelefono('  '), null);
});

test('un número incompleto no se da por válido', () => {
  assert.equal(esTelefonoValido(normalizarTelefono('0991234567')), true);
  assert.equal(esTelefonoValido(normalizarTelefono('099123456')), false);
  assert.equal(esTelefonoValido(normalizarTelefono('09912345678')), false);
  assert.equal(esTelefonoValido(normalizarTelefono('123')), false);
});
