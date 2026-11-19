import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createLogger } from './logger.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  // The logger depends on config, so report config errors directly.
  console.error(JSON.stringify({ time: new Date().toISOString(), level: 'error', msg: 'invalid configuration', error: err.message }));
  process.exit(1);
}

const logger = createLogger({ level: config.logLevel, base: { service: 'inventory-api' } });
const pool = createPool(config.database, logger);
const app = createApp({
  pool, logger, staticDir: config.staticDir,
  sessionSecret: config.sessionSecret, isProduction: config.isProduction,
});

const server = app.listen(config.port, config.host, () => {
  logger.info('listening', { host: config.host, port: config.port, nodeEnv: config.nodeEnv });
});

server.on('error', (err) => {
  logger.error('server error', { err });
  process.exit(1);
});

/**
 * Swarm sends SIGTERM before stopping a task (e.g. during a rolling update).
 * Stop accepting connections, let in-flight requests finish, close the pool,
 * then exit. If that takes longer than SHUTDOWN_TIMEOUT_MS, exit anyway.
 */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.locals.shuttingDown = true;
  logger.info('shutting down', { signal });

  const forceExit = setTimeout(() => {
    logger.warn('shutdown timed out; exiting', { timeoutMs: config.shutdownTimeoutMs });
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  server.close(async () => {
    try {
      await pool.end();
    } catch (err) {
      logger.warn('error closing database pool', { err });
    }
    logger.info('shutdown complete');
    process.exit(0);
  });
  server.closeIdleConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
