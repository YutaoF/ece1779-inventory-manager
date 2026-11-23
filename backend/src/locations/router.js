import { Router } from 'express';
import { archivedFilter, catalogId, descriptionValue, readBody, requiredText } from '../catalog/validation.js';
import { notifyAfterCommit } from '../inventory/notify-after-commit.js';
import { HttpError } from '../middleware/errors.js';
import { requireActiveUser, requireManager } from '../middleware/require-active-user.js';

const locationFields = 'id::text AS id, name, description, archived_at AS "archivedAt"';

async function findArchivedLocation(pool, id) {
  const { rows } = await pool.query(
    `SELECT ${locationFields} FROM public.locations WHERE id = $1 AND archived_at IS NOT NULL`, [id],
  );
  if (!rows.length) throw new HttpError(404, 'not_found', 'Location not found.');
  return rows[0];
}

export function locationsRouter() {
  const router = Router();
  router.use(requireActiveUser);

  router.get('/', async (req, res) => {
    const archived = archivedFilter(req.query);
    const { rows } = await req.app.locals.pool.query(
      `SELECT ${locationFields} FROM public.locations
       WHERE (archived_at IS NOT NULL) = $1 ORDER BY name, locations.id`,
      [archived],
    );
    res.json({ locations: rows });
  });

  router.post('/', requireManager, async (req, res) => {
    const body = readBody(req.body, ['name', 'description'], ['name']);
    const name = requiredText(body.name, 'name');
    const description = body.description === undefined ? null : descriptionValue(body.description);
    const { rows } = await req.app.locals.pool.query(
      `INSERT INTO public.locations (name, description) VALUES ($1, $2) RETURNING ${locationFields}`,
      [name, description],
    );
    res.status(201).json({ location: rows[0] });
  });

  router.patch('/:id', requireManager, async (req, res) => {
    const { pool } = req.app.locals;
    const id = catalogId(req.params.id, 'id');
    const body = readBody(req.body, ['name', 'description']);
    const name = body.name === undefined ? null : requiredText(body.name, 'name');
    const hasDescription = body.description !== undefined;
    const description = hasDescription ? descriptionValue(body.description) : null;
    const { rows } = await pool.query(
      `UPDATE public.locations
       SET name = coalesce($2, name), description = CASE WHEN $3 THEN $4 ELSE description END
       WHERE id = $1 AND archived_at IS NULL RETURNING ${locationFields}`,
      [id, name, hasDescription, description],
    );
    if (!rows.length) {
      await findArchivedLocation(pool, id);
      throw new HttpError(409, 'location_archived', 'Archived locations cannot be edited.');
    }
    void notifyAfterCommit(req);
    res.json({ location: rows[0] });
  });

  router.delete('/:id', requireManager, async (req, res) => {
    const { pool } = req.app.locals;
    const id = catalogId(req.params.id, 'id');
    const { rows } = await pool.query(
      `UPDATE public.locations SET archived_at = statement_timestamp()
       WHERE id = $1 AND archived_at IS NULL RETURNING ${locationFields}`,
      [id],
    );
    if (!rows.length) return res.json({ location: await findArchivedLocation(pool, id) });
    void notifyAfterCommit(req);
    res.json({ location: rows[0] });
  });

  return router;
}
