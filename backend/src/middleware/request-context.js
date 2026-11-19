import { randomUUID } from 'node:crypto';

// Accept an upstream ID (e.g. set by Nginx) only if it looks like an ID.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

// Docker health checks hit these every few seconds; keep them out of info logs.
const QUIET_PATHS = new Set(['/healthz', '/readyz']);

/**
 * Gives each request an ID (echoed in the X-Request-Id response header), a
 * per-request logger at `req.log`, and one access-log line when it finishes.
 */
export function requestContext(logger) {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    req.log = logger.child({ requestId: req.id });
    res.setHeader('X-Request-Id', req.id);

    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const level = QUIET_PATHS.has(req.path) ? 'debug' : 'info';
      req.log[level]('request', {
        method: req.method,
        // Path only: query strings can carry search terms we don't need in logs.
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
      });
    });

    next();
  };
}
