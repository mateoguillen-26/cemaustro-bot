# Asistente de diabetes por WhatsApp

Chatbot de WhatsApp que responde dudas sobre **diabetes** a los pacientes de un
consultorio — y **solo** a ellos. Registra las glucemias que reportan, avisa al
doctor cuando algo lo amerita, y trae un panel web para administrarlo todo.

Está construido sobre la misma arquitectura que el bot de recordatorios
(Node + Express + SQLite + Meta Cloud API + OpenAI), pero es una aplicación
independiente: base de datos propia, número propio y app de Meta propia.

---

## Lo que hace

| | |
|---|---|
| **Verifica** | Un número desconocido no recibe ni una palabra de contenido médico hasta demostrar que pertenece a un paciente del padrón. |
| **Responde** | Educación en diabetes apoyada en las guías que el doctor sube al panel. Nunca diagnostica ni cambia tratamientos. |
| **Registra** | "glucosa 128 en ayunas" queda anotado y el doctor ve la tendencia. |
| **Alerta** | Una hipoglucemia grave o un síntoma de alarma le llega al doctor por WhatsApp al momento. |
| **Escucha** | Notas de voz transcritas con Whisper, para pacientes a los que escribir se les hace cuesta arriba. |

---

## Cómo se verifica a un paciente

Este es el corazón del sistema, así que conviene entenderlo antes de tocar nada.

El doctor carga el **padrón**: cédula, nombre y —si lo tiene— el teléfono de
cada paciente. Desde ahí hay dos caminos:

**A. El teléfono ya está registrado.**
El paciente escribe su cédula desde ese número y queda verificado. Son dos
factores de verdad: hay que *tener* el teléfono y *saber* la cédula.

**B. El teléfono no está registrado** (paciente nuevo, o cambió de número).
Hace falta además un **código de 6 dígitos** que el doctor genera en el panel y
le entrega **en la consulta**. Al usarlo, el número queda ligado a ese paciente
y el código se quema.

> **Por qué el código no se envía por WhatsApp.** Mandarlo al mismo número desde
> el que la persona está escribiendo no verificaría nada: quien tenga el teléfono
> recibiría el código. El código vale precisamente porque viaja por otro canal.

La sesión dura 90 días (configurable). El doctor puede cerrarla desde el panel
en cualquier momento, y desactivar a un paciente le corta el acceso en el
siguiente mensaje.

**Contra la enumeración.** Todos los fallos responden exactamente lo mismo. Ni
la cédula ni el código revelan si esa persona se atiende en el consultorio:
saber quién va al diabetólogo ya es información de salud. Tras 5 intentos
fallidos el número queda bloqueado una hora.

---

## Puesta en marcha

### 1. Crear la aplicación en Meta

Sí, hace falta **una aplicación aparte** de la del bot de recordatorios. El
webhook se configura por aplicación: si compartieran app, los mensajes de los
dos bots llegarían a la misma URL y habría que separarlos a mano por
`phone_number_id`. Además conviene aislar los tokens — aquí hay datos de salud.

En [developers.facebook.com](https://developers.facebook.com):

1. **Crear app** → tipo *Empresa* → agregar el producto **WhatsApp**.
2. En *WhatsApp → Configuración de la API*, anote el **Phone number ID** y
   registre un número (uno distinto al del bot de recordatorios).
3. En *Configuración → Básica*, copie el **App Secret**.
4. Genere un **token permanente** de usuario del sistema en
   *Business Settings → Usuarios → Usuarios del sistema*, con los permisos
   `whatsapp_business_messaging` y `whatsapp_business_management`.
5. En *WhatsApp → Configuración → Webhook*:
   - URL: `https://su-dominio.com/webhook`
   - Token de verificación: el mismo que ponga en `WHATSAPP_VERIFY_TOKEN`
   - Suscríbase al campo **`messages`**.

Para las alertas fuera de la ventana de 24 h, cree además una plantilla en
*WhatsApp → Plantillas de mensajes*, categoría **Utilidad**, con **una sola
variable**:

```
Aviso del asistente de diabetes: {{1}}
```

y ponga su nombre en `WHATSAPP_TEMPLATE_ALERTA`.

### 2. Configurar el servidor

```bash
npm install
cp .env.example .env      # y complete los valores
npm run migrate
npm start
```

Genere una sal única para `AUTH_PEPPER`:

```bash
openssl rand -hex 32
```

El servidor queda en el puerto 3000: webhook en `/webhook`, panel en `/admin`.
En desarrollo, exponga el puerto con `ngrok http 3000` y use esa URL en Meta.

### 3. Cargar el padrón

Desde el panel, uno por uno, o de golpe con un CSV:

```csv
cedula,nombre,telefono,tipo,notas
0102030405,María Elena Vásquez,593987654321,2,Usa metformina. Vive sola.
0912345678,Luis Mora,,1,Debut reciente. Usa insulina basal.
```

```bash
npm run importar-pacientes -- data/pacientes.csv
```

La columna `telefono` es opcional: si la deja en blanco, ese paciente necesitará
un código de vinculación la primera vez.

### 4. Cargar la base de conocimiento

Pegue el texto en *Panel → Conocimiento*, o deje archivos `.md` / `.txt` en
`docs/` y corra:

```bash
npm run importar-docs
```

Cada documento se parte en fragmentos y se indexa por significado. Cuando llega
una pregunta, el bot busca los fragmentos que aplican y responde apoyado en
ellos. **Sus criterios mandan sobre lo que el modelo sabría por su cuenta.**

Sin documentos el bot funciona igual, pero responde con criterio general.
Separe los temas con una línea en blanco: así se parten mejor y se buscan mejor.

---

## El panel (`/admin`)

| Sección | Para qué |
|---|---|
| **Resumen** | Métricas del día y alertas sin revisar. |
| **Pacientes** | El padrón. Agregar, editar, código de vinculación, cierre de sesión. La ficha muestra glucemias con gráfico, alertas y la conversación completa. |
| **Alertas** | Todo lo que el bot marcó para que el doctor lo mire, con el fragmento que lo disparó. |
| **Conocimiento** | Documentos: subir, encender/apagar, reindexar, borrar. |
| **Configuración** | Las instrucciones clínicas del asistente y los textos fijos, editables en caliente sin reiniciar. |
| **Seguridad** | Intentos de verificación (cédulas enmascaradas) y errores recientes del servidor. |

El panel va protegido con usuario y contraseña. **Si no los configura, no se
sirve**: muestra cédulas y datos de salud, y no puede quedar abierto por
descuido.

---

## Las alertas

El nivel se decide en dos sitios, y gana el más grave:

- **El modelo**, que ve el mensaje completo con sus síntomas.
- **Los umbrales de glucemia**, que son aritmética pura y se comprueban en
  código sobre el valor ya guardado. Si el modelo pasa por alto un 48 mg/dL,
  el umbral lo atrapa igual.

| Nivel | Cuándo | Qué pasa |
|---|---|---|
| **Urgente** | Hipoglucemia grave, sospecha de cetoacidosis, dolor de pecho, pie infectado, ideación suicida… | Sale al momento, sin esperar. Al paciente se le dice que busque atención inmediata. |
| **Aviso** | Cifras altas repetidas, abandono de medicación, pide hablar con el doctor. | Sale respetando 30 minutos entre avisos del mismo paciente. |

Las alertas **siempre** quedan en el panel, aunque el WhatsApp falle o esté
apagado. El panel es la fuente de verdad; el WhatsApp es la comodidad.

Para que el doctor reciba texto libre tiene que haberle escrito al bot en las
últimas 24 h. Si no, se usa la plantilla aprobada — por eso conviene tenerla.

---

## Estructura

```
src/
├── index.js                 Servidor Express y arranque
├── config.js                Variables de entorno
├── db/
│   ├── database.js          Conexión SQLite
│   ├── migrations.js        Esquema por versiones
│   └── queries.js           Todo el SQL del proyecto
├── services/
│   ├── auth.js              ★ Verificación de pacientes
│   ├── ai.js                Llamada al modelo (salida estructurada)
│   ├── prompts.js           Instrucciones clínicas
│   ├── conocimiento.js      Partir, vectorizar y buscar documentos
│   ├── glucemias.js         Registro y clasificación de mediciones
│   ├── alertas.js           Aviso al doctor
│   ├── whatsapp.js          Meta Cloud API y firma de webhooks
│   ├── transcription.js     Whisper
│   └── ajustes.js           Configuración editable en caliente
├── webhook/whatsapp.js      ★ Recepción y orquestación
├── admin/                   Panel del doctor
├── utils/                   Fechas, cédula ecuatoriana, registro
└── scripts/                 Importadores de docs y pacientes
```

---

## Despliegue

Hay `Dockerfile`, `Procfile` y `railway.json`. La base vive en `./data`, así que
**monte ese directorio como volumen** o se pierde en cada despliegue.

```bash
docker build -t asistente-diabetes .
docker run -d -p 3000:3000 --env-file .env -v $(pwd)/data:/app/data asistente-diabetes
```

Antes de salir a producción, revise *Panel → Seguridad*: ahí se listan las
piezas de configuración que quedaron flojas.

---

## Límites que conviene tener presentes

- **No es un dispositivo médico.** Da educación, no diagnóstico ni tratamiento.
  El prompt lo prohíbe explícitamente, pero un modelo de lenguaje puede
  equivocarse: revise las conversaciones en el panel de vez en cuando.
- **Las glucemias son autorreportadas**, no de laboratorio. Sirven para ver la
  tendencia entre consultas.
- **Las alertas no son un servicio de emergencias.** Dependen de que WhatsApp
  entregue el mensaje y de que alguien lo lea. Al paciente siempre se le dice
  que acuda a emergencias.
- **Datos sensibles.** La base guarda cédulas, conversaciones y valores de
  salud. Cífrela en reposo, respalde con cuidado y no exponga `/admin` sin TLS.
