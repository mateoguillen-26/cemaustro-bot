/**
 * Contenido de cada pantalla del panel.
 * Reciben datos ya consultados y devuelven HTML; no tocan la base.
 */
import { config } from '../config.js';
import { esc, etiquetaNivel, requisitosDePassword, scriptDeRequisitos } from './vistas.js';
import { fechaCorta, diaCorto } from '../utils/datetime.js';
import { ETIQUETA_CONTEXTO, clasificar } from '../services/glucemias.js';
import { CATALOGO } from '../services/ajustes.js';

/* ------------------------------------------------------------------ */
/* Resumen                                                             */
/* ------------------------------------------------------------------ */

export function resumen(m, alertasAbiertas) {
  const tarjetas = [
    [m.pacientes, 'pacientes activos'],
    [m.verificados, 'números verificados'],
    [m.mensajes24h, 'mensajes en 24 h'],
    [m.alertasAbiertas, 'alertas sin revisar'],
    [m.lecturas7d, 'glucemias en 7 días'],
    [`${m.documentos}/${m.fragmentos}`, 'documentos / fragmentos'],
  ]
    .map(([valor, texto]) => `<div class="metrica"><b>${esc(valor)}</b><span>${esc(texto)}</span></div>`)
    .join('');

  const filas = alertasAbiertas
    .slice(0, 10)
    .map(
      (a) => `<tr>
        <td>${etiquetaNivel(a.level)}</td>
        <td><a href="/admin/pacientes/${a.patient_id}">${esc(a.patient_name)}</a></td>
        <td>${esc(a.reason)}</td>
        <td>${esc(fechaCorta(a.created_at))}</td>
      </tr>`,
    )
    .join('');

  return `
    <h1>Resumen</h1>
    <p class="sub">Cómo va el asistente hoy.</p>
    <div class="rejilla">${tarjetas}</div>

    <h2>Alertas sin revisar</h2>
    <div class="tarjeta">
      ${
        alertasAbiertas.length === 0
          ? '<p class="vacio">Nada pendiente. 👍</p>'
          : `<table><thead><tr><th>Nivel</th><th>Paciente</th><th>Motivo</th><th>Cuándo</th></tr></thead>
             <tbody>${filas}</tbody></table>
             <p style="margin:14px 0 0"><a href="/admin/alertas">Ver todas las alertas</a></p>`
      }
    </div>`;
}

/* ------------------------------------------------------------------ */
/* Pacientes                                                           */
/* ------------------------------------------------------------------ */

function estadoDelNumero(p) {
  if (!p.active) return '<span class="etiqueta et-gris">Inactivo</span>';
  if (!p.phone) return '<span class="etiqueta et-gris">Sin número</span>';
  const vigente =
    p.session_expires_at && !p.session_revoked_at && p.session_expires_at > new Date().toISOString();
  return vigente
    ? '<span class="etiqueta et-ok">Verificado</span>'
    : '<span class="etiqueta et-aviso">Sin verificar</span>';
}

export function pacientes(lista, busqueda) {
  const filas = lista
    .map(
      (p) => `<tr>
        <td><a href="/admin/pacientes/${p.id}">${esc(p.name)}</a></td>
        <td>${esc(p.cedula)}</td>
        <td>${p.phone ? `+${esc(p.phone)}` : '—'}</td>
        <td>${estadoDelNumero(p)}</td>
        <td>${esc(p.diabetes_type ?? '—')}</td>
        <td>${p.lecturas}</td>
        <td>${p.alertas_abiertas > 0 ? `<span class="etiqueta et-aviso">${p.alertas_abiertas}</span>` : '—'}</td>
      </tr>`,
    )
    .join('');

  return `
    <h1>Pacientes</h1>
    <p class="sub">Solo las personas de esta lista pueden usar el asistente.</p>

    <div class="tarjeta">
      <form method="get" class="barra">
        <div style="flex:1; min-width:220px">
          <label for="q">Buscar</label>
          <input type="text" id="q" name="q" value="${esc(busqueda)}" placeholder="Nombre, cédula o teléfono">
        </div>
        <button type="submit">Buscar</button>
        ${busqueda ? '<a href="/admin/pacientes" style="padding-bottom:10px">Limpiar</a>' : ''}
      </form>
    </div>

    <div class="tarjeta">
      ${
        lista.length === 0
          ? '<p class="vacio">No hay pacientes que mostrar.</p>'
          : `<table>
               <thead><tr><th>Nombre</th><th>Cédula</th><th>Teléfono</th><th>Número</th>
               <th>Tipo</th><th>Glucemias</th><th>Alertas</th></tr></thead>
               <tbody>${filas}</tbody>
             </table>`
      }
    </div>

    <h2>Agregar un paciente</h2>
    <div class="tarjeta">
      <form method="post" action="/admin/pacientes">
        <div class="barra">
          <div style="flex:1; min-width:200px">
            <label for="cedula">Cédula</label>
            <input type="text" id="cedula" name="cedula" required maxlength="10" placeholder="0102030405">
          </div>
          <div style="flex:2; min-width:240px">
            <label for="name">Nombre completo</label>
            <input type="text" id="name" name="name" required placeholder="María Elena Vásquez">
          </div>
        </div>
        <div class="barra">
          <div style="flex:1; min-width:200px">
            <label for="phone">Teléfono <small>Con código de país, sin +. Si lo pone, el paciente se verifica solo con su cédula.</small></label>
            <input type="text" id="phone" name="phone" placeholder="593987654321">
          </div>
          <div style="flex:1; min-width:180px">
            <label for="diabetes_type">Tipo de diabetes</label>
            <select id="diabetes_type" name="diabetes_type">
              <option value="">Sin especificar</option>
              <option value="1">Tipo 1</option>
              <option value="2">Tipo 2</option>
              <option value="gestacional">Gestacional</option>
              <option value="prediabetes">Prediabetes</option>
            </select>
          </div>
        </div>
        <button type="submit">Agregar paciente</button>
      </form>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* Ficha de un paciente                                                */
/* ------------------------------------------------------------------ */

/** Barras sencillas con las últimas mediciones, de la más vieja a la más nueva. */
function graficoGlucemias(lecturas) {
  if (lecturas.length === 0) return '';

  const orden = [...lecturas].reverse().slice(-40);
  const maximo = Math.max(...orden.map((l) => l.value_mgdl), 200);

  const barras = orden
    .map((l) => {
      const juicio = clasificar(l.value_mgdl, l.context);
      const clase = l.value_mgdl < config.glucemia.hipo ? 'baja' : juicio.nivel !== 'ninguna' ? 'alta' : '';
      const alto = Math.max(2, Math.round((l.value_mgdl / maximo) * 100));
      const titulo = `${l.value_mgdl} mg/dL · ${ETIQUETA_CONTEXTO[l.context] ?? ''} · ${diaCorto(l.measured_at)}`;
      return `<div class="${clase}" style="height:${alto}%" title="${esc(titulo)}"></div>`;
    })
    .join('');

  return `<div class="grafico">${barras}</div>
          <p class="sub" style="font-size:12px">Últimas ${orden.length} mediciones. Pase el cursor para ver el detalle.</p>`;
}

export function paciente({ paciente: p, lecturas, resumenGlucemias, conversacion, alertas, codigo, codigoPendiente }) {
  const bloqueCodigo = codigo
    ? `<div class="tarjeta" style="border-color:var(--acento)">
         <b>Código de vinculación para ${esc(p.name)}</b>
         <div class="codigo">${esc(codigo.codigo)}</div>
         <p class="sub" style="margin:0">
           Entrégueselo en persona. Vence el ${esc(fechaCorta(codigo.expira))}.
           <b>No se vuelve a mostrar</b>: si lo pierde, genere otro.
         </p>
       </div>`
    : '';

  const filasGlucemia = lecturas
    .slice(0, 30)
    .map((l) => {
      const juicio = clasificar(l.value_mgdl, l.context);
      // Si el paciente reportó una medición de antes ("anoche tuve 200"), se
      // muestran las dos horas: la de la medición manda para la tendencia,
      // pero el médico necesita ver que llegó después.
      const distintoDia = diaCorto(l.measured_at) !== diaCorto(l.created_at);
      return `<tr>
        <td><b>${l.value_mgdl}</b> mg/dL</td>
        <td>${esc(ETIQUETA_CONTEXTO[l.context] ?? l.context ?? '—')}</td>
        <td>${esc(fechaCorta(l.measured_at))}
            ${distintoDia ? `<br><span class="sub" style="font-size:12px">reportado el ${esc(fechaCorta(l.created_at))}</span>` : ''}</td>
        <td>${juicio.nivel === 'ninguna' ? '<span class="etiqueta et-ok">En rango</span>' : etiquetaNivel(juicio.nivel)}</td>
        <td>${esc(l.note ?? '')}</td>
      </tr>`;
    })
    .join('');

  const burbujas = [...conversacion]
    .reverse()
    .map(
      (m) => `<div class="burbuja ${m.role === 'user' ? 'paciente' : 'bot'}">${esc(m.content)}
        <time>${esc(fechaCorta(m.created_at))}</time></div>`,
    )
    .join('');

  const filasAlertas = alertas
    .map(
      (a) => `<tr>
        <td>${etiquetaNivel(a.level)}</td>
        <td>${esc(a.reason)}</td>
        <td>${esc(fechaCorta(a.created_at))}</td>
        <td>${a.resolved_at ? '<span class="etiqueta et-ok">Revisada</span>' : `<form method="post" action="/admin/alertas/${a.id}/resolver" class="enlinea"><button class="chico secundario">Marcar revisada</button></form>`}</td>
      </tr>`,
    )
    .join('');

  const promedio =
    resumenGlucemias.total > 0
      ? `${resumenGlucemias.total} mediciones en 14 días · promedio ${resumenGlucemias.promedio} mg/dL ` +
        `(mín. ${resumenGlucemias.minimo} · máx. ${resumenGlucemias.maximo})`
      : 'Todavía no ha reportado mediciones por el chat.';

  return `
    <p style="margin:0 0 6px"><a href="/admin/pacientes">← Pacientes</a></p>
    <h1>${esc(p.name)}</h1>
    <p class="sub">CI ${esc(p.cedula)} · ${p.phone ? `+${esc(p.phone)}` : 'sin número vinculado'} · ${estadoDelNumero(p)}</p>

    ${bloqueCodigo}

    <h2>Datos</h2>
    <div class="tarjeta">
      <form method="post" action="/admin/pacientes/${p.id}">
        <div class="barra">
          <div style="flex:2; min-width:240px">
            <label for="name">Nombre completo</label>
            <input type="text" id="name" name="name" value="${esc(p.name)}" required>
          </div>
          <div style="flex:1; min-width:200px">
            <label for="phone">Teléfono <small>Cambiarlo cierra la sesión actual.</small></label>
            <input type="text" id="phone" name="phone" value="${esc(p.phone ?? '')}" placeholder="593987654321">
          </div>
        </div>
        <div class="barra">
          <div style="flex:1; min-width:180px">
            <label for="diabetes_type">Tipo de diabetes</label>
            <select id="diabetes_type" name="diabetes_type">
              ${['', '1', '2', 'gestacional', 'prediabetes']
                .map((v) => {
                  const etiqueta =
                    v === '' ? 'Sin especificar' : v === '1' ? 'Tipo 1' : v === '2' ? 'Tipo 2' : v === 'gestacional' ? 'Gestacional' : 'Prediabetes';
                  return `<option value="${v}" ${p.diabetes_type === (v || null) ? 'selected' : ''}>${etiqueta}</option>`;
                })
                .join('')}
            </select>
          </div>
          <div style="flex:1; min-width:180px">
            <label for="active">Estado</label>
            <select id="active" name="active">
              <option value="1" ${p.active ? 'selected' : ''}>Activo</option>
              <option value="0" ${p.active ? '' : 'selected'}>Inactivo (el bot deja de responderle)</option>
            </select>
          </div>
        </div>
        <label for="notes">Notas para el asistente
          <small>Lo que escriba aquí lo lee el modelo en cada respuesta. Ej: "Usa insulina basal. Vive sola. Poca visión."</small>
        </label>
        <textarea id="notes" name="notes" style="min-height:80px">${esc(p.notes ?? '')}</textarea>
        <button type="submit">Guardar</button>
      </form>

      <hr style="border:0; border-top:1px solid var(--borde); margin:20px 0">
      <div class="barra">
        <form method="post" action="/admin/pacientes/${p.id}/codigo" class="enlinea">
          <button class="secundario" type="submit">Generar código de vinculación</button>
        </form>
        <form method="post" action="/admin/pacientes/${p.id}/revocar" class="enlinea">
          <button class="secundario" type="submit">Cerrar su sesión</button>
        </form>
      </div>
      <p class="sub" style="margin:10px 0 0; font-size:13px">
        ${
          codigoPendiente
            ? `Hay un código sin usar, vence el ${esc(fechaCorta(codigoPendiente))}. Generar otro anula el anterior.`
            : 'El código hace falta cuando el paciente escribe desde un número que usted no registró.'
        }
      </p>
    </div>

    <h2>Glucemias</h2>
    <div class="tarjeta">
      <p class="sub" style="margin:0">${esc(promedio)}</p>
      ${graficoGlucemias(lecturas)}
      ${
        lecturas.length === 0
          ? ''
          : `<table><thead><tr><th>Valor</th><th>Contexto</th><th>Cuándo</th><th></th><th>Nota</th></tr></thead>
             <tbody>${filasGlucemia}</tbody></table>`
      }
      <p class="sub" style="font-size:12px; margin:12px 0 0">
        Son valores que el propio paciente reportó por el chat, no de laboratorio.
      </p>
    </div>

    <h2>Alertas</h2>
    <div class="tarjeta">
      ${
        alertas.length === 0
          ? '<p class="vacio">Ninguna alerta de este paciente.</p>'
          : `<table><thead><tr><th>Nivel</th><th>Motivo</th><th>Cuándo</th><th></th></tr></thead>
             <tbody>${filasAlertas}</tbody></table>`
      }
    </div>

    <h2>Conversación</h2>
    <div class="tarjeta">
      ${conversacion.length === 0 ? '<p class="vacio">Todavía no ha escrito.</p>' : `<div class="chat">${burbujas}</div>`}
    </div>`;
}

/* ------------------------------------------------------------------ */
/* Alertas                                                             */
/* ------------------------------------------------------------------ */

export function listaAlertas(lista, soloAbiertas) {
  const filas = lista
    .map(
      (a) => `<tr>
        <td>${etiquetaNivel(a.level)}</td>
        <td><a href="/admin/pacientes/${a.patient_id}">${esc(a.patient_name)}</a><br>
            <span class="sub" style="font-size:12px">CI ${esc(a.patient_cedula)}</span></td>
        <td>${esc(a.reason)}${a.excerpt ? `<br><span class="sub" style="font-size:12px">"${esc(a.excerpt)}"</span>` : ''}</td>
        <td>${esc(fechaCorta(a.created_at))}</td>
        <td>${a.notified_at ? `<span class="etiqueta et-ok">Avisado</span>` : '<span class="etiqueta et-gris">Solo panel</span>'}</td>
        <td>${
          a.resolved_at
            ? '<span class="etiqueta et-ok">Revisada</span>'
            : `<form method="post" action="/admin/alertas/${a.id}/resolver" class="enlinea"><button class="chico secundario">Marcar revisada</button></form>`
        }</td>
      </tr>`,
    )
    .join('');

  return `
    <h1>Alertas</h1>
    <p class="sub">Lo que el asistente marcó para que usted lo mire.</p>

    <div class="tarjeta">
      <div class="barra" style="margin-bottom:12px">
        <a href="/admin/alertas" ${soloAbiertas ? '' : 'style="font-weight:700"'}>Todas</a>
        <a href="/admin/alertas?abiertas=1" ${soloAbiertas ? 'style="font-weight:700"' : ''}>Sin revisar</a>
      </div>
      ${
        lista.length === 0
          ? '<p class="vacio">No hay alertas.</p>'
          : `<table><thead><tr><th>Nivel</th><th>Paciente</th><th>Motivo</th><th>Cuándo</th><th>Aviso</th><th></th></tr></thead>
             <tbody>${filas}</tbody></table>`
      }
    </div>`;
}

/* ------------------------------------------------------------------ */
/* Base de conocimiento                                                */
/* ------------------------------------------------------------------ */

export function conocimiento(documentos) {
  const filas = documentos
    .map(
      (d) => `<tr>
        <td><b>${esc(d.title)}</b>${d.source ? `<br><span class="sub" style="font-size:12px">${esc(d.source)}</span>` : ''}</td>
        <td>${d.caracteres.toLocaleString('es-EC')} caracteres</td>
        <td>${d.fragmentos > 0 ? `${d.fragmentos} fragmentos` : '<span class="etiqueta et-aviso">Sin indexar</span>'}</td>
        <td>${d.active ? '<span class="etiqueta et-ok">En uso</span>' : '<span class="etiqueta et-gris">Apagado</span>'}</td>
        <td>${esc(fechaCorta(d.created_at))}</td>
        <td>
          <form method="post" action="/admin/conocimiento/${d.id}/activar" class="enlinea">
            <input type="hidden" name="activo" value="${d.active ? '0' : '1'}">
            <button class="chico secundario">${d.active ? 'Apagar' : 'Encender'}</button>
          </form>
          <form method="post" action="/admin/conocimiento/${d.id}/reindexar" class="enlinea">
            <button class="chico secundario">Reindexar</button>
          </form>
          <form method="post" action="/admin/conocimiento/${d.id}/borrar" class="enlinea"
                onsubmit="return confirm('¿Borrar este documento? El asistente dejará de usarlo.')">
            <button class="chico peligro">Borrar</button>
          </form>
        </td>
      </tr>`,
    )
    .join('');

  return `
    <h1>Base de conocimiento</h1>
    <p class="sub">
      Sus guías y protocolos. El asistente busca aquí primero y sigue estos criterios
      aunque difieran de lo que sabría por su cuenta.
    </p>

    <div class="tarjeta">
      ${
        documentos.length === 0
          ? '<p class="vacio">Todavía no hay documentos. Mientras tanto el asistente responde con criterio general.</p>'
          : `<table><thead><tr><th>Título</th><th>Tamaño</th><th>Índice</th><th>Estado</th><th>Subido</th><th></th></tr></thead>
             <tbody>${filas}</tbody></table>`
      }
    </div>

    <h2>Subir un archivo</h2>
    <div class="tarjeta">
      <form method="post" action="/admin/conocimiento/subir" enctype="multipart/form-data">
        <label for="archivo">Archivo
          <small>PDF, Word (.docx), .txt o .md. Hasta 15 MB.
          Antes de guardarlo verá el texto que se leyó, para revisarlo.</small>
        </label>
        <input type="file" id="archivo" name="archivo" accept=".pdf,.docx,.txt,.md" required>
        <button type="submit">Leer el archivo</button>
      </form>
      <p class="sub" style="font-size:13px; margin:14px 0 0">
        Un PDF <b>escaneado</b> no lleva texto por dentro, solo una imagen de la página:
        de esos no se puede leer nada y habrá que copiar el texto a mano.
      </p>
    </div>

    <h2>O pegar el texto</h2>
    <div class="tarjeta">
      <form method="post" action="/admin/conocimiento">
        <div class="barra">
          <div style="flex:2; min-width:240px">
            <label for="titulo">Título</label>
            <input type="text" id="titulo" name="titulo" required placeholder="Plan de alimentación del consultorio">
          </div>
          <div style="flex:1; min-width:200px">
            <label for="fuente">Fuente <small>Opcional: guía, año, autor.</small></label>
            <input type="text" id="fuente" name="fuente" placeholder="ADA 2025, adaptada">
          </div>
        </div>
        <label for="contenido">Contenido
          <small>Pegue el texto. Separe los temas con una línea en blanco: así se parte mejor y se busca mejor.</small>
        </label>
        <textarea id="contenido" name="contenido" required style="min-height:220px"></textarea>
        <button type="submit">Guardar e indexar</button>
      </form>
      <p class="sub" style="font-size:13px; margin:14px 0 0">
        También puede dejar archivos <code>.md</code> o <code>.txt</code> en la carpeta
        <code>docs/</code> y correr <code>npm run importar-docs</code>.
      </p>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* Configuración                                                       */
/* ------------------------------------------------------------------ */

export function configuracion(valores) {
  const campos = CATALOGO.map((a) => {
    const valor = valores[a.clave];
    const ayuda = a.ayuda ? `<small>${esc(a.ayuda)}</small>` : '';

    let campo;
    if (a.tipo === 'texto_largo') {
      campo = `<textarea name="valor" style="min-height:420px">${esc(valor.valor)}</textarea>`;
    } else if (a.tipo === 'numero') {
      campo = `<input type="number" name="valor" value="${esc(valor.valor)}" min="${a.minimo ?? ''}" max="${a.maximo ?? ''}">`;
    } else if (a.tipo === 'si_no') {
      campo = `<select name="valor">
                 <option value="1" ${valor.valor ? 'selected' : ''}>Sí</option>
                 <option value="0" ${valor.valor ? '' : 'selected'}>No</option>
               </select>`;
    } else {
      campo = `<input type="text" name="valor" value="${esc(valor.valor)}">`;
    }

    return `<div class="tarjeta">
      <form method="post" action="/admin/configuracion">
        <input type="hidden" name="clave" value="${esc(a.clave)}">
        <label>${esc(a.etiqueta)} ${ayuda}</label>
        ${campo}
        <div class="barra">
          <button type="submit">Guardar</button>
          ${
            valor.personalizado
              ? `<button type="submit" name="restaurar" value="1" class="secundario">Restaurar el de fábrica</button>`
              : '<span class="sub" style="font-size:13px; padding-bottom:12px">Valor de fábrica</span>'
          }
        </div>
      </form>
    </div>`;
  }).join('');

  return `
    <h1>Configuración</h1>
    <p class="sub">Cambia al instante, sin reiniciar el servidor.</p>
    ${campos}`;
}

/* ------------------------------------------------------------------ */
/* Seguridad                                                           */
/* ------------------------------------------------------------------ */

export function seguridad(intentos, incidencias, advertencias) {
  const filas = intentos
    .map(
      (i) => `<tr>
        <td>${i.outcome === 'ok' ? '<span class="etiqueta et-ok">Verificado</span>' : '<span class="etiqueta et-urgente">Fallido</span>'}</td>
        <td>+${esc(i.phone)}</td>
        <td>${esc(i.cedula_masked ?? '—')}</td>
        <td>${esc(i.reason ?? '')}</td>
        <td>${esc(fechaCorta(i.created_at))}</td>
      </tr>`,
    )
    .join('');

  const filasIncidencias = incidencias
    .map(
      (i) => `<tr>
        <td>${i.nivel === 'ERROR' ? '<span class="etiqueta et-urgente">Error</span>' : '<span class="etiqueta et-aviso">Aviso</span>'}</td>
        <td>${esc(i.mensaje)}${i.detalle ? `<br><span class="sub" style="font-size:12px">${esc(i.detalle)}</span>` : ''}</td>
        <td>${esc(fechaCorta(i.cuando))}</td>
      </tr>`,
    )
    .join('');

  const listaAdvertencias = advertencias
    .map((a) => `<li>${esc(a)}</li>`)
    .join('');

  return `
    <h1>Seguridad</h1>
    <p class="sub">Quién intentó entrar y qué le está fallando al servidor.</p>

    ${
      advertencias.length > 0
        ? `<div class="aviso aviso-error">
             <b>Revise la configuración:</b>
             <ul style="margin:8px 0 0; padding-left:20px">${listaAdvertencias}</ul>
           </div>`
        : '<div class="aviso aviso-ok">La configuración de seguridad está completa.</div>'
    }

    <h2>Intentos de verificación</h2>
    <div class="tarjeta">
      ${
        intentos.length === 0
          ? '<p class="vacio">Nadie ha intentado verificarse todavía.</p>'
          : `<table><thead><tr><th>Resultado</th><th>Teléfono</th><th>Cédula</th><th>Detalle</th><th>Cuándo</th></tr></thead>
             <tbody>${filas}</tbody></table>`
      }
      <p class="sub" style="font-size:12px; margin:12px 0 0">
        Tras ${config.auth.maxIntentos} fallos, el número queda bloqueado ${config.auth.minutosDeBloqueo} minutos.
      </p>
    </div>

    <h2>Avisos y errores recientes</h2>
    <div class="tarjeta">
      ${
        incidencias.length === 0
          ? '<p class="vacio">Nada que reportar.</p>'
          : `<table><thead><tr><th>Nivel</th><th>Qué pasó</th><th>Cuándo</th></tr></thead>
             <tbody>${filasIncidencias}</tbody></table>`
      }
      <p class="sub" style="font-size:12px; margin:12px 0 0">
        Solo lo ocurrido desde el último reinicio. No incluye datos de pacientes.
      </p>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* Mi cuenta                                                           */
/* ------------------------------------------------------------------ */

export function cuenta(usuario) {
  return `
    <h1>Mi cuenta</h1>
    <p class="sub">
      Su usuario es <code>${esc(usuario.username)}</code> y entra como
      <b>${usuario.role === 'administrador' ? 'administrador' : 'doctor'}</b>.
      ${
        usuario.role === 'administrador'
          ? 'Ve y puede cambiar todo el panel.'
          : 'Ve pacientes, alertas y conocimiento. La configuración del asistente la lleva un administrador.'
      }
    </p>

    <h2>Nombre de usuario</h2>
    <div class="tarjeta">
      <form method="post" action="/admin/cuenta/usuario">
        <label for="nuevo">Con qué nombre entra al panel
          <small>Entre 3 y 40 caracteres: letras sin tilde, números, punto, guion
          o guion bajo. Es solo su identificador de entrada, no cambia lo que puede hacer.</small>
        </label>
        <input type="text" id="nuevo" name="nuevo" value="${esc(usuario.username)}"
               autocapitalize="off" autocorrect="off" maxlength="40" required>

        <label for="clave-usuario">Su contraseña actual
          <small>Para confirmar que es usted quien lo cambia.</small>
        </label>
        <input type="password" id="clave-usuario" name="password" autocomplete="current-password" required>

        <button type="submit">Cambiar el nombre de usuario</button>
      </form>
    </div>

    <h2>Contraseña</h2>
    <div class="tarjeta">
      <form method="post" action="/admin/cuenta">
        <label for="actual">Contraseña actual</label>
        <input type="password" id="actual" name="actual" autocomplete="current-password" required>

        <label for="nueva">Contraseña nueva
          <small>Al menos 12 caracteres. Una frase que solo usted recuerde es más
          segura y más fácil que una sopa de símbolos.</small>
        </label>
        <input type="password" id="nueva" name="nueva" autocomplete="new-password" required>

        <label for="repetida">Repita la contraseña nueva</label>
        <input type="password" id="repetida" name="repetida" autocomplete="new-password" required>

        ${requisitosDePassword({ usuario: usuario.username, conRepetir: true, conActual: true })}

        <button type="submit">Cambiar la contraseña</button>
      </form>
      <p class="sub" style="font-size:13px; margin:14px 0 0">
        Al cambiarla se cierran las sesiones abiertas en otros navegadores.
      </p>
    </div>

    <h2>Su nombre</h2>
    <div class="tarjeta">
      <form method="post" action="/admin/cuenta/nombre">
        <label for="nombre">Cómo aparece en el panel
          <small>Solo se usa para saludarle arriba a la derecha.</small>
        </label>
        <input type="text" id="nombre" name="nombre" value="${esc(usuario.name ?? '')}"
               placeholder="Dr. Juan Pérez" maxlength="80">
        <button type="submit" class="secundario">Guardar</button>
      </form>
    </div>
    ${scriptDeRequisitos()}`;
}

/* ------------------------------------------------------------------ */
/* Usuarios del panel                                                  */
/* ------------------------------------------------------------------ */

export function usuarios(lista, yo) {
  const filas = lista
    .map((u) => {
      const esYo = u.id === yo.id;
      const esAdmin = u.role === 'administrador';
      const estado = u.active
        ? '<span class="etiqueta et-ok">Activo</span>'
        : '<span class="etiqueta et-gris">Sin acceso</span>';

      // Cambiarse el papel a uno mismo es perder el acceso a esta página.
      const papel = esYo
        ? `<span class="etiqueta ${esAdmin ? 'et-ok' : 'et-gris'}">${esAdmin ? 'Administrador' : 'Doctor'}</span>`
        : `<form method="post" action="/admin/usuarios/${u.id}/rol" class="enlinea">
             <input type="hidden" name="rol" value="${esAdmin ? 'doctor' : 'administrador'}">
             <button type="submit" class="chico secundario">
               ${esAdmin ? 'Administrador ▾' : 'Doctor ▾'}
             </button>
           </form>`;

      // Nadie puede quitarse el acceso a sí mismo: sería la forma más rápida
      // de quedarse fuera del panel sin manera de volver a entrar.
      const accion = esYo
        ? '<span class="sub" style="font-size:13px">Es usted</span>'
        : `<form method="post" action="/admin/usuarios/${u.id}/acceso" class="enlinea">
             <input type="hidden" name="activo" value="${u.active ? '0' : '1'}">
             <button type="submit" class="chico ${u.active ? 'peligro' : 'secundario'}">
               ${u.active ? 'Quitar acceso' : 'Devolver acceso'}
             </button>
           </form>`;

      // La propia contraseña se cambia desde "Mi cuenta", donde se pide la
      // actual. Aquí solo se restablece la de los demás.
      const restablecer = esYo
        ? ''
        : `<a href="/admin/usuarios/${u.id}/password" class="boton chico secundario">Contraseña</a>`;

      return `<tr>
        <td><b>${esc(u.username)}</b></td>
        <td>${esc(u.name ?? '—')}</td>
        <td>${papel}</td>
        <td>${estado}</td>
        <td>${esc(u.last_login_at ? fechaCorta(u.last_login_at) : 'Nunca ha entrado')}</td>
        <td class="acciones">${restablecer} ${accion}</td>
      </tr>`;
    })
    .join('');

  return `
    <h1>Usuarios</h1>
    <p class="sub">Quién puede entrar al panel y hasta dónde llega.</p>

    <div class="tarjeta">
      <table>
        <thead>
          <tr><th>Usuario</th><th>Nombre</th><th>Papel</th><th>Estado</th><th>Última entrada</th><th></th></tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>
      <p class="sub" style="font-size:13px; margin:14px 0 0">
        El botón del papel lo cambia al otro. <b>Administrador</b> ve todo.
        <b>Doctor</b> ve pacientes, alertas y conocimiento, pero no la configuración
        del asistente, ni los usuarios, ni la seguridad.
        Si alguien olvida su contraseña, <b>Contraseña</b> le pone una nueva.
      </p>
    </div>

    <h2>Crear un usuario</h2>
    <div class="tarjeta">
      <form method="post" action="/admin/usuarios">
        <label for="nuevo-usuario">Usuario
          <small>Sin espacios ni tildes. Por ejemplo: <code>dr.perez</code></small>
        </label>
        <input type="text" id="nuevo-usuario" name="usuario" autocapitalize="off"
               autocorrect="off" maxlength="40" required>

        <label for="nuevo-nombre">Nombre <small>Opcional, para reconocerlo de un vistazo.</small></label>
        <input type="text" id="nuevo-nombre" name="nombre" placeholder="Dr. Juan Pérez" maxlength="80">

        <label for="nuevo-rol">Papel</label>
        <select id="nuevo-rol" name="rol">
          <option value="doctor" selected>Doctor — pacientes, alertas y conocimiento</option>
          <option value="administrador">Administrador — además configuración, usuarios y seguridad</option>
        </select>

        <label for="nueva-password">Contraseña provisional
          <small>Al menos 12 caracteres. Entréguesela en persona y pídale que la
          cambie desde "Mi cuenta" en cuanto entre.</small>
        </label>
        <input type="password" id="nueva-password" name="password" autocomplete="new-password" required>

        ${requisitosDePassword()}

        <button type="submit">Crear</button>
      </form>
    </div>
    ${scriptDeRequisitos()}`;
}

/* ------------------------------------------------------------------ */
/* Restablecer la contraseña de otro usuario                           */
/* ------------------------------------------------------------------ */

export function restablecerPassword(objetivo) {
  const quien = objetivo.name
    ? `${esc(objetivo.name)} (<code>${esc(objetivo.username)}</code>)`
    : `<code>${esc(objetivo.username)}</code>`;

  return `
    <h1>Restablecer contraseña</h1>
    <p class="sub">
      Para ${quien}. No hace falta saber la contraseña anterior: se reemplaza por
      la que escriba aquí y sus sesiones abiertas se cierran.
    </p>

    <div class="tarjeta">
      <form method="post" action="/admin/usuarios/${objetivo.id}/password">
        <label for="password">Contraseña provisional
          <small>Al menos 12 caracteres. Entréguesela en persona y pídale que la
          cambie desde "Mi cuenta" en cuanto entre.</small>
        </label>
        <input type="password" id="password" name="password" autocomplete="new-password" required autofocus>

        ${requisitosDePassword({ usuario: objetivo.username })}

        <button type="submit">Restablecer</button>
        <a href="/admin/usuarios" class="boton secundario">Cancelar</a>
      </form>
    </div>
    ${scriptDeRequisitos()}`;
}

/* ------------------------------------------------------------------ */
/* Revisar un documento recién leído de un archivo                     */
/* ------------------------------------------------------------------ */

export function revisarDocumento({ titulo, fuente, contenido }) {
  const parrafos = contenido.split(/\n\s*\n/).filter(Boolean).length;
  const palabras = contenido.split(/\s+/).filter(Boolean).length;

  return `
    <h1>Revisar antes de guardar</h1>
    <p class="sub">
      Esto es lo que se leyó de <b>${esc(fuente)}</b>: ${palabras.toLocaleString('es')} palabras
      en ${parrafos} párrafo(s). Todavía no se ha guardado nada.
    </p>

    <div class="tarjeta">
      <form method="post" action="/admin/conocimiento">
        <label for="titulo">Título
          <small>Con esto lo reconocerá después. Sea descriptivo: "Hipoglucemia: regla del 15", no "Guía 1".</small>
        </label>
        <input type="text" id="titulo" name="titulo" value="${esc(titulo)}" required maxlength="120">

        <input type="hidden" name="fuente" value="${esc(fuente)}">

        <label for="contenido">Texto
          <small>Repase por encima y corrija lo que haya salido torcido. Deje una
          línea en blanco entre temas: el texto se parte por párrafos, y si todo
          va en un bloque los fragmentos salen mezclados.</small>
        </label>
        <textarea id="contenido" name="contenido" style="min-height:420px" required>${esc(contenido)}</textarea>

        <div class="barra">
          <button type="submit">Guardar e indexar</button>
          <a href="/admin/conocimiento" style="padding-bottom:10px">Descartar</a>
        </div>
      </form>
    </div>`;
}
