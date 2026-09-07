/**
 * Plantilla y piezas sueltas del panel.
 *
 * Es HTML escrito a mano a propósito: el panel lo usa el doctor desde el
 * consultorio, no necesita un framework ni un paso de compilación, y así el
 * proyecto se despliega con `npm start` y nada más.
 */
import { config } from '../config.js';

/** Escapa texto antes de meterlo en el HTML. Todo lo que venga de la base pasa por aquí. */
export function esc(valor) {
  return String(valor ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const ESTILOS = `
  :root {
    --fondo: #f6f7f9;
    --tarjeta: #ffffff;
    --borde: #e3e6ea;
    --texto: #1b1f24;
    --suave: #667085;
    --acento: #12715f;
    --acento-claro: #e7f3f0;
    --urgente: #b42318;
    --urgente-claro: #fef3f2;
    --aviso: #b54708;
    --aviso-claro: #fffaeb;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--fondo);
    color: var(--texto);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  header {
    background: var(--tarjeta);
    border-bottom: 1px solid var(--borde);
    padding: 0 24px;
    position: sticky; top: 0; z-index: 10;
  }
  header .marca { font-weight: 700; padding: 16px 0 8px; font-size: 17px; }
  header .marca small { font-weight: 400; color: var(--suave); margin-left: 8px; font-size: 13px; }
  nav { display: flex; gap: 4px; flex-wrap: wrap; }
  nav a {
    padding: 8px 12px; border-radius: 6px 6px 0 0; text-decoration: none;
    color: var(--suave); font-size: 14px; border-bottom: 2px solid transparent;
  }
  nav a:hover { background: var(--fondo); color: var(--texto); }
  nav a.activo { color: var(--acento); border-bottom-color: var(--acento); font-weight: 600; }
  main { max-width: 1080px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 28px 0 12px; }
  p.sub { color: var(--suave); margin: 0 0 20px; }
  .tarjeta {
    background: var(--tarjeta); border: 1px solid var(--borde);
    border-radius: 10px; padding: 18px; margin-bottom: 18px;
  }
  .rejilla { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
  .metrica { background: var(--tarjeta); border: 1px solid var(--borde); border-radius: 10px; padding: 14px 16px; }
  .metrica b { display: block; font-size: 26px; line-height: 1.2; }
  .metrica span { color: var(--suave); font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--borde); vertical-align: top; }
  th { color: var(--suave); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
  tr:last-child td { border-bottom: none; }
  a { color: var(--acento); }
  .etiqueta {
    display: inline-block; padding: 2px 8px; border-radius: 999px;
    font-size: 12px; font-weight: 600; white-space: nowrap;
  }
  .et-ok { background: var(--acento-claro); color: var(--acento); }
  .et-urgente { background: var(--urgente-claro); color: var(--urgente); }
  .et-aviso { background: var(--aviso-claro); color: var(--aviso); }
  .et-gris { background: #eef0f3; color: var(--suave); }
  label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 4px; }
  label small { display: block; font-weight: 400; color: var(--suave); margin-top: 2px; }
  input[type=text], input[type=number], select, textarea {
    width: 100%; padding: 9px 11px; border: 1px solid var(--borde);
    border-radius: 7px; font: inherit; background: #fff;
  }
  textarea { min-height: 120px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  button {
    background: var(--acento); color: #fff; border: 0; padding: 9px 16px;
    border-radius: 7px; font: inherit; font-weight: 600; cursor: pointer; margin-top: 14px;
  }
  button:hover { filter: brightness(1.08); }
  button.secundario { background: #fff; color: var(--texto); border: 1px solid var(--borde); }
  button.peligro { background: var(--urgente); }
  button.chico { padding: 5px 10px; font-size: 13px; margin: 0; }
  form.enlinea { display: inline; }
  .aviso { padding: 12px 14px; border-radius: 8px; margin-bottom: 18px; font-size: 14px; }
  .aviso-ok { background: var(--acento-claro); color: var(--acento); }
  .aviso-error { background: var(--urgente-claro); color: var(--urgente); }
  .codigo {
    font: 700 30px ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: .18em; padding: 14px 0; text-align: center;
  }
  .chat { max-height: 460px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
  .burbuja { padding: 8px 12px; border-radius: 12px; max-width: 78%; font-size: 14px; white-space: pre-wrap; }
  .burbuja.paciente { background: #eef0f3; align-self: flex-start; border-bottom-left-radius: 3px; }
  .burbuja.bot { background: var(--acento-claro); align-self: flex-end; border-bottom-right-radius: 3px; }
  .burbuja time { display: block; font-size: 11px; color: var(--suave); margin-top: 3px; }
  .vacio { color: var(--suave); font-style: italic; padding: 12px 0; }
  .barra { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
  .barra > * { margin: 0; }
  .grafico { display: flex; align-items: flex-end; gap: 3px; height: 90px; margin: 12px 0 4px; }
  .grafico div { flex: 1; background: var(--acento); border-radius: 2px 2px 0 0; min-height: 2px; }
  .grafico div.alta { background: var(--aviso); }
  .grafico div.baja { background: var(--urgente); }
  code { background: #eef0f3; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
  input[type=password] {
    width: 100%; padding: 9px 11px; border: 1px solid var(--borde);
    border-radius: 7px; font: inherit; background: #fff;
  }
  header .fila { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  .sesion { display: flex; align-items: center; gap: 10px; padding: 14px 0 0; font-size: 13px; }
  .sesion .quien { color: var(--suave); }
  .sesion .quien b { color: var(--texto); font-weight: 600; }
  .sesion form { margin: 0; }
  .sesion button { margin: 0; }
  /* --- Pantalla de entrada --- */
  .entrada { max-width: 380px; margin: 0 auto; padding: 8vh 24px 24px; }
  .entrada .marca-grande { font-size: 21px; font-weight: 700; margin-bottom: 4px; }
  .entrada .marca-grande small { display: block; font-weight: 400; color: var(--suave); font-size: 13px; margin-top: 2px; }
  .entrada .tarjeta { margin-top: 20px; }
  .entrada button { width: 100%; margin-top: 20px; padding: 11px; }
  .entrada label:first-of-type { margin-top: 0; }
  .pie-entrada { color: var(--suave); font-size: 12.5px; text-align: center; margin-top: 18px; line-height: 1.5; }
`;

const SECCIONES = [
  { ruta: '/admin', etiqueta: 'Resumen' },
  { ruta: '/admin/pacientes', etiqueta: 'Pacientes' },
  { ruta: '/admin/alertas', etiqueta: 'Alertas' },
  { ruta: '/admin/conocimiento', etiqueta: 'Conocimiento' },
  { ruta: '/admin/configuracion', etiqueta: 'Configuración', soloAdmin: true },
  { ruta: '/admin/usuarios', etiqueta: 'Usuarios', soloAdmin: true },
  { ruta: '/admin/seguridad', etiqueta: 'Seguridad', soloAdmin: true },
];

/** Envuelve el contenido en la plantilla del panel. */
export function pagina({ titulo, activo, contenido, aviso = null, usuario = null }) {
  // Al doctor no se le enseñan las secciones que no puede abrir: un menú con
  // puertas cerradas solo invita a empujarlas. El guardia del router es quien
  // de verdad las protege; esto es cortesía, no seguridad.
  const esAdmin = usuario?.role === 'administrador';

  const menu = SECCIONES.filter((s) => esAdmin || !s.soloAdmin)
    .map(
      (s) =>
        `<a href="${s.ruta}" class="${s.ruta === activo ? 'activo' : ''}">${esc(s.etiqueta)}</a>`,
    )
    .join('');

  const banda = aviso
    ? `<div class="aviso aviso-${aviso.tipo === 'error' ? 'error' : 'ok'}">${esc(aviso.texto)}</div>`
    : '';

  const sesion = usuario
    ? `<div class="sesion">
         <span class="quien"><b>${esc(usuario.name || usuario.username)}</b></span>
         <a href="/admin/cuenta">Mi cuenta</a>
         <form method="post" action="/admin/salir">
           <button class="secundario chico" type="submit">Salir</button>
         </form>
       </div>`
    : '';

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${esc(titulo)} · ${esc(config.clinica.nombre)}</title>
  <style>${ESTILOS}</style>
</head>
<body>
  <header>
    <div class="fila">
      <div>
        <div class="marca">${esc(config.clinica.nombre)}<small>asistente de diabetes</small></div>
        <nav>${menu}</nav>
      </div>
      ${sesion}
    </div>
  </header>
  <main>${banda}${contenido}</main>
</body>
</html>`;
}

/**
 * Pantalla de entrada. Va aparte de `pagina()` a propósito: sin menú ni
 * cabecera, porque quien la ve todavía no ha demostrado quién es y no tiene
 * por qué ver siquiera qué secciones existen.
 */
export function paginaEntrar({ aviso = null, usuario = '' } = {}) {
  const banda = aviso
    ? `<div class="aviso aviso-${aviso.tipo === 'error' ? 'error' : 'ok'}">${esc(aviso.texto)}</div>`
    : '';

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Entrar · ${esc(config.clinica.nombre)}</title>
  <style>${ESTILOS}</style>
</head>
<body>
  <div class="entrada">
    <div class="marca-grande">
      ${esc(config.clinica.nombre)}
      <small>panel del asistente de diabetes</small>
    </div>
    ${banda}
    <form method="post" action="/admin/entrar" class="tarjeta">
      <label for="usuario">Usuario</label>
      <input type="text" id="usuario" name="usuario" value="${esc(usuario)}"
             autocomplete="username" autocapitalize="off" autocorrect="off" required autofocus>

      <label for="password">Contraseña</label>
      <input type="password" id="password" name="password"
             autocomplete="current-password" required>

      <button type="submit">Entrar</button>
    </form>
    <p class="pie-entrada">
      Esta página muestra datos de salud de pacientes.<br>
      Cierre la sesión si deja el computador solo.
    </p>
  </div>
</body>
</html>`;
}

/** Etiqueta de color según el nivel de una alerta. */
export function etiquetaNivel(nivel) {
  if (nivel === 'urgente') return '<span class="etiqueta et-urgente">Urgente</span>';
  if (nivel === 'aviso') return '<span class="etiqueta et-aviso">Aviso</span>';
  return '<span class="etiqueta et-gris">—</span>';
}

/** Tabla vacía con un mensaje decente en lugar de una tabla en blanco. */
export function siVacio(filas, mensaje) {
  return filas.length === 0 ? `<p class="vacio">${esc(mensaje)}</p>` : null;
}
