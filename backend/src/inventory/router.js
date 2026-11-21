import { Router } from 'express';
import { HttpError } from '../middleware/errors.js';
import { requireActiveUser } from '../middleware/require-active-user.js';
import { idFilter, textFilter } from '../routes/query-filters.js';
import { updateThreshold } from './threshold.js';

const STOCK_STATUSES = ['in_stock', 'low', 'out_of_stock'];

export function inventoryRouter() {
  const router = Router();

  router.get('/', requireActiveUser, async (req, res) => {
    const { pool } = req.app.locals;

    const query = req.query;
    const stockStatus = textFilter(query, 'stockStatus');
    if (stockStatus !== null && !STOCK_STATUSES.includes(stockStatus)) {
      throw new HttpError(400, 'validation_failed', 'stockStatus must be in_stock, low, or out_of_stock.');
    }
    const filters = [
      idFilter(query, 'productId'), idFilter(query, 'locationId'),
      textFilter(query, 'sku'), textFilter(query, 'name'), stockStatus,
    ];
    const { rows } = await pool.query(`
      WITH balances AS (
        SELECT product_id, location_id, quantity, reorder_threshold,
               CASE WHEN quantity = 0 THEN 'out_of_stock'
                    WHEN quantity <= reorder_threshold THEN 'low'
                    ELSE 'in_stock'
               END AS stock_status
        FROM public.inventory
      )
      SELECT concat(i.product_id, ':', i.location_id) AS id,
             p.id::text AS "productId", p.sku, p.name,
             l.id::text AS "locationId", l.name AS location, i.quantity,
             i.reorder_threshold AS "reorderThreshold", i.stock_status AS "stockStatus",
             p.archived_at IS NOT NULL AS "productArchived",
             l.archived_at IS NOT NULL AS "locationArchived"
      FROM balances AS i
      JOIN public.products AS p ON p.id = i.product_id
      JOIN public.locations AS l ON l.id = i.location_id
      WHERE ($1::bigint IS NULL OR i.product_id = $1)
        AND ($2::bigint IS NULL OR i.location_id = $2)
        AND ($3::text IS NULL OR p.sku = $3)
        AND ($4::text IS NULL OR strpos(lower(p.name), lower($4)) > 0)
        AND ($5::text IS NULL OR (i.stock_status = $5 AND p.archived_at IS NULL AND l.archived_at IS NULL))
      ORDER BY p.name, l.name, p.id, l.id
    `, filters);
    res.json({ inventory: rows });
  });

  router.patch('/:productId/:locationId/threshold', updateThreshold);

  return router;
}
