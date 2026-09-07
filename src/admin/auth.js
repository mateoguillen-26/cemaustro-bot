/**
 * Entrada al panel: contraseñas, sesión y frenos.
 *
 * El panel muestra nombres, cédulas, conversaciones y datos de salud de
 * pacientes reales, así que aquí no se improvisa:
 *
 *  - La contraseña NUNCA se guarda. Se guarda su resumen con scrypt, que es
 *    lento a propósito: probar contraseñas a lo bruto deja de salir a cuenta.
 *  - La sesión va en una cookie firmada, sin estado en el servidor. La firma
 *    incluye el resumen de la contraseña del usuario, así que cambiarla
 *    invalida sola cualquier sesión abierta en otro sitio.
 *  - Si no hay ningún usuario, el panel NO se sirve. Nunca debe quedar
 *    abierto por un descuido de configuración.
 */
import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import * as db from '../db/queries.js';

/** Nombre de la cookie de sesión. */
const COOKIE = 'sesion';

/** Cuánto dura una sesión antes de pedir la contraseña otra vez. */
const HORAS_DE_SESION = 12;

/** Intentos fallidos por IP antes de cerrar la puerta un rato. */
const MAX_INTENTOS = 8;
const MINUTOS_DE_BLOQUEO = 15;

/* ------------------------------------------------------------------ */
/* Contraseñas                                                         */
/* ------------------------------------------------------------------ */

/** Parámetros de scrypt. N alto = más lento de romper, ~100 ms por intento. */
const SCRYPT = { N: 16384, r: 8, p: 1, largo: 32 };

/** Convierte una contraseña en el texto que se guarda en la base. */
export function resumirPassword(password) {
  const sal = randomBytes(16);
  const resumen = scryptSync(String(password), sal, SCRYPT.largo, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return `scrypt$${SCRYPT.N}$${sal.toString('base64')}$${resumen.toString('base64')}`;
}

/** Comprueba una contraseña contra lo guardado, en tiempo constante. */
export function passwordCorrecta(password, guardado) {
  try {
    const [algoritmo, n, salB64, resumenB64] = String(guardado).split('$');
    if (algoritmo !== 'scrypt') return false;

    const sal = Buffer.from(salB64, 'base64');
    const esperado = Buffer.from(resumenB64, 'base64');
    const calculado = scryptSync(String(password), sal, esperado.length, {
      N: Number(n),
      r: SCRYPT.r,
      p: SCRYPT.p,
    });

    return timingSafeEqual(calculado, esperado);
  } catch (error) {
    logger.error('No se pudo comprobar una contraseña del panel.', error);
    return false;
  }
}

/**
 * Reglas mínimas de una contraseña nueva. Devuelve el problema, o null si
 * sirve. Se piden 12 caracteres y no una sopa de símbolos: la longitud es lo
 * que de verdad cuesta romper, y una regla imposible acaba en un papelito
 * pegado a la pantalla.
 */
export function problemaConLaPassword(password) {
  const texto = String(password ?? '');
  if (texto.length < 12) return 'La contraseña necesita al menos 12 caracteres.';
  if (texto.length > 200) return 'La contraseña es demasiado larga.';
  if (!/[^\s]/.test(texto)) return 'La contraseña no puede ser solo espacios.';
  return null;
}

/* ------------------------------------------------------------------ */
/* Usuario inicial                                                     */
/* ------------------------------------------------------------------ */

/**
 * Crea el primer usuario a partir del .env si todavía no hay ninguno.
 *
 * Existe para que actualizar el servidor no deje al doctor fuera: quien tenía
 * ADMIN_USER/ADMIN_PASSWORD sigue entrando igual, solo que ahora esa cuenta
 * vive en la base y puede cambiar su propia contraseña.
 */
export function asegurarUsuarioInicial() {
  if (db.contarUsuariosPanel() > 0) return;

  if (!config.admin.usuario || !config.admin.password) {
    logger.warn(
      'No hay ningún usuario del panel y ADMIN_USER/ADMIN_PASSWORD están vacíos: ' +
        '/admin queda desactivado hasta que se cree uno.',
    );
    return;
  }

  db.crearUsuarioPanel({
    usuario: config.admin.usuario,
    hash: resumirPassword(config.admin.password),
    nombre: null,
  });

  logger.info(`Usuario inicial del panel creado a partir del .env: "${config.admin.usuario}".`);
}

/* ------------------------------------------------------------------ */
/* Sesión en cookie firmada                                            */
/* ------------------------------------------------------------------ */

/**
 * Clave con la que se firman las cookies. Se reutiliza AUTH_PEPPER, que ya
 * tiene que ser secreta y larga; si cambia, las sesiones abiertas caducan.
 */
function claveDeFirma() {
  return config.auth.pepper;
}

/**
 * La firma incluye el resumen de la contraseña: así, cambiarla echa fuera
 * cualquier sesión abierta en otro navegador sin guardar nada en el servidor.
 */
function firmar(idUsuario, expira, hashPassword) {
  return createHmac('sha256', claveDeFirma())
    .update(`${idUsuario}.${expira}.${hashPassword}`)
    .digest('base64url');
}

function leerCookie(req, nombre) {
  const crudo = req.headers.cookie;
  if (!crudo) return null;

  for (const parte of crudo.split(';')) {
    const separador = parte.indexOf('=');
    if (separador === -1) continue;
    if (parte.slice(0, separador).trim() === nombre) {
      return decodeURIComponent(parte.slice(separador + 1).trim());
    }
  }
  return null;
}

/** Deja la sesión iniciada en la respuesta. */
export function abrirSesion(res, req, usuario) {
  const expira = Date.now() + HORAS_DE_SESION * 3_600_000;
  const valor = `${usuario.id}.${expira}.${firmar(usuario.id, expira, usuario.password_hash)}`;

  // "secure" solo si de verdad vamos por HTTPS: en desarrollo local se entra
  // por http y una cookie segura no llegaría nunca.
  const seguro = req.protocol === 'https' ? ' Secure;' : '';

  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(valor)}; Path=/admin; HttpOnly;${seguro} SameSite=Lax; Max-Age=${
      HORAS_DE_SESION * 3600
    }`,
  );

  db.registrarEntradaPanel(usuario.id);
}

/** Cierra la sesión borrando la cookie. */
export function cerrarSesion(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Devuelve el usuario de la sesión, o null si no hay una válida. */
export function usuarioDeLaSesion(req) {
  const cookie = leerCookie(req, COOKIE);
  if (!cookie) return null;

  const [idTexto, expiraTexto, firma] = cookie.split('.');
  const id = Number(idTexto);
  const expira = Number(expiraTexto);

  if (!Number.isFinite(id) || !Number.isFinite(expira) || !firma) return null;
  if (expira < Date.now()) return null;

  const usuario = db.usuarioPanelPorId(id);
  if (!usuario || !usuario.active) return null;

  const esperada = Buffer.from(firmar(id, expira, usuario.password_hash));
  const recibida = Buffer.from(firma);
  if (esperada.length !== recibida.length) return null;
  if (!timingSafeEqual(esperada, recibida)) return null;

  return usuario;
}

/* ------------------------------------------------------------------ */
/* Freno a los intentos fallidos                                       */
/* ------------------------------------------------------------------ */

/**
 * Contador en memoria por IP. No va a la base a propósito: es información de
 * un momento, se limpia sola y no merece escrituras en disco.
 */
const intentos = new Map();

export function estaBloqueado(ip) {
  const registro = intentos.get(ip);
  if (!registro) return false;

  if (Date.now() - registro.desde > MINUTOS_DE_BLOQUEO * 60_000) {
    intentos.delete(ip);
    return false;
  }

  return registro.cuenta >= MAX_INTENTOS;
}

export function anotarFallo(ip) {
  const ahora = Date.now();
  const registro = intentos.get(ip);

  if (!registro || ahora - registro.desde > MINUTOS_DE_BLOQUEO * 60_000) {
    intentos.set(ip, { desde: ahora, cuenta: 1 });
  } else {
    registro.cuenta += 1;
  }

  // Limpieza barata: el mapa no puede crecer sin fin si nos llueve tráfico.
  if (intentos.size > 5000) {
    for (const [clave, valor] of intentos) {
      if (ahora - valor.desde > MINUTOS_DE_BLOQUEO * 60_000) intentos.delete(clave);
    }
  }
}

export function olvidarFallos(ip) {
  intentos.delete(ip);
}

/** Minutos que faltan para poder volver a intentarlo. */
export function minutosQueFaltan(ip) {
  const registro = intentos.get(ip);
  if (!registro) return 0;
  const pasados = (Date.now() - registro.desde) / 60_000;
  return Math.max(1, Math.ceil(MINUTOS_DE_BLOQUEO - pasados));
}

/* ------------------------------------------------------------------ */
/* Middlewares                                                         */
/* ------------------------------------------------------------------ */

/** Exige sesión iniciada. Manda al login a quien no la tenga. */
export function requiereSesion(req, res, next) {
  if (db.contarUsuariosPanel() === 0) {
    logger.warn('Se intentó entrar al panel, pero no hay ningún usuario creado.');
    return res
      .status(503)
      .type('html')
      .send(
        `<h1>Panel desactivado</h1>
         <p>No hay ningún usuario. Configure <code>ADMIN_USER</code> y
         <code>ADMIN_PASSWORD</code> en el archivo <code>.env</code> y reinicie
         el servidor para crear el primero.</p>`,
      );
  }

  const usuario = usuarioDeLaSesion(req);
  if (!usuario) return res.redirect(303, '/admin/entrar');

  req.usuario = usuario;
  return next();
}

/**
 * Freno contra CSRF.
 *
 * La sesión viaja en una cookie que el navegador manda sola en cada petición,
 * así que un formulario en otra web podría dar de baja a un paciente sin que
 * el doctor se entere. Se exige que lo que modifica datos venga de una página
 * del propio panel.
 */
export function mismoOrigen(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();

  const origen = req.get('origin') || req.get('referer');
  if (!origen) {
    logger.warn('Petición al panel sin origen; rechazada.');
    return res.status(403).send('Petición rechazada por seguridad.');
  }

  const esperado = `${req.protocol}://${req.get('host')}`;
  if (!origen.startsWith(esperado)) {
    logger.warn(`Petición al panel desde un origen ajeno (${origen}); rechazada.`);
    return res.status(403).send('Petición rechazada por seguridad.');
  }

  return next();
}
