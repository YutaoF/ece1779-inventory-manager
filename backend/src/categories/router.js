import { Router } from 'express';
import { readBody, requiredText } from '../catalog/validation.js';
import { HttpError } from '../middleware/errors.js';
import { requireActiveUser, requireManager } from '../middleware/require-active-user.js';

export function categoriesRouter() {
  const router = Router();
  router.use(requireActiveUser);

  router.get('/', async (req, res) => {
    const { rows } = await req.app.locals.pool.query(
      'SELECT id::text AS id, name FROM public.categories ORDER BY name, categories.id',
    );
    res.json({ categories: rows });
  });

  router.post('/', requireManager, async (req, res) => {
    const body = readBody(req.body, ['name'], ['name']);
    const name = requiredText(body.name, 'name');
    const { rows } = await req.app.locals.pool.query(
      `INSERT INTO public.categories (name) VALUES ($1)
       ON CONFLICT (name) DO NOTHING
       RETURNING id::text AS id, name`,
      [name],
    );
    if (!rows.length) throw new HttpError(409, 'duplicate_category', 'A category with this name already exists.');
    res.status(201).json({ category: rows[0] });
  });

  return router;
}
