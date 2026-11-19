import { Router } from 'express';
import { apiNotFound } from '../middleware/errors.js';
import { stockRouter } from '../stock/router.js';

/**
 * The /api router. Each feature area mounts its own router here; see
 * docs/api.md for paths and permissions.
 */
export function apiRouter() {
  const router = Router();
  router.use('/stock-operations', stockRouter());

  // Anything under /api that no feature router handled is a JSON 404, never
  // the frontend's index.html.
  router.use(apiNotFound);

  return router;
}
