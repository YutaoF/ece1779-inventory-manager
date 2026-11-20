import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { sessionMiddleware } from './auth/session.js';
import { errorHandler } from './middleware/errors.js';
import { requestContext } from './middleware/request-context.js';
import { apiRouter } from './routes/api.js';
import { healthRouter } from './routes/health.js';

/**
 * Builds the Express app without starting a server, so tests can run it
 * against a fake pool.
 *
 * Shared dependencies live on `app.locals` and are reachable from any handler
 * as `req.app.locals.pool` / `req.app.locals.logger`.
 */
export function createApp({ pool, logger, sessionSecret, isProduction = false, staticDir, readinessTimeoutMs } = {}) {
  const app = express();

  app.disable('x-powered-by');
  // The production gateway terminates HTTPS and sets X-Forwarded-Proto.
  if (isProduction) app.set('trust proxy', 1);
  app.locals.pool = pool;
  app.locals.logger = logger;
  app.locals.shuttingDown = false;

  app.use(requestContext(logger));
  app.use(healthRouter({ readinessTimeoutMs }));
  app.use(express.json({ limit: '100kb' }));
  if (sessionSecret) {
    const sessions = sessionMiddleware(pool, sessionSecret, isProduction);
    // Kept so shutdown (and tests) can stop the store's pruning timer.
    app.locals.sessionStore = sessions.store;
    app.use('/api', sessions.middleware);
  }
  app.use('/api', apiRouter());

  if (staticDir) {
    mountFrontend(app, staticDir, logger);
  }

  app.use(errorHandler);
  return app;
}

/**
 * Serves the built React app. Unknown GET paths fall back to index.html so
 * client-side routes (e.g. /products/42) survive a page refresh.
 */
function mountFrontend(app, staticDir, logger) {
  const root = path.resolve(staticDir);
  const indexFile = path.join(root, 'index.html');
  if (!existsSync(indexFile)) {
    logger.warn('STATIC_DIR has no index.html; frontend routes will 404', { staticDir: root });
  }

  app.use(express.static(root, { index: false, maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.set('Cache-Control', 'no-cache');
    res.sendFile(indexFile, (err) => {
      if (err) next(err.status === 404 || err.code === 'ENOENT' ? undefined : err);
    });
  });
}
