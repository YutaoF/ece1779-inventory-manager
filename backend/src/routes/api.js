import { Router } from 'express';
import { apiNotFound } from '../middleware/errors.js';

/**
 * The /api router. Each feature area mounts its own router here; see
 * docs/api.md for the path prefixes and who owns each one.
 *
 *   router.use('/auth', authRouter());               // auth, sessions
 *   router.use('/users', usersRouter());             // account management
 *   router.use('/categories', categoriesRouter());   // catalog
 *   router.use('/products', productsRouter());       // catalog
 *   router.use('/locations', locationsRouter());     // catalog
 *   router.use('/inventory', inventoryRouter());     // balances, search, dashboard
 *   router.use('/stock-operations', stockRouter());  // receive/issue/transfer/correct
 *   router.use('/movements', movementsRouter());     // history
 */
export function apiRouter() {
  const router = Router();

  // Anything under /api that no feature router handled is a JSON 404, never
  // the frontend's index.html.
  router.use(apiNotFound);

  return router;
}
