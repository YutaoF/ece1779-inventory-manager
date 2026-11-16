/**
 * An error that is safe to show to the client. Throw it from any route or
 * service (Express 5 forwards rejected promises to the error handler):
 *
 *   throw new HttpError(409, 'insufficient_stock', 'Not enough stock at this location');
 */
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** 404 for any /api path no router handled. */
export function apiNotFound(req, res, next) {
  next(new HttpError(404, 'not_found', `No route for ${req.method} ${req.baseUrl}${req.path}`));
}

/** Errors raised by express.json() for bad request bodies. */
const BODY_PARSER_ERRORS = {
  'entity.parse.failed': ['invalid_json', 'Request body is not valid JSON'],
  'entity.too.large': ['payload_too_large', 'Request body is too large'],
  'encoding.unsupported': ['unsupported_encoding', 'Unsupported content encoding'],
};

/**
 * Turns every error into the same JSON shape:
 *   { "error": { "code": "...", "message": "...", "details"?: ... } }
 * Unexpected errors are logged in full but only a generic message is returned,
 * so stack traces and SQL never reach the client.
 */
export function errorHandler(err, req, res, _next) {
  const log = req.log;

  if (res.headersSent) {
    log?.error('error after response started', { err, requestId: req.id });
    res.end();
    return;
  }

  if (err instanceof HttpError) {
    const body = { code: err.code, message: err.message };
    if (err.details !== undefined) body.details = err.details;
    res.status(err.status).json({ error: body });
    return;
  }

  const parserError = BODY_PARSER_ERRORS[err.type];
  if (parserError) {
    const [code, message] = parserError;
    res.status(err.status ?? 400).json({ error: { code, message } });
    return;
  }

  log?.error('unhandled error', { err, requestId: req.id, method: req.method, path: req.path });
  res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
}
