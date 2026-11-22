import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createLogger } from './logger.js';
import { attachRealtime } from './realtime.js';

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

// Production refuses to start without SESSION_SECRET (see config.js). In
// development a missing secret gets a random one so sign-in works out of the
// box; sessions then last only until the process restarts.
let { sessionSecret } = config;
if (sessionSecret === undefined) {
  sessionSecret = randomBytes(48).toString('base64');
  logger.warn('SESSION_SECRET not set; using a random development secret (sessions reset on restart)');
}

const app = createApp({
  pool, logger, staticDir: config.staticDir,
  sessionSecret, isProduction: config.isProduction,
});

const server = createServer(app);
server.on('error', (err) => {
  logger.error('server error', { err });
  process.exit(1);
});
let realtime;
try {
  if (config.isProduction && !config.redisUrl) throw new Error('Set REDIS_URL for cross-replica notifications.');
  realtime = await attachRealtime(server, app, { redisUrl: config.redisUrl });
} catch (err) {
  logger.error('could not start realtime service', { err });
  await app.locals.sessionStore?.close();
  await pool.end();
  process.exit(1);
}
server.listen(config.port, config.host, () => {
  logger.info('listening', { host: config.host, port: config.port, nodeEnv: config.nodeEnv });
});

/**
 * Swarm sends SIGTERM before stopping a task (e.g. during a rolling update).
 * Stop accepting connections, let in-flight requests finish, close the pool,
 * then exit. If that takes longer than SHUTDOWN_TIMEOUT_MS, exit anyway.
 */
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.locals.shuttingDown = true;
  logger.info('shutting down', { signal });

  const forceExit = setTimeout(() => {
    logger.warn('shutdown timed out; exiting', { timeoutMs: config.shutdownTimeoutMs });
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  try {
    const closed = realtime.close(); // Closes WebSockets and then drains the shared HTTP server.
    server.closeIdleConnections();
    await closed;
    await app.locals.sessionStore?.close();
    await pool.end();
    logger.info('shutdown complete');
  } catch (err) {
    logger.error('shutdown failed', { err });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
