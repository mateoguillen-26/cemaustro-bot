/**
 * Punto de entrada: servidor Express con el webhook de WhatsApp y el panel.
 */
import express from 'express';
import { config, validarConfiguracion, advertenciasDeConfiguracion } from './config.js';
import { logger } from './utils/logger.js';
import { obtenerDB, cerrarDB } from './db/database.js';
import { ejecutarMigraciones } from './db/migrations.js';
import { router as webhookRouter } from './webhook/whatsapp.js';
import { adminRouter } from './admin/router.js';
import { asegurarUsuarioInicial } from './admin/auth.js';

const app = express();

// En producción la app va detrás de un proxy (Caddy, Nginx, Railway). Esto
// hace que req.ip sea la IP real del visitante y no la del proxy, algo que
// importa para el registro de intentos fallidos.
app.set('trust proxy', 1);

// Meta manda JSON firmado: se guarda el cuerpo crudo para poder comprobar la
// firma sobre los bytes exactos que llegaron, no sobre un JSON reserializado.
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buffer) => {
      req.rawBody = buffer;
    },
  }),
);

/* ------------------------------------------------------------------ */
/* Rutas                                                               */
/* ------------------------------------------------------------------ */

app.get('/', (_req, res) => {
  res.json({ servicio: config.clinica.nombre, estado: 'activo' });
});

app.get('/health', (_req, res) => {
  try {
    obtenerDB().prepare('SELECT 1').get();
    res.json({ estado: 'ok', hora: new Date().toISOString() });
  } catch (error) {
    logger.error('Health check falló.', error);
    res.status(503).json({ estado: 'error' });
  }
});

app.use(webhookRouter);
app.use('/admin', adminRouter);

app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

app.use((error, _req, res, _next) => {
  logger.error('Error no controlado en Express.', error);
  res.status(500).json({ error: 'Error interno' });
});

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

function arrancar() {
  const faltantes = validarConfiguracion();
  if (faltantes.length > 0) {
    logger.warn(
      `Faltan variables de entorno: ${faltantes.join(', ')}. El servidor arrancará, ` +
        'pero esas funciones fallarán. Revise su archivo .env',
    );
  }

  for (const advertencia of advertenciasDeConfiguracion()) {
    logger.warn(advertencia);
  }

  obtenerDB();
  ejecutarMigraciones();

  // Crea el primer usuario del panel a partir del .env si aún no hay ninguno.
  // Va después de las migraciones porque necesita la tabla ya creada.
  asegurarUsuarioInicial();

  const servidor = app.listen(config.puerto, () => {
    logger.info(`Servidor escuchando en el puerto ${config.puerto} (${config.entorno}).`);
    logger.info('Webhook disponible en: /webhook · Panel en: /admin');
  });

  // Si el puerto está ocupado hay que salir: dejar el proceso vivo sin atender
  // peticiones es peor que caerse, porque nadie se entera.
  servidor.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      logger.error(
        `El puerto ${config.puerto} ya está en uso. Cambie PORT en el archivo .env ` +
          'o cierre la aplicación que lo está ocupando.',
      );
    } else {
      logger.error('El servidor no pudo iniciarse.', error);
    }
    cerrarDB();
    process.exit(1);
  });

  // --- Apagado ordenado ---
  let apagando = false;
  const apagar = (senal) => {
    if (apagando) return;
    apagando = true;
    logger.info(`Señal ${senal} recibida. Cerrando la aplicación...`);

    servidor.close(() => {
      cerrarDB();
      logger.info('Aplicación cerrada correctamente.');
      process.exit(0);
    });

    setTimeout(() => {
      logger.warn('Cierre forzado tras 10 segundos.');
      cerrarDB();
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => apagar('SIGTERM'));
  process.on('SIGINT', () => apagar('SIGINT'));

  process.on('unhandledRejection', (razon) => {
    logger.error('Promesa rechazada sin manejar.', razon);
  });
  process.on('uncaughtException', (error) => {
    logger.error('Excepción no capturada.', error);
  });

  return servidor;
}

arrancar();

export { app };
