import { HttpError } from '../middleware/errors.js';
import { idFilter } from '../routes/query-filters.js';
import { notifyAfterCommit } from './notify-after-commit.js';

function readThreshold(body) {
  if (!body || !Object.hasOwn(body, 'reorderThreshold') || Object.keys(body).length !== 1) {
    throw new HttpError(400, 'validation_failed', 'Send exactly one field named reorderThreshold.');
  }
  const value = body.reorderThreshold;
  if (value !== null && (!Number.isInteger(value) || value < 0 || value > 2147483647)) {
    throw new HttpError(400, 'validation_failed', 'reorderThreshold must be a whole number from 0 to 2147483647 or null.');
  }
  return value;
}

export async function updateThreshold(req, res) {
  res.set('Cache-Control', 'no-store');
  const actorId = req.session?.userId;
  if (!actorId) throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');

  const client = await req.app.locals.pool.connect();
  let discardClient = false;
  let updated;
  let changed;
  try {
    await client.query('BEGIN');
    // Keep authorization valid through the write if the account is demoted or disabled concurrently.
    const { rows: [actor] } = await client.query(
      'SELECT role, disabled_at FROM public.users WHERE id = $1 FOR SHARE', [actorId],
    );
    if (!actor || actor.disabled_at !== null) {
      throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');
    }
    if (actor.role !== 'manager') {
      throw new HttpError(403, 'forbidden', 'Only managers can change reorder thresholds.');
    }

    const productId = idFilter(req.params, 'productId');
    const locationId = idFilter(req.params, 'locationId');
    const threshold = readThreshold(req.body);
    const { rows: [pair] } = await client.query(`
      SELECT p.archived_at AS product_archived_at, l.archived_at AS location_archived_at, i.reorder_threshold
      FROM public.products AS p
      JOIN public.locations AS l ON l.id = $2
      JOIN public.inventory AS i ON i.product_id = p.id AND i.location_id = l.id
      WHERE p.id = $1
      FOR SHARE OF p, l FOR NO KEY UPDATE OF i
    `, [productId, locationId]);
    if (!pair) throw new HttpError(404, 'not_found', 'This location does not track the product.');
    if (pair.product_archived_at !== null) throw new HttpError(409, 'product_archived', 'The product is archived.');
    if (pair.location_archived_at !== null) throw new HttpError(409, 'location_archived', 'The location is archived.');

    changed = pair.reorder_threshold !== threshold;
    if (changed) {
      await client.query(`
        UPDATE public.inventory SET reorder_threshold = $3
        WHERE product_id = $1 AND location_id = $2
      `, [productId, locationId, threshold]);
    }
    updated = { productId, locationId, reorderThreshold: threshold };
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discardClient = true;
    }
    throw error;
  } finally {
    client.release(discardClient);
  }
  if (changed) void notifyAfterCommit(req);
  res.json(updated);
}
