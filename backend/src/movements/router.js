import { Router } from 'express';
import { HttpError } from '../middleware/errors.js';
import { requireActiveUser } from '../middleware/require-active-user.js';
import { idFilter, textFilter } from '../routes/query-filters.js';

// A calendar date, or a timestamp with whole seconds, an optional fraction and a zone.
const DATE_BOUND = /^(\d{4}-\d{2}-\d{2})(?:T((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.(\d{1,6}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/;

function dateFilter(query, field) {
  const value = textFilter(query, field);
  if (value === null) return null;
  const parts = DATE_BOUND.exec(value);
  if (parts) {
    const [, day, time = '00:00:00', fraction = '', zone = 'Z'] = parts;
    const midnight = new Date(`${day}T00:00:00Z`);
    const instant = new Date(`${day}T${time}${zone}`);
    // JS normalizes dates like February 30. Require an actual calendar day.
    if (midnight.getUTCFullYear() >= 1 && midnight.toISOString().startsWith(day)
        && instant.getUTCFullYear() >= 1 && instant.getUTCFullYear() <= 9999) {
      // Normalize the offset but keep PostgreSQL's microseconds, which a JS Date would lose.
      return `${instant.toISOString().slice(0, 19)}.${fraction.padEnd(6, '0')}Z`;
    }
  }
  throw new HttpError(400, 'validation_failed', `${field} must be a UTC date or an ISO timestamp with a time zone.`);
}

export function movementsRouter() {
  const router = Router();

  router.get('/', requireActiveUser, async (req, res) => {
    const query = req.query;
    const from = dateFilter(query, 'from');
    const to = dateFilter(query, 'to');
    if (from !== null && to !== null && from >= to) {
      throw new HttpError(400, 'validation_failed', 'from must be earlier than to.');
    }

    const { rows } = await req.app.locals.pool.query(`
      SELECT m.id::text AS id, m.operation_id::text AS "operationId", o.operation,
             o.actor_id::text AS "actorId", u.name AS "actorName",
             m.product_id::text AS "productId", p.sku, p.name,
             m.location_id::text AS "locationId", l.name AS location,
             m.quantity_delta AS "quantityDelta", m.quantity_after AS "quantityAfter", o.reason,
             to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
      FROM public.stock_movements AS m
      JOIN public.stock_operations AS o ON o.id = m.operation_id
      JOIN public.users AS u ON u.id = o.actor_id
      JOIN public.products AS p ON p.id = m.product_id
      JOIN public.locations AS l ON l.id = m.location_id
      WHERE ($1::bigint IS NULL OR m.product_id = $1)
        AND ($2::bigint IS NULL OR m.location_id = $2)
        AND ($3::bigint IS NULL OR o.actor_id = $3)
        AND ($4::timestamptz IS NULL OR m.created_at >= $4)
        AND ($5::timestamptz IS NULL OR m.created_at < $5)
      ORDER BY m.created_at DESC, m.id DESC
    `, [idFilter(query, 'productId'), idFilter(query, 'locationId'), idFilter(query, 'actorId'), from, to]);
    res.json({ movements: rows });
  });

  return router;
}
