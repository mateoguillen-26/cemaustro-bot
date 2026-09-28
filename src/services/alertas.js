/**
 * Alertas al doctor.
 *
 * Todo lo que el bot detecta como digno de atención queda guardado en la
 * tabla `alerts` — eso pasa siempre, aunque el aviso por WhatsApp falle o
 * esté apagado. El panel es la fuente de verdad; el WhatsApp es la comodidad.
 *
 * Las urgentes se le mandan al doctor de inmediato. Las de nivel "aviso" se
 * guardan y se le mandan también, pero respetando un tiempo de espera por
 * paciente para que una racha de mediciones altas no le llene el teléfono.
 */
import { config } from '../config.js';
import { logger, ofuscarTelefono } from '../utils/logger.js';
import { enMinutos } from '../utils/datetime.js';
import * as db from '../db/queries.js';
import * as whatsapp from './whatsapp.js';
import { ajuste } from './ajustes.js';

/** Texto del aviso que le llega al doctor. */
function redactarAviso(paciente, alerta) {
  const encabezado = alerta.level === 'urgente' ? '🔴 URGENTE' : '🟡 Aviso';
  const telefono = paciente.phone ? `+${paciente.phone}` : 'sin número';

  return (
    `${encabezado} — ${config.clinica.nombre}\n\n` +
    `Paciente: ${paciente.name} (CI ${paciente.cedula})\n` +
    `Teléfono: ${telefono}\n\n` +
    `Motivo: ${alerta.reason}\n` +
    (alerta.excerpt ? `\nDijo: "${alerta.excerpt}"\n` : '') +
    '\nRevise el caso en el panel.'
  );
}

/**
 * Registra una alerta y, si corresponde, se la manda al doctor.
 *
 * @param {object} paciente
 * @param {object} datos
 * @param {'aviso'|'urgente'} datos.nivel
 * @param {string} datos.motivo frase clínica corta
 * @param {string} [datos.extracto] fragmento del mensaje que la disparó
 * @param {'glucemia'|'sintomas'|'peticion'} datos.origen
 * @returns {Promise<object>} la alerta guardada
 */
export async function levantar(paciente, { nivel, motivo, extracto, origen }) {
  const alerta = db.crearAlerta(paciente.id, {
    nivel,
    motivo,
    extracto: extracto ? String(extracto).slice(0, 300) : null,
    origen,
  });

  logger.warn(`Alerta ${nivel} del paciente #${paciente.id}: ${motivo}`);

  if (!config.doctor.telefono) return alerta;
  if (!ajuste('alertas.activas')) {
    logger.info('Aviso al doctor omitido: los avisos por WhatsApp están apagados.');
    return alerta;
  }

  // Las urgentes siempre salen. Las de aviso respetan el tiempo de espera.
  if (nivel !== 'urgente' && enEspera(paciente.id)) {
    logger.info(`Aviso omitido: ya se le avisó del paciente #${paciente.id} hace poco.`);
    return alerta;
  }

  await avisarAlDoctor(paciente, alerta);
  return alerta;
}

/** ¿Ya se le avisó de este paciente hace menos del tiempo de espera? */
function enEspera(pacienteId) {
  const ultima = db.ultimaAlertaNotificada(pacienteId);
  if (!ultima?.notified_at) return false;
  return ultima.notified_at > enMinutos(-config.doctor.minutosEntreAlertas);
}

/**
 * Manda el aviso. Primero como texto libre; si Meta lo rechaza porque el
 * doctor lleva más de 24 h sin escribirle al bot, se reintenta con la
 * plantilla aprobada. Una alerta urgente de madrugada tiene que llegar.
 */
async function avisarAlDoctor(paciente, alerta) {
  const texto = redactarAviso(paciente, alerta);
  const destino = config.doctor.telefono;

  const libre = await whatsapp.enviarMensaje(destino, texto);
  if (libre.ok) {
    db.marcarAlertaNotificada(alerta.id, 'libre');
    return;
  }

  const plantilla = config.whatsapp.plantillaAlerta;
  if (!plantilla) {
    logger.error(
      `No se pudo avisar al doctor (${ofuscarTelefono(destino)}) y no hay plantilla ` +
        'configurada (WHATSAPP_TEMPLATE_ALERTA). La alerta queda solo en el panel.',
    );
    return;
  }

  // La plantilla lleva una sola variable: el resumen en una línea.
  const resumen =
    `${alerta.level === 'urgente' ? 'URGENTE' : 'Aviso'} - ${paciente.name} ` +
    `(CI ${paciente.cedula}): ${alerta.reason}`;

  const conPlantilla = await whatsapp.enviarPlantilla(destino, plantilla, [resumen]);
  if (conPlantilla.ok) {
    db.marcarAlertaNotificada(alerta.id, 'plantilla');
  } else {
    logger.error('No se pudo avisar al doctor ni con plantilla. La alerta queda en el panel.');
  }
}

/**
 * Avisa al doctor que un paciente con alertas sin revisar pidió borrar sus
 * datos. Se manda ANTES de borrar, porque después ya no queda nada en el
 * panel que mirar.
 *
 * Sale aunque los avisos por WhatsApp estén apagados en Configuración: ese
 * interruptor existe porque las alertas se pueden ver en el panel, y estas
 * están a punto de desaparecer de ahí.
 *
 * @returns {Promise<boolean>} true si el aviso llegó a salir
 */
export async function avisarBorradoConAlertas(paciente, abiertas) {
  const destino = config.doctor.telefono;
  if (!destino) {
    logger.warn('Paciente con alertas abiertas borró sus datos, pero no hay DOCTOR_TELEFONO para avisar.');
    return false;
  }

  const telefono = paciente.phone ? `+${paciente.phone}` : 'sin número';
  const motivos = abiertas
    .slice(0, 3)
    .map((a) => `• ${a.level === 'urgente' ? 'URGENTE: ' : ''}${a.reason}`)
    .join('\n');

  const texto =
    `⚠️ Borrado de datos — ${config.clinica.nombre}\n\n` +
    `${paciente.name} (CI ${paciente.cedula}, ${telefono}) pidió borrar todos sus datos ` +
    `del asistente y tenía ${abiertas.length} alerta(s) sin revisar:\n${motivos}\n\n` +
    'Sus datos ya no estarán en el panel. Si hace falta, contáctelo directamente.';

  if ((await whatsapp.enviarMensaje(destino, texto)).ok) return true;

  const plantilla = config.whatsapp.plantillaAlerta;
  if (!plantilla) return false;

  const resumen =
    `Borrado de datos - ${paciente.name} (CI ${paciente.cedula}, ${telefono}) borró sus datos ` +
    `con ${abiertas.length} alerta(s) sin revisar: ${abiertas[0].reason}`;
  return (await whatsapp.enviarPlantilla(destino, plantilla, [resumen])).ok;
}
