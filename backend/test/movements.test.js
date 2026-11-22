import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { hashPassword } from '../src/auth/password.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { startApp } from './helpers.js';
import { createStockFixture, createTestDatabase } from './helpers/stock-database.js';

describe('GET /api/movements with PostgreSQL', () => {
  let db;
  let server;
  let passwordHash;
  let staff;
  let manager;
  const password = 'movement test password';

  before(async () => {
    db = await createTestDatabase();
    server = await startApp({ pool: db.pool, sessionSecret: randomUUID() });
    passwordHash = await hashPassword(password);
    staff = await signIn('staff');
    manager = await signIn('manager');
  });

  after(async () => {
    await server?.close();
    await db?.close();
  });

  function post(path, body, cookie) {
    return fetch(server.url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie && { cookie }) },
      body: JSON.stringify(body),
    });
  }

  async function signIn(role) {
    const email = `${randomUUID()}@example.invalid`;
    const { rows: [user] } = await db.pool.query(
      'INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name',
      [email, `History ${role}`, passwordHash, role],
    );
    const response = await post('/api/auth/login', { email, password });
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`));
    assert.ok(cookie);
    return { ...user, cookie: cookie.split(';')[0] };
  }

  function getHistory(cookie, filters) {
    const url = new URL('/api/movements', server.url);
    url.search = new URLSearchParams(filters).toString();
    return fetch(url, { headers: cookie ? { cookie } : {} });
  }

  async function readHistory(cookie, filters) {
    const response = await getHistory(cookie, filters);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { movements } = await response.json();
    assert.ok(Array.isArray(movements));
    return movements;
  }

  it('requires an active session before validating filters', async () => {
    const disabled = await signIn('staff');
    await db.pool.query('UPDATE users SET disabled_at = now() WHERE id = $1', [disabled.id]);
    for (const cookie of [undefined, disabled.cookie]) {
      const response = await getHistory(cookie, { from: 'invalid' });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, 'unauthenticated');
    }
  });

  it('exposes both legs of a committed transfer with one operation ID and distinct movement IDs', async () => {
    const { productId, locationId } = await createStockFixture(db.pool);
    const { rows: [product] } = await db.pool.query('SELECT sku FROM products WHERE id = $1', [productId]);
    const { rows: [pantry] } = await db.pool.query("INSERT INTO locations (name) VALUES ('Pantry') RETURNING id");
    const receipt = await post('/api/stock-operations/receive', { productId, locationId, quantity: 10 }, staff.cookie);
    assert.equal(receipt.status, 200);
    const { movementId: receiptId } = await receipt.json();
    const transfer = await post('/api/stock-operations/transfer', {
      productId, sourceLocationId: locationId, destinationLocationId: pantry.id, quantity: 3, reason: 'Refill pantry',
    }, manager.cookie);
    assert.equal(transfer.status, 200);
    const { operationId, sourceMovementId, destinationMovementId } = await transfer.json();
    assert.notEqual(sourceMovementId, destinationMovementId);

    await db.pool.query('UPDATE products SET archived_at = now() WHERE id = $1', [productId]);
    await db.pool.query('UPDATE locations SET archived_at = now() WHERE id = $1', [pantry.id]);
    const all = await readHistory(staff.cookie);
    const rows = all.filter((row) => row.productId === productId);
    assert.deepEqual(rows.map((row) => row.id), [destinationMovementId, sourceMovementId, receiptId]);
    assert.equal(rows[2].reason, null);
    const shared = {
      operationId, operation: 'transfer', actorId: manager.id, actorName: manager.name,
      productId, sku: product.sku, name: 'Rice', reason: 'Refill pantry',
    };
    for (const [row, expected] of [
      [rows[0], { id: destinationMovementId, locationId: pantry.id, location: 'Pantry', quantityDelta: 3, quantityAfter: 3 }],
      [rows[1], { id: sourceMovementId, locationId, location: 'Test storeroom', quantityDelta: -3, quantityAfter: 7 }],
    ]) {
      const { createdAt, ...fields } = row;
      assert.match(createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      assert.ok(Number.isFinite(Date.parse(createdAt)));
      assert.deepEqual(fields, { ...shared, ...expected });
    }
    const filtered = await readHistory(manager.cookie, { productId, locationId, actorId: manager.id });
    assert.deepEqual(filtered, [rows[1]]);
  });

  it('shows the previous history unchanged when a transfer rolls back at commit', async () => {
    const { productId, locationId } = await createStockFixture(db.pool);
    const { rows: [destination] } = await db.pool.query("INSERT INTO locations (name) VALUES ('Overflow') RETURNING id");
    const receipt = await post('/api/stock-operations/receive', { productId, locationId, quantity: 5 }, staff.cookie);
    assert.equal(receipt.status, 200);
    const before = await readHistory(manager.cookie, { productId });
    assert.equal(before.length, 1);
    // The failure is deferred until COMMIT, after the transfer has inserted both movements.
    await db.pool.query(`
      CREATE FUNCTION reject_history_test_credit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Rejected test transfer credit';
      END;
      $$;
      CREATE CONSTRAINT TRIGGER reject_history_test_credit AFTER INSERT ON stock_movements
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.quantity_delta > 0)
      EXECUTE FUNCTION reject_history_test_credit();
    `);
    const body = {
      productId, sourceLocationId: locationId, destinationLocationId: destination.id, quantity: 3,
      clientRequestKey: randomUUID(),
    };
    try {
      const failed = await post('/api/stock-operations/transfer', body, staff.cookie);
      assert.equal(failed.status, 500);
      assert.deepEqual(await readHistory(manager.cookie, { productId }), before);
    } finally {
      await db.pool.query('DROP TRIGGER reject_history_test_credit ON stock_movements');
      await db.pool.query('DROP FUNCTION reject_history_test_credit()');
    }
    const retried = await post('/api/stock-operations/transfer', body, staff.cookie);
    assert.equal(retried.status, 200);
    const { operationId } = await retried.json();
    const afterRetry = await readHistory(manager.cookie, { productId });
    assert.deepEqual(afterRetry.map((row) => row.operationId), [operationId, operationId, before[0].operationId]);
  });

  it('filters by product, location, actor and inclusive-start/exclusive-end dates, with stable ordering', async () => {
    const rice = await createStockFixture(db.pool);
    const oats = await createStockFixture(db.pool);
    // Seed fixed instants, including a tie, so boundary and ordering checks do not depend on clock speed.
    async function addMovement(actorId, productId, locationId, time) {
      const { rows: [movement] } = await db.pool.query(`
        WITH operation AS (
          INSERT INTO stock_operations (actor_id, operation, created_at) VALUES ($1, 'receive', $4) RETURNING id
        )
        INSERT INTO stock_movements (operation_id, product_id, location_id, quantity_delta, quantity_after, created_at)
        SELECT id, $2, $3, 1, 1, $4 FROM operation RETURNING id
      `, [actorId, productId, locationId, time]);
      return movement.id;
    }
    const start = await addMovement(staff.id, rice.productId, rice.locationId, '2024-02-29T00:00:00Z');
    const middle = await addMovement(manager.id, rice.productId, oats.locationId, '2024-02-29T18:00:00.000321Z');
    const tied = await addMovement(staff.id, oats.productId, oats.locationId, '2024-02-29T18:00:00.000321Z');
    const end = await addMovement(manager.id, rice.productId, rice.locationId, '2024-03-01T00:00:00Z');
    const range = { from: '2024-02-29', to: '2024-03-01' };
    for (const [filters, ids] of [
      [{ productId: rice.productId }, [end, middle, start]],
      [{ locationId: oats.locationId }, [tied, middle]],
      [range, [tied, middle, start]],
      [{ ...range, actorId: staff.id }, [tied, start]],
      [{ ...range, actorId: manager.id, productId: rice.productId, locationId: oats.locationId }, [middle]],
      [{ from: '2024-02-29T19:00:00+01:00', productId: rice.productId }, [end, middle]],
      [{ from: '2024-02-29T18:00:00.000321Z', to: '2024-02-29T18:00:00.000322Z' }, [tied, middle]],
      [{ to: '2024-02-29T13:00:00-05:00', productId: rice.productId }, [start]],
      [{ productId: oats.productId, locationId: rice.locationId }, []],
      [{ actorId: '9223372036854775807' }, []],
    ]) {
      const rows = await readHistory(staff.cookie, filters);
      assert.deepEqual(rows.map((row) => row.id), ids, JSON.stringify(filters));
    }
  });

  it('returns validation_failed for malformed IDs, ambiguous or impossible dates, and empty or reversed ranges', async () => {
    for (const filters of [
      { productId: '0' }, { locationId: '1.5' }, { actorId: '9223372036854775808' }, { actorId: ' ' },
      [['actorId', '1'], ['actorId', '2']], [['from', '2024-02-01'], ['from', '2024-02-02']],
      { from: '' }, { to: '2025-02-29' }, { from: '2024-04-31T12:00:00Z' },
      { from: '2024-03-01T00:00:00' }, { to: '2024-03-01T25:00:00Z' },
      { from: '2024-03-01', to: '2024-03-01T01:00:00+01:00' },
      { from: '2024-03-02', to: '2024-03-01' },
    ]) {
      const response = await getHistory(staff.cookie, filters);
      assert.equal(response.status, 400, JSON.stringify(filters));
      assert.equal((await response.json()).error.code, 'validation_failed');
    }
  });
});
