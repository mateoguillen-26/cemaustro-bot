/**
 * Restablece la contraseña de un usuario del panel desde el servidor.
 *
 *   npm run restablecer-password -- jefe
 *   npm run restablecer-password -- jefe 'una contraseña nueva y larga'
 *
 * Es la salida de emergencia para cuando el único administrador olvida la
 * suya: dentro del panel nadie puede restablecérsela. Hace falta acceso a la
 * máquina donde corre el bot, y eso es a propósito.
 *
 * Si no se indica contraseña, se inventa una al azar y se muestra una sola
 * vez. Las sesiones que ese usuario tuviera abiertas se cierran solas.
 */
import { randomBytes } from 'node:crypto';
import { cerrarDB } from '../db/database.js';
import { ejecutarMigraciones } from '../db/migrations.js';
import * as db from '../db/queries.js';
import { problemaConLaPassword, resumirPassword } from '../admin/auth.js';

/** Sin caracteres que se confundan al dictarla (0/O, 1/l/I). */
function inventarPassword() {
  const letras = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  return Array.from(bytes, (b) => letras[b % letras.length]).join('');
}

function restablecer() {
  const [usuario, indicada] = process.argv.slice(2);

  if (!usuario) {
    console.error('Uso: npm run restablecer-password -- <usuario> [contraseña nueva]');
    process.exit(1);
  }

  ejecutarMigraciones();

  const objetivo = db.usuarioPanelPorNombre(usuario.trim().toLowerCase());
  if (!objetivo) {
    const nombres = db.listarUsuariosPanel().map((u) => u.username).join(', ') || '(ninguno)';
    console.error(`No existe el usuario "${usuario}". Los que hay: ${nombres}.`);
    process.exit(1);
  }

  const password = indicada ?? inventarPassword();
  const problema = problemaConLaPassword(password, { usuario: objetivo.username });
  if (problema) {
    console.error(problema);
    process.exit(1);
  }

  db.cambiarPasswordPanel(objetivo.id, resumirPassword(password));

  console.log(`Contraseña de "${objetivo.username}" restablecida.`);
  if (!indicada) console.log(`Contraseña provisional: ${password}`);
  console.log('Sus sesiones abiertas quedaron cerradas. Pídale que la cambie desde "Mi cuenta".');
  if (!objetivo.active) {
    console.log('Ojo: ese usuario está sin acceso. Un administrador tiene que devolvérselo desde Usuarios.');
  }
}

try {
  restablecer();
} catch (error) {
  console.error('No se pudo restablecer:', error.message);
  process.exit(1);
} finally {
  cerrarDB();
}
