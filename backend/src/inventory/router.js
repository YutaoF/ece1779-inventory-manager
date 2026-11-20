import { Router } from 'express';
import { findUserById } from '../auth/users.js';
import { HttpError } from '../middleware/errors.js';

export function inventoryRouter() {
  const router = Router();

  router.get('/', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { pool } = req.app.locals;
    const userId = req.session?.userId;
    const user = userId && await findUserById(pool, userId);
    if (!user || user.disabled_at !== null) {
      throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');
    }

    const { rows } = await pool.query(`
      SELECT concat(i.product_id, ':', i.location_id) AS id,
             p.id::text AS "productId", p.sku, p.name,
             l.id::text AS "locationId", l.name AS location, i.quantity,
             p.archived_at IS NOT NULL AS "productArchived",
             l.archived_at IS NOT NULL AS "locationArchived"
      FROM public.inventory AS i
      JOIN public.products AS p ON p.id = i.product_id
      JOIN public.locations AS l ON l.id = i.location_id
      ORDER BY p.name, l.name, p.id, l.id
    `);
    res.json({ inventory: rows });
  });

  return router;
}
