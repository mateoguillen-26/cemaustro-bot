# Caso 01/10/2026 — Paciente verificado que pierde el acceso tras un cambio de teléfono

> Sin datos personales a propósito: este repositorio no es lugar para ellos.
> El paciente es "el paciente"; los teléfonos y cédulas van como los muestra
> el panel (últimos dígitos). Los datos completos están en su ficha.

## Síntoma

En el panel, el paciente aparecía como **Sin verificar**, pero tenía historial
de conversación (preguntas sobre comidas). La pregunta era cómo podía tener
conversación sin estar verificado.

## Lo que hay que saber antes

- **Solo se guarda la conversación de números verificados.** Si un paciente
  tiene historial, en algún momento estuvo verificado.
- **"Verificado" es el estado de la sesión de ahora, no del pasado.** El panel
  dice Verificado si la sesión sigue abierta (ni cerrada ni vencida). Cuando la
  sesión se cierra, la conversación se queda.
- **Las sesiones duran 90 días** (`AUTH_SESSION_DAYS`). Ninguna podía haber
  vencido todavía.
- **Se entra solo con la cédula** si se escribe desde el teléfono registrado
  en la ficha. Desde otro número hace falta un código de vinculación.
- **Cambiar el teléfono en la ficha cierra la sesión** en ese mismo momento
  (`src/admin/router.js`), a propósito: el número viejo deja de tener acceso.
- **Un "salir" no deja rastro en la conversación**: se cierra la sesión y no
  se guarda el mensaje.

## Qué pasó

| Cuándo | Qué | Dónde se vio |
|---|---|---|
| 01/10 08:55 | El paciente se verifica desde **…2078** con su cédula **01\*\*\*\*5513** («teléfono ya registrado»: ese era el número de su ficha). Conversa con el bot. | Seguridad → intentos |
| entre 08:55 y 09:41 | En el panel alguien cambia el teléfono de su ficha a **…9199**. Al guardar, el bot le cierra la sesión. | Ficha: teléfono 593…9199 |
| 01/10 09:41 y 02/10 08:54 (×2) | Desde **…9199** escriben la cédula **01\*\*\*\*7713**, que no es la del paciente. El bot responde «no está en el padrón activo». | Seguridad → intentos |

Por qué se descartaron las otras explicaciones:

- **No estaba inactivo**: la ficha decía Activo.
- **No fue un código de vinculación desde …9199**: habría una fila «Verificado
  · código de vinculación» desde ese número, y no la hay.
- **No fue el importador de CSV**: cambia el teléfono pero no cierra la sesión,
  y el panel habría seguido diciendo Verificado.
- **La cédula 01…7713 no es un error de dedo**: pasa el dígito verificador, así
  que es otra cédula válida. Una mal escrita habría dado error de formato.

Conclusión: el teléfono se cambió a mano en el panel, y **…9199 lo está usando
otra persona** (o el paciente escribe una cédula que no es la suya). Lo más
probable es que …9199 sea de un familiar y se haya puesto en la ficha
equivocada.

Lo que no se pudo saber: **quién** cambió el teléfono. El panel no anotaba qué
usuario hacía cada cambio; el registro del servidor solo decía «Paciente #N
actualizado desde el panel», con la hora.

## Cómo se resuelve

Sin tocar nada del sistema, el consultorio tiene que averiguar dos cosas:

1. **¿Cuál es el celular del paciente?**
   - Si es **…2078**: se vuelve a poner ese número en su ficha. El panel pide
     confirmación (no está verificado, así que guarda directo) y el paciente
     entra escribiendo su cédula desde …2078, sin código.
   - Si es **…9199**: el paciente tiene que escribir **su** cédula (la que
     termina en 5513) desde …9199. Entra sin código.
2. **¿De quién es …9199 y la cédula 01…7713?** Si es alguien que debe usar el
   asistente, necesita su propia ficha con su cédula y su número. Un mismo
   número no puede estar en dos fichas.

La conversación, las glucemias y las alertas del paciente no se pierden en
ningún caso.

## Qué se cambió para que no vuelva a pasar (08/10/2026)

- **Historial de cambios** (`audit_log`, `src/services/bitacora.js`): cada cambio
  desde el panel queda con el usuario que lo hizo. También lo que el bot
  decide sobre un número: verificarlo, cerrarle la sesión por un «salir»,
  pasarle el número a otra ficha.
- **Confirmación antes de cortar el acceso**: cambiar el teléfono de un
  paciente verificado, o desactivarlo, muestra primero qué va a pasar (desde
  qué número usa el bot, que lo va a perder, cómo vuelve a entrar) y pide
  confirmarlo.
- **Bloque «Número y verificación» en la ficha**: cédula, teléfono
  registrado, desde qué número se verificó y cuándo, si la sesión sigue y
  quién la cerró. Si el número verificado no es el registrado, lo avisa en rojo.
- **«Historial de la ficha»**: los cambios de la ficha junto con los intentos
  de verificación desde sus números o con su cédula. Un intento con **otra
  cédula** desde su número sale marcado. Con eso, este caso se habría visto de
  un vistazo.
- **Pantalla Historial** (solo administrador): búsqueda por nombre, cédula o
  teléfono (en formato 09…), quién, qué y fechas.
- **La lista de pacientes ya no repite** a quien se verificó desde dos números,
  y se puede filtrar por estado del número.

## Para investigar otro caso así

1. Ficha del paciente → **Número y verificación**: ¿desde qué número se
   verificó? ¿Sigue abierta la sesión? ¿Quién la cerró?
2. Ficha → **Historial de la ficha**: cambios e intentos, en orden.
3. **Historial** → buscar el teléfono que escribe (como 09…) para ver todo lo
   que pasó con ese número, aunque no esté en ninguna ficha.
4. Para lo anterior al 08/10/2026: logs de Railway, buscando
   `Paciente #<id>` (el id es el número al final del enlace de su ficha).
