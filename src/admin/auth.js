/**
 * Protección del panel de administración (HTTP Basic Auth).
 *
 * Criterio de seguridad: si no hay usuario y contraseña configurados, el panel
 * NO se sirve. Muestra nombres, cédulas y datos de salud de pacientes reales,
 * así que nunca debe quedar abierto por un descuido de configuración.
 */
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/** Comparación en tiempo constante (no filtra la clave por tiempos de respuesta). */
function igualSeguro(a = '', b = '') {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Se compara igual para no revelar la longitud por el tiempo de respuesta.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Middleware de autenticación básica. */
export function requiereAuth(req, res, next) {
  if (!config.admin.activo) {
    logger.warn('Se intentó entrar al panel, pero está desactivado (falta ADMIN_USER/ADMIN_PASSWORD).');
    return res
      .status(503)
      .type('html')
      .send(
        `<h1>Panel desactivado</h1>
         <p>Configure <code>ADMIN_USER</code> y <code>ADMIN_PASSWORD</code>
         en el archivo <code>.env</code> y reinicie el servidor.</p>`,
      );
  }

  const cabecera = req.headers.authorization ?? '';
  const [tipo, credenciales] = cabecera.split(' ');

  if (tipo === 'Basic' && credenciales) {
    const [usuario, password] = Buffer.from(credenciales, 'base64').toString().split(':');
    const usuarioOk = igualSeguro(usuario, config.admin.usuario);
    const passwordOk = igualSeguro(password, config.admin.password);

    if (usuarioOk && passwordOk) return next();

    logger.warn(`Intento fallido de acceso al panel desde ${req.ip}.`);
  }

  res.set('WWW-Authenticate', 'Basic realm="Panel", charset="UTF-8"');
  return res.status(401).send('Se requiere autenticación.');
}

/**
 * Freno contra CSRF.
 *
 * Con Basic Auth el navegador manda las credenciales solas en cada petición,
 * así que un formulario en otra web podría dar de baja a un paciente sin que
 * el doctor se entere. Se exige que las peticiones que modifican datos vengan
 * de una página del propio panel.
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
