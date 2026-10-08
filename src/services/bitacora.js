/**
 * Historial de cambios: quién hizo qué y cuándo.
 *
 * Nace de un caso real (casos/2026-10-01-telefono-cambiado.md): a un paciente
 * le cambiaron el teléfono en el panel, perdió el acceso, y no había forma de
 * saber quién ni cuándo lo cambió. Desde entonces se anota:
 *
 *   - cada cambio hecho desde el panel, con el usuario que lo hizo;
 *   - lo que el bot decide sobre un número: verificarlo, cerrarle la sesión
 *     porque escribió "salir", pasarle el número a otra ficha.
 *
 * Los intentos de verificación ya tenían su propia tabla (auth_attempts) y no
 * se duplican aquí; la pantalla de historial los junta con esto al buscar.
 *
 * Anotar NUNCA puede romper lo que se está haciendo: si falla, se deja en el
 * registro del servidor y se sigue. Perder una línea del historial es malo;
 * dejar sin respuesta a un paciente, o sin guardar un cambio, es peor.
 */
import * as db from '../db/queries.js';
import { logger } from '../utils/logger.js';

/** Cómo se lee cada acción en el panel. */
export const ACCIONES = {
  'panel.entrada': 'Entró al panel',
  'paciente.creado': 'Agregó al paciente',
  'paciente.telefono': 'Cambió el teléfono',
  'paciente.estado': 'Cambió el estado',
  'paciente.datos': 'Editó la ficha',
  'paciente.borrado': 'Borró todos los datos de un paciente',
  'sesion.verificada': 'Se verificó',
  'sesion.cerrada_panel': 'Cerró la sesión desde el panel',
  'sesion.cerrada_paciente': 'Cerró su sesión (escribió «salir»)',
  'telefono.vinculado': 'Vinculó su número con un código',
  'telefono.quitado': 'Perdió su número: otro paciente lo vinculó',
  'codigo.generado': 'Generó un código de vinculación',
  'alerta.revisada': 'Marcó una alerta como revisada',
  'documento.creado': 'Agregó un documento al conocimiento',
  'documento.encendido': 'Encendió un documento',
  'documento.apagado': 'Apagó un documento',
  'documento.reindexado': 'Reindexó un documento',
  'documento.borrado': 'Borró un documento',
  'ajuste.cambiado': 'Cambió la configuración',
  'ajuste.restaurado': 'Restauró un valor de fábrica',
  'usuario.creado': 'Creó un usuario del panel',
  'usuario.acceso': 'Cambió el acceso de un usuario',
  'usuario.rol': 'Cambió el papel de un usuario',
  'usuario.password': 'Restableció la contraseña de otro usuario',
  'cuenta.password': 'Cambió su contraseña',
  'cuenta.usuario': 'Cambió su nombre de usuario',
};

/**
 * Grupos para el filtro "Qué" de la pantalla de historial. Cada uno es una
 * lista de prefijos de acción. 'intentos' no está en la tabla: son los
 * intentos de verificación, que se buscan aparte.
 */
export const GRUPOS = {
  numeros: { etiqueta: 'Teléfonos y sesiones', prefijos: ['paciente.telefono', 'paciente.estado', 'sesion.', 'telefono.', 'codigo.'] },
  intentos: { etiqueta: 'Intentos de verificación', prefijos: [] },
  fichas: { etiqueta: 'Fichas de pacientes', prefijos: ['paciente.creado', 'paciente.datos', 'paciente.borrado'] },
  alertas: { etiqueta: 'Alertas', prefijos: ['alerta.'] },
  conocimiento: { etiqueta: 'Conocimiento', prefijos: ['documento.'] },
  panel: { etiqueta: 'Configuración y usuarios', prefijos: ['ajuste.', 'usuario.', 'cuenta.', 'panel.'] },
};

/** Quién, para quien lo lee: "dra.perez", "El paciente (WhatsApp)", "El sistema". */
export function quien(actor = '') {
  if (actor === 'paciente') return 'El paciente (WhatsApp)';
  if (actor === 'sistema') return 'El sistema';
  return actor.replace(/^panel:/, '');
}

/** Actor de algo hecho desde el panel. */
export function desdeElPanel(usuario) {
  return `panel:${usuario.username}`;
}

/**
 * Anota un evento.
 * @param {object} evento
 * @param {string} evento.actor 'panel:<usuario>' | 'paciente' | 'sistema'
 * @param {string} evento.accion una de ACCIONES
 * @param {number} [evento.pacienteId]
 * @param {string} [evento.detalle] texto corto; sin datos de salud
 */
export function anotar({ actor, accion, pacienteId = null, detalle = null }) {
  try {
    db.registrarEvento({ actor, accion, pacienteId, detalle });
  } catch (error) {
    logger.error(`No se pudo anotar en el historial: ${accion}.`, error);
  }
}
