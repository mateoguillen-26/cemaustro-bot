/**
 * Ajustes que el doctor puede cambiar desde /admin/configuracion sin tocar
 * el servidor ni reiniciarlo.
 *
 * Cada ajuste tiene un valor de fábrica (el .env o una constante). Si hay una
 * fila en la tabla `settings`, esa manda. "Restaurar el de fábrica" borra la
 * fila y devuelve el control al valor original.
 */
import { config } from '../config.js';
import * as db from '../db/queries.js';
import { logger } from '../utils/logger.js';
import {
  PROMPT_SISTEMA_POR_DEFECTO,
  PROMPT_COMIDA_POR_DEFECTO,
  TEXTOS_POR_DEFECTO,
  MARCAS_PROMPT,
} from './prompts.js';

/**
 * Catálogo de lo que se puede tocar. `tipo` decide cómo se pinta el campo en
 * el panel y cómo se valida lo que llega.
 */
export const CATALOGO = [
  {
    clave: 'ia.promptSistema',
    etiqueta: 'Instrucciones clínicas del asistente',
    ayuda:
      'Lo que el modelo lee antes de cada mensaje: qué puede responder, qué no, y cuándo levantar una alerta. ' +
      `Conserve las marcas ${Object.values(MARCAS_PROMPT).join(' ')} — se reemplazan por los datos reales.`,
    tipo: 'texto_largo',
    porDefecto: () => PROMPT_SISTEMA_POR_DEFECTO,
  },
  {
    clave: 'ia.maxCaracteres',
    etiqueta: 'Largo máximo de las respuestas',
    ayuda:
      'Caracteres que puede ocupar una respuesta. 450 son unas 4 líneas de WhatsApp. ' +
      'Bájelo si le parecen largas; súbalo si le parecen secas. Es una instrucción al ' +
      'modelo, no un corte: nunca se le enviará al paciente una frase cortada por la mitad.',
    tipo: 'numero',
    minimo: 150,
    maximo: 2000,
    porDefecto: () => config.limiteRespuesta,
  },
  {
    clave: 'ia.promptComida',
    etiqueta: 'Instrucciones para las fotos de comida',
    ayuda:
      'Lo que lee el modelo que mira la foto del plato para calcular calorías y carbohidratos. ' +
      'No le habla al paciente: su análisis lo redacta después el asistente con las reglas de arriba.',
    tipo: 'texto_largo',
    porDefecto: () => PROMPT_COMIDA_POR_DEFECTO,
  },
  {
    clave: 'ia.mensajesContexto',
    etiqueta: 'Mensajes previos de contexto',
    ayuda: 'Cuántos mensajes anteriores ve el modelo para entender la conversación. Entre 0 y 20.',
    tipo: 'numero',
    minimo: 0,
    maximo: 20,
    porDefecto: () => config.mensajesDeContexto,
  },
  {
    clave: 'ia.fragmentos',
    etiqueta: 'Fragmentos de la base de conocimiento',
    ayuda: 'Cuántos pedazos de sus documentos se le pasan al modelo en cada respuesta. Entre 0 y 12.',
    tipo: 'numero',
    minimo: 0,
    maximo: 12,
    porDefecto: () => config.conocimiento.fragmentos,
  },
  {
    clave: 'alertas.activas',
    etiqueta: 'Avisarme por WhatsApp',
    ayuda:
      'Si lo apaga, las alertas se siguen guardando y las ve en el panel, pero no le llega el mensaje.',
    tipo: 'si_no',
    porDefecto: () => config.doctor.alertasActivas,
  },
  {
    clave: 'textos.errorTecnico',
    etiqueta: 'Mensaje ante un error técnico',
    tipo: 'texto',
    porDefecto: () => TEXTOS_POR_DEFECTO.errorTecnico,
  },
  {
    clave: 'textos.errorAudio',
    etiqueta: 'Mensaje cuando no se entiende un audio',
    tipo: 'texto',
    porDefecto: () => TEXTOS_POR_DEFECTO.errorAudio,
  },
  {
    clave: 'textos.errorImagen',
    etiqueta: 'Mensaje cuando no se puede ver una foto',
    tipo: 'texto',
    porDefecto: () => TEXTOS_POR_DEFECTO.errorImagen,
  },
  {
    clave: 'textos.tipoNoSoportado',
    etiqueta: 'Mensaje ante un archivo que no se puede leer',
    tipo: 'texto',
    porDefecto: () => TEXTOS_POR_DEFECTO.tipoNoSoportado,
  },
];

const PorClave = new Map(CATALOGO.map((a) => [a.clave, a]));

/** Convierte lo guardado (siempre texto) al tipo que espera quien lo lee. */
function convertir(definicion, crudo) {
  switch (definicion.tipo) {
    case 'numero': {
      const valor = Number(crudo);
      return Number.isFinite(valor) ? valor : definicion.porDefecto();
    }
    case 'si_no':
      return crudo === 'true' || crudo === '1';
    default:
      return crudo;
  }
}

/** Valor vigente de un ajuste (el guardado, o el de fábrica). */
export function ajuste(clave) {
  const definicion = PorClave.get(clave);
  if (!definicion) {
    logger.warn(`Se pidió un ajuste desconocido: ${clave}`);
    return null;
  }

  const guardado = db.leerAjuste(clave);
  return guardado === null ? definicion.porDefecto() : convertir(definicion, guardado);
}

/** true si el ajuste está personalizado (hay fila en la tabla). */
export function estaPersonalizado(clave) {
  return db.leerAjuste(clave) !== null;
}

/**
 * Guarda un ajuste. Devuelve un mensaje de error si el valor no sirve,
 * o null si se guardó bien.
 */
export function guardarAjuste(clave, valor) {
  const definicion = PorClave.get(clave);
  if (!definicion) return 'Ese ajuste no existe.';

  if (definicion.tipo === 'numero') {
    const numero = Number(valor);
    if (!Number.isFinite(numero)) return 'Tiene que ser un número.';
    if (definicion.minimo !== undefined && numero < definicion.minimo) {
      return `El mínimo es ${definicion.minimo}.`;
    }
    if (definicion.maximo !== undefined && numero > definicion.maximo) {
      return `El máximo es ${definicion.maximo}.`;
    }
    db.escribirAjuste(clave, String(numero));
    return null;
  }

  if (definicion.tipo === 'si_no') {
    db.escribirAjuste(clave, valor ? 'true' : 'false');
    return null;
  }

  const texto = String(valor ?? '').trim();
  if (!texto) return 'No puede quedar vacío.';
  db.escribirAjuste(clave, texto);
  return null;
}

/** Devuelve un ajuste a su valor de fábrica. */
export function restaurarAjuste(clave) {
  db.borrarAjuste(clave);
  logger.info(`Ajuste "${clave}" restaurado al valor de fábrica.`);
}

/**
 * Reemplaza las marcas {como_esta} del prompt por los valores reales.
 * Las marcas que el doctor haya borrado y sean imprescindibles se agregan al
 * final, para que el bot no se quede sin fecha ni sin el material del
 * consultorio por un descuido al editar.
 */
export function reemplazarMarcas(plantilla, valores) {
  let texto = plantilla;

  for (const [marca, valor] of Object.entries(valores)) {
    texto = texto.split(marca).join(valor ?? '');
  }

  const imprescindibles = [MARCAS_PROMPT.FECHA, MARCAS_PROMPT.LIMITE, MARCAS_PROMPT.DOCUMENTOS];
  const faltantes = imprescindibles
    .filter((marca) => !plantilla.includes(marca))
    .map((marca) => valores[marca])
    .filter(Boolean);

  if (faltantes.length > 0) {
    texto += `\n\n${faltantes.join('\n\n')}`;
  }

  return texto;
}
