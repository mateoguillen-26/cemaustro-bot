/**
 * Sacar el texto de un archivo que sube el doctor (PDF, Word, txt o md).
 *
 * Lo que sale de aquí NO se guarda directamente: se le muestra al doctor para
 * que lo revise antes. El motivo es que la extracción puede salir torcida sin
 * fallar —un PDF a dos columnas se entrelaza, los encabezados se repiten en
 * cada página, un escaneado no tiene texto ninguno— y un documento mal
 * extraído no rompe nada: empeora las respuestas en silencio, que es peor.
 *
 * El texto se parte luego en fragmentos por párrafos (services/conocimiento),
 * así que aquí se trabaja para que los párrafos queden bien marcados.
 */
import { logger } from '../utils/logger.js';

/** Tamaño máximo de archivo. Un PDF de guía clínica rara vez pasa de 5 MB. */
export const MAX_BYTES = 15 * 1024 * 1024;

/** Lo que se acepta, por extensión. */
export const FORMATOS = {
  '.pdf': 'PDF',
  '.docx': 'Word',
  '.txt': 'texto',
  '.md': 'texto',
};

export function formatoDe(nombre = '') {
  const punto = String(nombre).lastIndexOf('.');
  if (punto === -1) return null;
  const extension = nombre.slice(punto).toLowerCase();
  return FORMATOS[extension] ? extension : null;
}

/** Título propuesto a partir del nombre del archivo. */
export function tituloDesdeNombre(nombre = '') {
  return String(nombre)
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/* ------------------------------------------------------------------ */
/* Limpieza común                                                      */
/* ------------------------------------------------------------------ */

/** Normaliza saltos, quita espacios de sobra y deja como mucho una línea en blanco. */
function ordenar(texto) {
  return String(texto)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ */
/* PDF                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Une los trozos que devuelve pdf.js en líneas, y las líneas en párrafos.
 *
 * pdf.js no entrega párrafos: entrega pedazos de texto con una marca de fin
 * de línea. Se abre párrafo nuevo cuando la línea anterior cerró una frase,
 * que es la mejor pista disponible sin mirar la maquetación.
 */
function lineasAParrafos(lineas) {
  const parrafos = [];
  let actual = [];

  for (const linea of lineas) {
    const texto = linea.trim();

    if (!texto) {
      if (actual.length) parrafos.push(actual.join(' '));
      actual = [];
      continue;
    }

    // Palabra cortada por el salto de línea: "hipogluce-\nmia".
    if (actual.length && actual[actual.length - 1].endsWith('-')) {
      actual[actual.length - 1] = actual[actual.length - 1].slice(0, -1) + texto;
      continue;
    }

    actual.push(texto);

    if (/[.!?:]["')\]]?$/.test(texto)) {
      parrafos.push(actual.join(' '));
      actual = [];
    }
  }

  if (actual.length) parrafos.push(actual.join(' '));
  return parrafos;
}

/**
 * Quita lo que se repite en casi todas las páginas: el membrete, el pie, la
 * numeración. Si no se quitan, aparecen en cada fragmento y ensucian la
 * búsqueda con texto que no dice nada.
 */
function quitarRepetidos(paginas) {
  if (paginas.length < 3) return paginas;

  // Los números se sustituyen antes de comparar, porque el pie de página más
  // común del mundo es "Página 3 de 12": literalmente distinto en cada hoja,
  // pero el mismo estorbo en todas.
  const sinNumeros = (linea) => linea.trim().replace(/\d+/g, '#');

  const cuenta = new Map();
  for (const pagina of paginas) {
    // Solo se miran las dos primeras y las dos últimas líneas de cada página.
    const bordes = [...pagina.slice(0, 2), ...pagina.slice(-2)];
    for (const clave of new Set(bordes.map(sinNumeros))) {
      if (clave.length > 0 && clave.length < 80) {
        cuenta.set(clave, (cuenta.get(clave) ?? 0) + 1);
      }
    }
  }

  const repetidas = new Set(
    [...cuenta.entries()].filter(([, veces]) => veces > paginas.length / 2).map(([clave]) => clave),
  );

  if (repetidas.size === 0) return paginas;
  logger.info(`PDF: se descartaron ${repetidas.size} línea(s) que se repetían en casi todas las páginas.`);

  return paginas.map((pagina) => pagina.filter((linea) => !repetidas.has(sinNumeros(linea))));
}

async function textoDePdf(buffer) {
  // La importación va aquí dentro y no arriba porque pdf.js pesa: solo se
  // carga cuando alguien sube un PDF de verdad.
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

  // Se guarda la tarea de carga, no solo el documento: liberar la memoria de
  // pdf.js se hace sobre ella.
  const tarea = getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: false,
  });
  const documento = await tarea.promise;

  // Se guarda antes de destruir: después, pdf.js invalida el documento y
  // preguntarle cuántas páginas tenía revienta.
  const cuantasPaginas = documento.numPages;
  const paginas = [];

  for (let n = 1; n <= cuantasPaginas; n += 1) {
    const pagina = await documento.getPage(n);
    const contenido = await pagina.getTextContent();

    const lineas = [];
    let linea = '';

    for (const item of contenido.items) {
      if (typeof item.str !== 'string') continue;
      linea += item.str;
      if (item.hasEOL) {
        lineas.push(linea);
        linea = '';
      }
    }
    if (linea) lineas.push(linea);

    paginas.push(lineas);
  }

  await tarea.destroy();

  const limpias = quitarRepetidos(paginas);
  const parrafos = limpias.flatMap((pagina) => lineasAParrafos(pagina));

  return { texto: parrafos.join('\n\n'), paginas: cuantasPaginas };
}

/* ------------------------------------------------------------------ */
/* Word                                                                */
/* ------------------------------------------------------------------ */

async function textoDeWord(buffer) {
  const mammoth = (await import('mammoth')).default;
  const resultado = await mammoth.extractRawText({ buffer });

  // Word ya trae los párrafos marcados, así que aquí no hay que adivinar.
  return { texto: String(resultado.value ?? '').replace(/\n/g, '\n\n') };
}

/* ------------------------------------------------------------------ */
/* Entrada única                                                       */
/* ------------------------------------------------------------------ */

/**
 * Saca el texto de un archivo.
 *
 * @param {object} opciones
 * @param {Buffer} opciones.buffer contenido del archivo
 * @param {string} opciones.nombre nombre original, del que sale la extensión
 * @returns {Promise<{ok: boolean, texto?: string, aviso?: string, error?: string}>}
 */
export async function extraerTexto({ buffer, nombre }) {
  const extension = formatoDe(nombre);
  if (!extension) {
    return { ok: false, error: 'Solo se pueden subir archivos PDF, Word (.docx), .txt o .md.' };
  }
  if (!buffer || buffer.length === 0) {
    return { ok: false, error: 'El archivo llegó vacío.' };
  }

  try {
    let resultado;

    if (extension === '.pdf') {
      resultado = await textoDePdf(buffer);
    } else if (extension === '.docx') {
      resultado = await textoDeWord(buffer);
    } else {
      resultado = { texto: buffer.toString('utf8') };
    }

    const texto = ordenar(resultado.texto);

    // Un PDF escaneado es una foto de un papel: no tiene texto que sacar.
    // Conviene decirlo con claridad, porque a simple vista se lee igual.
    if (texto.length < 20) {
      return {
        ok: false,
        error:
          extension === '.pdf'
            ? 'De este PDF no salió texto. Casi seguro es un escaneado, que por dentro es una ' +
              'imagen. Ábralo, copie el texto a mano y péguelo abajo.'
            : 'El archivo no tiene texto que se pueda leer.',
      };
    }

    logger.info(
      `Documento leído: ${nombre} (${extension}, ${(buffer.length / 1024).toFixed(0)} KB) ` +
        `-> ${texto.length} caracteres.`,
    );

    return {
      ok: true,
      texto,
      aviso:
        extension === '.pdf'
          ? `Se leyeron ${resultado.paginas} página(s). Los PDF a dos columnas o con tablas suelen ` +
            'salir desordenados: revise el texto antes de guardarlo.'
          : null,
    };
  } catch (error) {
    logger.error(`No se pudo leer el archivo ${nombre}.`, error);
    return {
      ok: false,
      error: 'No se pudo leer el archivo. Puede estar dañado o protegido con contraseña.',
    };
  }
}
