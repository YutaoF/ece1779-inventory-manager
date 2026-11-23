import { Router } from 'express';
import { archivedFilter, catalogId, descriptionValue, readBody, requiredText } from '../catalog/validation.js';
import { notifyAfterCommit } from '../inventory/notify-after-commit.js';
import { HttpError } from '../middleware/errors.js';
import { requireActiveUser, requireManager } from '../middleware/require-active-user.js';
import { idFilter, textFilter } from '../routes/query-filters.js';

const FIELDS = ['sku', 'name', 'categoryId', 'description'];
const COLUMNS = 'id::text AS id, sku, name, category_id::text AS "categoryId", description, archived_at AS "archivedAt"';

function productValues(body, required = []) {
  const fields = readBody(body, FIELDS, required);
  const sku = fields.sku === undefined ? null : requiredText(fields.sku, 'sku');
  if (sku !== null && !/^[A-Za-z0-9]+$/.test(sku)) {
    throw new HttpError(400, 'validation_failed', 'SKU must contain only ASCII letters and digits.');
  }
  return [
    sku,
    fields.name === undefined ? null : requiredText(fields.name, 'name'),
    fields.categoryId === undefined ? null : catalogId(fields.categoryId, 'categoryId'),
    fields.description === undefined ? null : descriptionValue(fields.description),
  ];
}

async function writeProduct(pool, sql, values) {
  try {
    const { rows } = await pool.query(sql, values);
    return rows[0];
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'products_sku_key') {
      throw new HttpError(409, 'duplicate_sku', 'A product with this SKU already exists.');
    }
    if (error.code === '23503' && error.constraint === 'products_category_id_fkey') {
      throw new HttpError(404, 'not_found', 'Category not found.');
    }
    throw error;
  }
}

async function findArchivedProduct(pool, id) {
  const { rows } = await pool.query(`
    SELECT ${COLUMNS} FROM public.products WHERE id = $1 AND archived_at IS NOT NULL`, [id]);
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Product not found.');
  return rows[0];
}

export function productsRouter() {
  const router = Router();
  router.use(requireActiveUser);

  router.get('/', async (req, res) => {
    const query = req.query;
    const { rows } = await req.app.locals.pool.query(`
      SELECT ${COLUMNS}
      FROM public.products
      WHERE (archived_at IS NOT NULL) = $1
        AND ($2::text IS NULL OR sku = $2)
        AND ($3::text IS NULL OR strpos(lower(name), lower($3)) > 0)
        AND ($4::bigint IS NULL OR category_id = $4)
      ORDER BY name, products.id`, [
      archivedFilter(query), textFilter(query, 'sku'), textFilter(query, 'name'), idFilter(query, 'categoryId'),
    ]);
    res.json({ products: rows });
  });

  router.post('/', requireManager, async (req, res) => {
    const fields = productValues(req.body, ['sku', 'name', 'categoryId']);
    const product = await writeProduct(req.app.locals.pool, `
      INSERT INTO public.products (sku, name, category_id, description)
      VALUES ($1, $2, $3, $4)
      RETURNING ${COLUMNS}`, fields);
    res.status(201).json({ product });
  });

  router.patch('/:id', requireManager, async (req, res) => {
    const { pool } = req.app.locals;
    const id = catalogId(req.params.id, 'id');
    const fields = productValues(req.body);
    const product = await writeProduct(pool, `
      UPDATE public.products
      SET sku = coalesce($1, sku), name = coalesce($2, name),
          category_id = coalesce($3, category_id),
          description = CASE WHEN $5 THEN $4 ELSE description END
      WHERE id = $6 AND archived_at IS NULL
      RETURNING ${COLUMNS}`, [...fields, Object.hasOwn(req.body, 'description'), id]);
    if (!product) {
      await findArchivedProduct(pool, id);
      throw new HttpError(409, 'product_archived', 'This product is archived.');
    }
    void notifyAfterCommit(req);
    res.json({ product });
  });

  router.delete('/:id', requireManager, async (req, res) => {
    const { pool } = req.app.locals;
    const id = catalogId(req.params.id, 'id');
    const { rows } = await pool.query(`
      UPDATE public.products SET archived_at = statement_timestamp()
      WHERE id = $1 AND archived_at IS NULL
      RETURNING ${COLUMNS}`, [id]);
    if (rows[0]) void notifyAfterCommit(req);
    res.json({ product: rows[0] ?? await findArchivedProduct(pool, id) });
  });

  return router;
}
