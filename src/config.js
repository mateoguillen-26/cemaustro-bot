/**
 * Configuración central de la aplicación.
 * Lee las variables de entorno y expone constantes usadas en todo el proyecto.
 */
import 'dotenv/config';
import path from 'node:path';

/** Lee una variable de entorno. Devuelve el valor por defecto si está vacía. */
function env(nombre, porDefecto = '') {
  const valor = process.env[nombre];
  return valor === undefined || valor === '' ? porDefecto : valor;
}

/** Lee una variable numérica, cayendo al valor por defecto si no es un número. */
function numero(nombre, porDefecto) {
  const valor = Number(env(nombre, String(porDefecto)));
  return Number.isFinite(valor) ? valor : porDefecto;
}

export const config = {
  // --- Servidor ---
  puerto: numero('PORT', 3000),
  entorno: env('NODE_ENV', 'development'),

  // --- Identidad del consultorio (aparece en los mensajes al paciente) ---
  clinica: {
    nombre: env('CLINICA_NOMBRE', 'Consultorio'),
    // SIN artículo delante: los mensajes ya ponen "el", "del" o "al" según
    // toque ("Soy el asistente del Dr. Pérez"). Escríbalo como "Dr. Pérez".
    doctor: env('DOCTOR_NOMBRE', 'médico tratante'),
    // Teléfono del consultorio que se le da al paciente cuando hay que
    // atenderlo en persona. Es informativo: no se le envía nada.
    telefonoContacto: env('CLINICA_TELEFONO', ''),
  },

  // --- WhatsApp Meta Cloud API ---
  whatsapp: {
    token: env('WHATSAPP_TOKEN'),
    phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
    verifyToken: env('WHATSAPP_VERIFY_TOKEN'),
    apiVersion: env('WHATSAPP_API_VERSION', 'v21.0'),
    /**
     * "App Secret" de la aplicación de Meta. Con él se valida la firma
     * X-Hub-Signature-256 de cada webhook. Si se deja vacío, la validación
     * queda DESACTIVADA (solo aceptable en desarrollo): sin ella, cualquiera
     * que conozca la URL puede inyectar mensajes falsos.
     */
    appSecret: env('WHATSAPP_APP_SECRET'),
    // Solo para pruebas locales con un servidor simulado.
    baseUrlOverride: env('WHATSAPP_BASE_URL'),
    get baseUrl() {
      return this.baseUrlOverride || `https://graph.facebook.com/${this.apiVersion}`;
    },

    /**
     * Plantilla aprobada por Meta para avisarle al doctor fuera de la ventana
     * de 24 horas. Debe tener una sola variable {{1}} con el texto del aviso.
     * Si se deja vacía, el aviso solo sale si el doctor escribió hace poco.
     */
    plantillaAlerta: env('WHATSAPP_TEMPLATE_ALERTA'),
    plantillaIdioma: env('WHATSAPP_TEMPLATE_LANGUAGE', 'es'),
  },

  // --- OpenAI: transcribe audios (Whisper), responde (GPT) y busca (embeddings) ---
  openai: {
    apiKey: env('OPENAI_API_KEY'),
    modelo: env('OPENAI_MODEL', 'gpt-4o-mini'),
    modeloTranscripcion: env('OPENAI_TRANSCRIPTION_MODEL', 'whisper-1'),
    /** Modelo que mira las fotos de los platos. Tiene que aceptar imágenes. */
    modeloVision: env('OPENAI_VISION_MODEL', 'gpt-4o-mini'),
    modeloEmbeddings: env('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small'),
    maxTokens: numero('OPENAI_MAX_TOKENS', 700),
    baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
  },

  // --- Base de datos ---
  db: {
    ruta: path.resolve(env('DATABASE_PATH', './data/cemaustro.db')),
  },

  /**
   * Registro (logs).
   *
   * Se escribe siempre a un archivo, no solo a la consola. En Windows, si se
   * selecciona texto en la ventana de la terminal, la escritura a la consola
   * se bloquea y con ella el proceso entero: el servidor sigue escuchando
   * pero deja de contestar. Con el archivo eso ya no puede pasar.
   */
  logs: {
    archivo: path.resolve(env('LOG_FILE', './logs/cemaustro.log')),
    /** Megabytes que puede ocupar el archivo antes de rotarlo. */
    maxMegas: numero('LOG_MAX_MB', 5),
    /** Escribir también en la consola. Póngalo en 'false' al correr en segundo plano. */
    consola: env('LOG_CONSOLE', 'true') !== 'false',
  },

  // --- Zona horaria / idioma ---
  zonaHoraria: env('TIMEZONE', 'America/Guayaquil'),
  idioma: 'es',

  /**
   * Autenticación de pacientes.
   *
   * Un número desconocido no recibe NINGUNA respuesta médica hasta verificarse.
   * Hay dos caminos, y los dos exigen que el paciente ya exista en el padrón
   * que el doctor cargó:
   *
   *   1. El doctor ya registró el teléfono del paciente -> basta con que
   *      escriba su cédula desde ESE número (posesión del teléfono +
   *      conocimiento de la cédula).
   *   2. El teléfono no está registrado -> hace falta además un código de
   *      vinculación que el doctor genera en el panel y le entrega en
   *      consulta. Al usarlo, el número queda ligado a ese paciente.
   */
  auth: {
    /** Días que dura la sesión antes de pedir la cédula otra vez. */
    diasDeSesion: numero('AUTH_SESSION_DAYS', 90),
    /** Minutos de validez de un código de vinculación generado en el panel. */
    minutosDelCodigo: numero('AUTH_CODE_MINUTES', 4320), // 3 días
    /** Intentos fallidos permitidos antes de bloquear temporalmente el número. */
    maxIntentos: numero('AUTH_MAX_ATTEMPTS', 5),
    /** Minutos de bloqueo tras agotar los intentos. */
    minutosDeBloqueo: numero('AUTH_LOCKOUT_MINUTES', 60),
    /**
     * Sal secreta con la que se resumen (hash) los códigos de vinculación.
     * Si cambia, los códigos ya emitidos dejan de servir.
     */
    pepper: env('AUTH_PEPPER', 'cambie-esta-sal-en-produccion'),
  },

  /** Aviso al doctor cuando algo necesita su atención. */
  doctor: {
    /** Número en formato internacional sin '+', ej. 593987654321. */
    telefono: env('DOCTOR_TELEFONO', '').replace(/[^0-9]/g, ''),
    get alertasActivas() {
      return Boolean(this.telefono);
    },
    /** Minutos mínimos entre dos alertas del mismo paciente (evita ráfagas). */
    minutosEntreAlertas: numero('DOCTOR_ALERT_COOLDOWN_MINUTES', 30),
  },

  /** Búsqueda en la base de conocimiento del doctor (RAG). */
  conocimiento: {
    /** Caracteres por fragmento al partir un documento. */
    tamanoFragmento: numero('RAG_CHUNK_SIZE', 1200),
    /** Caracteres que se repiten entre fragmentos vecinos, para no cortar ideas. */
    solapeFragmento: numero('RAG_CHUNK_OVERLAP', 200),
    /** Cuántos fragmentos se le pasan al modelo como contexto. */
    fragmentos: numero('RAG_TOP_K', 5),
    /** Similitud mínima (0 a 1) para considerar que un fragmento sirve. */
    similitudMinima: Number(env('RAG_MIN_SIMILARITY', '0.30')),
  },

  /**
   * Umbrales de glucemia en mg/dL para decidir si un valor reportado por el
   * paciente merece una alerta. Son valores de tamizaje, no de diagnóstico:
   * sirven para avisar, nunca para tratar.
   */
  glucemia: {
    hipoGrave: numero('GLUCOSA_HIPO_GRAVE', 54),
    hipo: numero('GLUCOSA_HIPO', 70),
    altaAviso: numero('GLUCOSA_ALTA_AVISO', 250),
    altaGrave: numero('GLUCOSA_ALTA_GRAVE', 300),
    /** Rango que se acepta como lectura plausible; fuera de esto se pregunta. */
    minimoPlausible: numero('GLUCOSA_MIN', 20),
    maximoPlausible: numero('GLUCOSA_MAX', 800),
  },

  /** Cuántos mensajes previos se envían al modelo como contexto. */
  mensajesDeContexto: numero('CONTEXT_MESSAGES', 6),

  /**
   * Largo máximo, en caracteres, que se le pide a una respuesta.
   * Es una instrucción al modelo, no un corte: cortar un texto clínico a la
   * mitad puede dejar fuera justo la parte que le decía que consulte.
   */
  limiteRespuesta: numero('RESPONSE_MAX_CHARS', 450),

  admin: {
    /**
     * Panel en /admin. Si falta usuario o contraseña queda DESACTIVADO:
     * muestra datos de salud identificables y nunca debe quedar abierto.
     */
    usuario: env('ADMIN_USER'),
    password: env('ADMIN_PASSWORD'),
    get activo() {
      return Boolean(this.usuario && this.password);
    },
  },

  ventana: {
    /**
     * WhatsApp permite mensajes libres durante 24 h desde el último mensaje
     * del usuario. Se deja margen para no quedar justo en el borde.
     */
    horasLibres: Number(env('FREE_WINDOW_HOURS', '23.5')),
  },
};

/**
 * Verifica que las variables críticas estén configuradas.
 * Devuelve la lista de variables faltantes (vacía si todo está bien).
 */
export function validarConfiguracion() {
  const faltantes = [];
  if (!config.whatsapp.token) faltantes.push('WHATSAPP_TOKEN');
  if (!config.whatsapp.phoneNumberId) faltantes.push('WHATSAPP_PHONE_NUMBER_ID');
  if (!config.whatsapp.verifyToken) faltantes.push('WHATSAPP_VERIFY_TOKEN');
  if (!config.openai.apiKey) faltantes.push('OPENAI_API_KEY');
  return faltantes;
}

/**
 * Avisos de configuración que no impiden arrancar pero sí dejan el sistema
 * más débil de lo que debería estar en producción.
 */
export function advertenciasDeConfiguracion() {
  const avisos = [];
  if (!config.whatsapp.appSecret) {
    avisos.push(
      'WHATSAPP_APP_SECRET está vacío: no se valida la firma de los webhooks. ' +
        'Cualquiera que conozca la URL podría enviar mensajes falsos.',
    );
  }
  if (config.auth.pepper === 'cambie-esta-sal-en-produccion') {
    avisos.push('AUTH_PEPPER sigue con el valor de ejemplo. Póngale una cadena larga y única.');
  }
  if (!config.admin.activo) {
    avisos.push('ADMIN_USER/ADMIN_PASSWORD vacíos: el panel /admin está desactivado.');
  }
  if (!config.doctor.telefono) {
    avisos.push('DOCTOR_TELEFONO vacío: las alertas se guardan pero no se le avisan por WhatsApp.');
  }
  return avisos;
}
