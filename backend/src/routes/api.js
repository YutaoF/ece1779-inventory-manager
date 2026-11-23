import { Router } from 'express';
import { authRouter } from '../auth/router.js';
import { categoriesRouter } from '../categories/router.js';
import { inventoryRouter } from '../inventory/router.js';
import { locationsRouter } from '../locations/router.js';
import { apiNotFound } from '../middleware/errors.js';
import { movementsRouter } from '../movements/router.js';
import { productsRouter } from '../products/router.js';
import { stockRouter } from '../stock/router.js';

/**
 * The /api router. Each feature area mounts its own router here; see
 * docs/api.md for paths and permissions.
 */
export function apiRouter() {
  const router = Router();
  router.use('/auth', authRouter());
  router.use('/categories', categoriesRouter());
  router.use('/inventory', inventoryRouter());
  router.use('/locations', locationsRouter());
  router.use('/movements', movementsRouter());
  router.use('/products', productsRouter());
  router.use('/stock-operations', stockRouter());

  // Anything under /api that no feature router handled is a JSON 404, never
  // the frontend's index.html.
  router.use(apiNotFound);

  return router;
}
