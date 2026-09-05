/**
 * Carga en la base de conocimiento todos los .md y .txt de la carpeta docs/.
 *
 *   npm run importar-docs
 *
 * Un archivo que ya se importó antes (mismo título) se reemplaza y se vuelve
 * a indexar, así que se puede correr las veces que haga falta.
 */
import fs from 'node:fs';
import path from 'node:path';
import { obtenerDB, cerrarDB } from '../db/database.js';
import { ejecutarMigraciones } from '../db/migrations.js';
import * as db from '../db/queries.js';
import { indexarDocumento } from '../services/conocimiento.js';
import { config } from '../config.js';

const CARPETA = path.resolve('./docs');
const EXTENSIONES = new Set(['.md', '.txt']);

async function importar() {
  if (!config.openai.apiKey) {
    console.error('Falta OPENAI_API_KEY: sin ella no se pueden indexar los documentos.');
    process.exit(1);
  }

  if (!fs.existsSync(CARPETA)) {
    console.error(`No existe la carpeta ${CARPETA}.`);
    process.exit(1);
  }

  obtenerDB();
  ejecutarMigraciones();

  const archivos = fs
    .readdirSync(CARPETA)
    .filter((nombre) => EXTENSIONES.has(path.extname(nombre).toLowerCase()));

  if (archivos.length === 0) {
    console.log('No hay archivos .md ni .txt en docs/.');
    cerrarDB();
    return;
  }

  const existentes = new Map(db.listarDocumentos().map((d) => [d.title, d]));

  for (const archivo of archivos) {
    const contenido = fs.readFileSync(path.join(CARPETA, archivo), 'utf8').trim();
    if (!contenido) {
      console.log(`· ${archivo}: vacío, se omite.`);
      continue;
    }

    const titulo = path.basename(archivo, path.extname(archivo));
    const anterior = existentes.get(titulo);

    // Reemplazar en vez de duplicar: así el script se puede correr de nuevo
    // cada vez que el doctor actualiza una guía.
    if (anterior) db.borrarDocumento(anterior.id);

    const documento = db.crearDocumento({ titulo, fuente: `docs/${archivo}`, contenido });
    const resultado = await indexarDocumento(documento.id);

    console.log(
      resultado.ok
        ? `✓ ${archivo}: ${resultado.fragmentos} fragmento(s).`
        : `✗ ${archivo}: ${resultado.error}`,
    );
  }

  cerrarDB();
}

importar().catch((error) => {
  console.error('La importación falló:', error.message);
  cerrarDB();
  process.exit(1);
});
