import { Router } from 'express';
import { HttpError } from '../middleware/errors.js';
import { notifyAfterCommit } from '../inventory/notify-after-commit.js';
import { applyStockChangeWithOutcome, StockError } from './stock-operation.js';

const httpErrors = {
  INVALID_INPUT: [400, 'validation_failed'],
  ACTOR_NOT_FOUND: [401, 'unauthenticated'],
  ACTOR_DISABLED: [401, 'unauthenticated'],
  FORBIDDEN: [403, 'forbidden'],
  PRODUCT_NOT_FOUND: [404, 'not_found'],
  LOCATION_NOT_FOUND: [404, 'not_found'],
  PRODUCT_ARCHIVED: [409, 'product_archived'],
  LOCATION_ARCHIVED: [409, 'location_archived'],
  INSUFFICIENT_STOCK: [409, 'insufficient_stock'],
  QUANTITY_OVERFLOW: [409, 'quantity_overflow'],
  REQUEST_KEY_CONFLICT: [409, 'request_key_conflict'],
};

function handleAction(operationType, actionFields) {
  const allowed = new Set(['productId', 'reason', 'clientRequestKey', ...actionFields]);
  return async (req, res) => {
    const actorId = req.session?.userId;
    if (!actorId) throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'validation_failed', 'Send a JSON object for this stock operation.');
    }
    for (const field of Object.keys(body)) {
      if (!allowed.has(field)) {
        throw new HttpError(400, 'validation_failed', `Unexpected stock request field: ${field}`);
      }
    }
    try {
      const { result, applied } = await applyStockChangeWithOutcome(req.app.locals.pool, { ...body, actorId }, operationType);
      if (applied) void notifyAfterCommit(req);
      res.json(result);
    } catch (err) {
      const mapping = err instanceof StockError && httpErrors[err.code];
      if (!mapping) throw err;
      const [status, code] = mapping;
      throw new HttpError(status, code, status === 401 ? 'Sign in to continue.' : err.message, err.details);
    }
  };
}

export function stockRouter() {
  const router = Router();
  router.post('/receive', handleAction('receive', ['locationId', 'quantity']));
  router.post('/issue', handleAction('issue', ['locationId', 'quantity']));
  router.post('/correction', handleAction('correction', ['locationId', 'quantityDelta']));
  router.post('/transfer', handleAction('transfer', ['sourceLocationId', 'destinationLocationId', 'quantity']));
  return router;
}
