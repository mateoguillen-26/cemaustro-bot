/**
 * Carga el padrón de pacientes desde un CSV.
 *
 *   npm run importar-pacientes -- data/pacientes.csv
 *
 * Columnas esperadas (con encabezado, en cualquier orden):
 *   cedula,nombre,telefono,tipo,notas
 *
 * - "telefono" es opcional. Si lo pone, el paciente se verifica escribiendo
 *   solo su cédula desde ese número. Si lo deja en blanco, hará falta además
 *   un código de vinculación generado en el panel.
 * - Una cédula que ya existe se ACTUALIZA, no se duplica.
 */
import fs from 'node:fs';
import path from 'node:path';
import { obtenerDB, cerrarDB } from '../db/database.js';
import { ejecutarMigraciones } from '../db/migrations.js';
import * as db from '../db/queries.js';
import { esCedulaValida, normalizarCedula } from '../utils/cedula.js';

/**
 * Lector de CSV mínimo pero correcto: entiende comillas dobles, comas dentro
 * de un campo y comillas escapadas (""). No hace falta una dependencia para
 * un archivo que exporta una hoja de cálculo.
 */
function leerCSV(texto) {
  const filas = [];
  let fila = [];
  let campo = '';
  let entreComillas = false;

  for (let i = 0; i < texto.length; i += 1) {
    const caracter = texto[i];

    if (entreComillas) {
      if (caracter === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i += 1;
        } else {
          entreComillas = false;
        }
      } else {
        campo += caracter;
      }
      continue;
    }

    if (caracter === '"') entreComillas = true;
    else if (caracter === ',') {
      fila.push(campo);
      campo = '';
    } else if (caracter === '\n') {
      fila.push(campo.trim());
      filas.push(fila);
      fila = [];
      campo = '';
    } else if (caracter !== '\r') {
      campo += caracter;
    }
  }

  if (campo || fila.length > 0) {
    fila.push(campo.trim());
    filas.push(fila);
  }

  return filas.filter((f) => f.some((c) => c !== ''));
}

function importar() {
  const ruta = process.argv[2];
  if (!ruta) {
    console.error('Uso: npm run importar-pacientes -- ruta/al/archivo.csv');
    process.exit(1);
  }

  const absoluta = path.resolve(ruta);
  if (!fs.existsSync(absoluta)) {
    console.error(`No existe el archivo ${absoluta}.`);
    process.exit(1);
  }

  obtenerDB();
  ejecutarMigraciones();

  const filas = leerCSV(fs.readFileSync(absoluta, 'utf8'));
  if (filas.length < 2) {
    console.error('El archivo no tiene datos (hace falta el encabezado y al menos una fila).');
    process.exit(1);
  }

  const encabezado = filas[0].map((c) => c.toLowerCase().trim());
  const columna = (nombre) => encabezado.indexOf(nombre);

  const iCedula = columna('cedula');
  const iNombre = columna('nombre');
  const iTelefono = columna('telefono');
  const iTipo = columna('tipo');
  const iNotas = columna('notas');

  if (iCedula < 0 || iNombre < 0) {
    console.error('Faltan las columnas obligatorias "cedula" y "nombre".');
    process.exit(1);
  }

  let creados = 0;
  let actualizados = 0;
  let rechazados = 0;

  for (const fila of filas.slice(1)) {
    const cedula = normalizarCedula(fila[iCedula]);
    const nombre = (fila[iNombre] ?? '').trim();

    if (!esCedulaValida(cedula) || !nombre) {
      console.log(`✗ Fila rechazada (cédula o nombre inválidos): ${fila.join(',')}`);
      rechazados += 1;
      continue;
    }

    const telefono = iTelefono >= 0 ? (fila[iTelefono] ?? '').replace(/[^0-9]/g, '') || null : null;
    const tipo = iTipo >= 0 ? (fila[iTipo] ?? '').trim() || null : null;
    const notas = iNotas >= 0 ? (fila[iNotas] ?? '').trim() || null : null;

    // Un teléfono no puede estar en dos historias a la vez.
    const dueño = telefono ? db.pacientePorTelefono(telefono) : null;
    const existente = db.pacientePorCedula(cedula);

    if (dueño && dueño.cedula !== cedula) {
      console.log(`✗ ${nombre}: el teléfono ${telefono} ya es de otro paciente. Se importa sin teléfono.`);
      rechazados += 1;
    }

    const telefonoFinal = dueño && dueño.cedula !== cedula ? null : telefono;

    if (existente) {
      db.actualizarPaciente(existente.id, {
        name: nombre,
        phone: telefonoFinal,
        diabetesType: tipo,
        notes: notas ?? existente.notes,
        active: true,
      });
      actualizados += 1;
    } else {
      db.crearPaciente({ cedula, name: nombre, phone: telefonoFinal, diabetesType: tipo, notes: notas });
      creados += 1;
    }
  }

  console.log(`\nListo: ${creados} nuevo(s), ${actualizados} actualizado(s), ${rechazados} con problemas.`);
  cerrarDB();
}

try {
  importar();
} catch (error) {
  console.error('La importación falló:', error.message);
  cerrarDB();
  process.exit(1);
}
