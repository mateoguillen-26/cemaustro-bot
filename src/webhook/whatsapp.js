/**
 * Handler del webhook de Meta (WhatsApp Cloud API).
 *
 *  GET  /webhook -> verificación inicial (hub.challenge)
 *  POST /webhook -> recepción de mensajes
 *
 * A Meta se le responde 200 de inmediato; el procesamiento real ocurre en
 * segundo plano para no provocar reintentos por timeout.
 *
 * El orden importa y es siempre el mismo:
 *   firma -> idempotencia -> ¿quién es? -> ¿está verificado? -> responder.
 * Nada de contenido médico sale antes de haber pasado por la verificación.
 */
import express from 'express';
import { config } from '../config.js';
import { logger, ofuscarTelefono } from '../utils/logger.js';
import * as db from '../db/queries.js';
import * as whatsapp from '../services/whatsapp.js';
import * as auth from '../services/auth.js';
import * as glucemias from '../services/glucemias.js';
import * as alertas from '../services/alertas.js';
import { transcribirAudio } from '../services/transcription.js';
import { analizarPlato } from '../services/comida.js';
import { interpretarMensaje, ACCIONES, ALERTAS } from '../services/ai.js';
import { ajuste } from '../services/ajustes.js';

export const router = express.Router();

/** Mensajes por hora que se le atienden a un paciente ya verificado. */
const MAX_MENSAJES_POR_HORA = 40;

/** Respuestas por hora a un número sin verificar (freno contra spam). */
const MAX_RESPUESTAS_SIN_VERIFICAR = 12;

/* ------------------------------------------------------------------ */
/* GET /webhook — verificación de Meta                                 */
/* ------------------------------------------------------------------ */

router.get('/webhook', (req, res) => {
  const modo = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (modo === 'subscribe' && token === config.whatsapp.verifyToken) {
    logger.info('Webhook verificado correctamente por Meta.');
    return res.status(200).send(challenge);
  }

  logger.warn('Intento de verificación de webhook con token incorrecto.');
  return res.sendStatus(403);
});

/* ------------------------------------------------------------------ */
/* POST /webhook — recepción de mensajes                               */
/* ------------------------------------------------------------------ */

router.post('/webhook', (req, res) => {
  // 1) Comprobar que el mensaje viene de verdad de Meta.
  if (!whatsapp.firmaValida(req.rawBody, req.get('x-hub-signature-256'))) {
    logger.warn(`Webhook con firma inválida rechazado (IP ${req.ip}).`);
    return res.sendStatus(401);
  }

  // 2) Responder 200 de inmediato (Meta reintenta si tardamos).
  res.sendStatus(200);

  // 3) Procesar en segundo plano.
  procesarWebhook(req.body).catch((error) => {
    logger.error('Error no controlado al procesar el webhook.', error);
  });
});

/** Recorre la estructura del webhook y procesa cada mensaje entrante. */
async function procesarWebhook(cuerpo) {
  if (cuerpo?.object !== 'whatsapp_business_account') return;

  for (const entrada of cuerpo.entry ?? []) {
    for (const cambio of entrada.changes ?? []) {
      const valor = cambio.value ?? {};

      // Los avisos de estado (entregado, leído...) no requieren respuesta.
      if (!valor.messages) continue;

      for (const mensaje of valor.messages) {
        await procesarMensaje(mensaje);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Freno para números sin verificar                                    */
/* ------------------------------------------------------------------ */

/**
 * Contador en memoria de respuestas dadas a números sin verificar.
 * No va a la base a propósito: de un desconocido no queremos guardar nada
 * más que los intentos de verificación, que sí quedan auditados.
 */
const sinVerificar = new Map();

function puedeResponderleADesconocido(telefono) {
  const ahora = Date.now();
  const registro = sinVerificar.get(telefono);

  if (!registro || ahora - registro.desde > 3_600_000) {
    sinVerificar.set(telefono, { desde: ahora, cuenta: 1 });
    return true;
  }

  registro.cuenta += 1;

  // Limpieza barata: el mapa no puede crecer sin fin si nos llueve spam.
  if (sinVerificar.size > 5000) {
    for (const [clave, valor] of sinVerificar) {
      if (ahora - valor.desde > 3_600_000) sinVerificar.delete(clave);
    }
  }

  return registro.cuenta <= MAX_RESPUESTAS_SIN_VERIFICAR;
}

/* ------------------------------------------------------------------ */
/* Procesamiento de un mensaje                                         */
/* ------------------------------------------------------------------ */

async function procesarMensaje(mensaje) {
  const telefono = mensaje.from;
  const waMessageId = mensaje.id;

  // Meta puede reenviar el mismo mensaje: no se responde dos veces.
  if (!db.registrarMensajeProcesado(waMessageId)) {
    logger.info(`Mensaje duplicado ignorado (${waMessageId}).`);
    return;
  }

  const paciente = auth.pacienteVerificado(telefono);

  if (!paciente) {
    await atenderDesconocido(telefono, mensaje, waMessageId);
    return;
  }

  await atenderPaciente(paciente, mensaje, waMessageId);
}

/* ------------------------------------------------------------------ */
/* Número sin verificar                                                */
/* ------------------------------------------------------------------ */

/**
 * A un número sin verificar solo se le contesta sobre la verificación.
 *
 * Sus audios NO se transcriben: eso significaría mandar la voz de alguien que
 * ni siquiera sabemos que es paciente a un servicio externo. Se le pide que
 * escriba. Sus mensajes tampoco se guardan.
 */
async function atenderDesconocido(telefono, mensaje, waMessageId) {
  if (!puedeResponderleADesconocido(telefono)) {
    logger.warn(`Demasiados mensajes sin verificar desde ${ofuscarTelefono(telefono)}; se ignora.`);
    return;
  }

  whatsapp.marcarComoLeido(waMessageId).catch(() => {});

  if (mensaje.type !== 'text') {
    await whatsapp.enviarMensaje(
      telefono,
      'Para poder atenderle necesito primero verificar que es paciente del consultorio.\n\n' +
        'Por favor, *escríbame* su número de cédula (10 dígitos).',
    );
    return;
  }

  const texto = mensaje.text?.body?.trim() ?? '';
  const { respuesta } = auth.intentarVerificar(telefono, texto);
  await whatsapp.enviarMensaje(telefono, respuesta);
}

/* ------------------------------------------------------------------ */
/* Paciente verificado                                                 */
/* ------------------------------------------------------------------ */

async function atenderPaciente(paciente, mensaje, waMessageId) {
  logger.info(
    `Mensaje de paciente #${paciente.id} (${ofuscarTelefono(paciente.phone)}, tipo: ${mensaje.type}).`,
  );

  // Cualquier mensaje del paciente reabre la ventana de 24 h de WhatsApp.
  db.registrarActividad(paciente.id);
  whatsapp.marcarComoLeido(waMessageId).catch(() => {});

  if (db.mensajesRecientesDe(paciente.id) >= MAX_MENSAJES_POR_HORA) {
    logger.warn(`Paciente #${paciente.id} superó el límite de mensajes por hora.`);
    await responder(
      paciente,
      'Hemos conversado bastante en la última hora 😊 Démosle una pausa y ' +
        'escríbame de nuevo más tarde. Si es algo urgente, acuda al consultorio.',
      false,
    );
    return;
  }

  // --- 1) Obtener el texto ---
  const texto = await obtenerTexto(paciente, mensaje);
  if (texto === null) return; // ya se le respondió el problema

  // --- 2) Casos que no necesitan al modelo ---
  if (auth.pidioCerrarSesion(texto)) {
    await responder(paciente, auth.cerrarSesion(paciente), false);
    return;
  }

  db.guardarMensaje(paciente.id, 'user', texto, waMessageId);

  // --- 3) Preguntarle al modelo ---
  const decision = await interpretarMensaje({
    paciente,
    mensaje: texto,
    historial: db.obtenerHistorial(paciente.id, ajuste('ia.mensajesContexto')),
    resumenGlucemias: db.resumenGlucemias(paciente.id),
  });

  if (!decision) {
    await responder(paciente, ajuste('textos.errorTecnico'), false);
    return;
  }

  // --- 4) Ejecutar y responder ---
  const respuesta = await ejecutar(paciente, decision, texto);
  await responder(paciente, respuesta);
}

/**
 * Texto del mensaje.
 *
 * Un audio se transcribe y una foto de comida se convierte en su análisis:
 * las dos vías terminan en texto para que a partir de aquí el flujo sea
 * siempre el mismo y todo pase por las reglas clínicas del asistente.
 */
async function obtenerTexto(paciente, mensaje) {
  if (mensaje.type === 'text') {
    const texto = mensaje.text?.body?.trim();
    if (texto) return texto;
    await responder(paciente, ajuste('textos.errorTecnico'), false);
    return null;
  }

  if (mensaje.type === 'audio') {
    const mediaId = mensaje.audio?.id;
    const media = mediaId ? await whatsapp.descargarMedia(mediaId) : null;
    const texto = media ? await transcribirAudio(media.buffer, media.mimeType) : null;

    if (!texto) {
      await responder(paciente, ajuste('textos.errorAudio'), false);
      return null;
    }

    logger.info('Nota de voz transcrita correctamente.');
    return texto;
  }

  if (mensaje.type === 'image') {
    const mediaId = mensaje.image?.id;
    const media = mediaId ? await whatsapp.descargarMedia(mediaId) : null;

    const analisis = media
      ? await analizarPlato({
          buffer: media.buffer,
          mimeType: media.mimeType,
          // Lo que el paciente escribió al pie de la foto: muchas veces trae
          // el dato que no se ve, como "es el almuerzo" o "me lo comí todo".
          comentario: mensaje.image?.caption?.trim() || null,
        })
      : null;

    if (!analisis) {
      await responder(paciente, ajuste('textos.errorImagen'), false);
      return null;
    }

    return analisis;
  }

  await responder(paciente, ajuste('textos.tipoNoSoportado'), false);
  return null;
}

/**
 * Aplica lo que decidió el modelo y devuelve el texto final para el paciente.
 *
 * El nivel de alerta se calcula quedándose con el MÁS ALTO entre lo que dijo
 * el modelo y lo que dicen los umbrales de glucemia. Si el modelo pasa por
 * alto un 48 mg/dL, la aritmética lo atrapa igual.
 */
async function ejecutar(paciente, decision, mensajeOriginal) {
  let texto = decision.texto;
  let nivel = decision.nivelAlerta;
  const motivos = decision.motivoAlerta ? [decision.motivoAlerta] : [];
  let origen = decision.accion === ACCIONES.DERIVAR ? 'peticion' : 'sintomas';

  // --- Mediciones ---
  if (decision.lecturas.length > 0) {
    const resultado = glucemias.registrar(paciente, decision.lecturas);
    texto += glucemias.avisoDeDescartes(resultado.descartadas);

    if (esMasGrave(resultado.nivel, nivel)) {
      nivel = resultado.nivel;
      origen = 'glucemia';
    }
    motivos.push(...resultado.motivos);
  }

  // --- Alerta al doctor ---
  if (nivel !== ALERTAS.NINGUNA) {
    const motivo = motivos.length > 0 ? motivos.join(' ') : 'El asistente marcó el caso para revisión.';
    await alertas.levantar(paciente, {
      nivel,
      motivo,
      extracto: mensajeOriginal,
      origen,
    });

    // Que el paciente sepa que su médico ya está enterado: es la mitad de la
    // tranquilidad, y evita que repita el mensaje pensando que se perdió.
    if (nivel === ALERTAS.URGENTE && !/avis/i.test(texto)) {
      texto += `\n\nYa le avisé al ${config.clinica.doctor} sobre esto.`;
    }
  }

  return texto;
}

/** true si `nivel` pesa más que `contra`. */
function esMasGrave(nivel, contra) {
  const orden = { ninguna: 0, aviso: 1, urgente: 2 };
  return (orden[nivel] ?? 0) > (orden[contra] ?? 0);
}

/** Envía la respuesta y la guarda en el historial. */
async function responder(paciente, texto, guardar = true) {
  const { ok } = await whatsapp.enviarMensaje(paciente.phone, texto);
  if (ok && guardar) {
    db.guardarMensaje(paciente.id, 'assistant', texto);
  }
}
