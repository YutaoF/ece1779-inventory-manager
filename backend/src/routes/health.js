import { Router } from 'express';
import { REQUIRED_SCHEMA_VERSION } from '../db.js';

const UNDEFINED_TABLE = '42P01';

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Health endpoints for Docker and the gateway. Both are unauthenticated and
 * return no internal details; the reason for an unready state is logged.
 *
 * GET /healthz  Liveness. 200 while the process can serve requests at all.
 *               A failing liveness check should restart the container.
 * GET /readyz   Readiness. 200 only when the database is reachable and migrated
 *               to REQUIRED_SCHEMA_VERSION, 503 otherwise (and while shutting down).
 */
export function healthRouter({ readinessTimeoutMs = 2000 } = {}) {
  const router = Router();

  router.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok' });
  });

  router.get('/readyz', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const notReady = (reason, extra = {}) =>
      res.status(503).json({ status: 'not_ready', reason, ...extra });

    if (req.app.locals.shuttingDown) {
      notReady('shutting_down');
      return;
    }

    let schemaVersion;
    try {
      const result = await withTimeout(
        req.app.locals.pool.query(
          'SELECT coalesce(max(version), 0)::int AS version FROM schema_migrations',
        ),
        readinessTimeoutMs,
      );
      schemaVersion = result.rows[0].version;
    } catch (err) {
      if (err.code === UNDEFINED_TABLE) {
        req.log.warn('readiness: schema_migrations table missing; run db/migrate.sql');
        notReady('schema_missing');
      } else {
        req.log.warn('readiness: database check failed', { err });
        notReady('database_unreachable');
      }
      return;
    }

    if (schemaVersion < REQUIRED_SCHEMA_VERSION) {
      req.log.warn('readiness: database schema is behind', {
        schemaVersion,
        requiredSchemaVersion: REQUIRED_SCHEMA_VERSION,
      });
      notReady('schema_outdated', { schemaVersion, requiredSchemaVersion: REQUIRED_SCHEMA_VERSION });
      return;
    }

    res.json({ status: 'ready', schemaVersion });
  });

  return router;
}
