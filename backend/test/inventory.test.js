import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { hashPassword } from '../src/auth/password.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { startApp } from './helpers.js';
import { createStockFixture, createTestDatabase, readStockState, runConcurrently } from './helpers/stock-database.js';

describe('/api/inventory with PostgreSQL', () => {
  let db;
  let server;
  let passwordHash;
  const password = 'inventory test password';

  before(async () => {
    db = await createTestDatabase();
    server = await startApp({ pool: db.pool, sessionSecret: randomUUID() });
    passwordHash = await hashPassword(password);
  });

  after(async () => {
    await server?.close();
    await db?.close();
  });

  function sendJson(method, path, body, cookie) {
    return fetch(server.url + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie && { cookie }) },
      body: JSON.stringify(body),
    });
  }

  function post(path, body, cookie) {
    return sendJson('POST', path, body, cookie);
  }

  function patchThreshold({ productId, locationId }, body, cookie) {
    return sendJson('PATCH', `/api/inventory/${productId}/${locationId}/threshold`, body, cookie);
  }

  async function assertError(response, status, code) {
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  }

  async function signIn(role) {
    const email = `${randomUUID()}@example.invalid`;
    const { rows: [user] } = await db.pool.query(
      "INSERT INTO users (email, name, password_hash, role) VALUES ($1, 'Inventory reader', $2, $3) RETURNING id",
      [email, passwordHash, role],
    );
    const response = await post('/api/auth/login', { email, password });
    assert.equal(response.status, 200);
    const header = response.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`));
    assert.ok(header, 'Login must issue a session cookie');
    return { id: user.id, cookie: header.split(';')[0] };
  }

  function getInventory(cookie, filters) {
    const url = new URL('/api/inventory', server.url);
    url.search = new URLSearchParams(filters).toString();
    return fetch(url, { headers: cookie ? { cookie } : {} });
  }

  async function readInventory(cookie, filters) {
    const response = await getInventory(cookie, filters);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
  }

  it('returns 401 without a session and when a logged-in account is disabled or removed', async () => {
    const disabled = await signIn('staff');
    const removed = await signIn('manager');
    await db.pool.query('UPDATE users SET disabled_at = now() WHERE id = $1', [disabled.id]);
    await db.pool.query('DELETE FROM users WHERE id = $1', [removed.id]);
    for (const cookie of [undefined, disabled.cookie, removed.cookie]) {
      const response = await getInventory(cookie);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, 'unauthenticated');
    }
  });

  it('validates filter values after checking the session', async () => {
    const anonymous = await getInventory(undefined, { productId: 'invalid' });
    assert.equal(anonymous.status, 401);
    const { cookie } = await signIn('staff');
    for (const filters of [
      { productId: '0' }, { productId: '7.5' }, { locationId: '-1' },
      { locationId: '9223372036854775808' }, { sku: '' }, { name: '  ' },
      [['locationId', '1'], ['locationId', '2']], [['name', 'rice'], ['name', 'oats']],
      { stockStatus: 'unknown' }, { stockStatus: '' }, [['stockStatus', 'low'], ['stockStatus', 'in_stock']],
    ]) {
      const response = await getInventory(cookie, filters);
      assert.equal(response.status, 400, JSON.stringify(filters));
      assert.equal((await response.json()).error.code, 'validation_failed');
    }
  });

  it('shows committed stock changes at each tracked location to staff and managers', async (t) => {
    const staff = await signIn('staff');
    const manager = await signIn('manager');
    const { productId, locationId } = await createStockFixture(db.pool);
    const { rows: [product] } = await db.pool.query('SELECT sku FROM products WHERE id = $1', [productId]);
    const { rows: [pantry] } = await db.pool.query("INSERT INTO locations (name) VALUES ('Pantry') RETURNING id");
    await db.pool.query("INSERT INTO locations (name) VALUES ('Untracked')");

    assert.deepEqual(await readInventory(staff.cookie), { inventory: [] });
    const storeroomRow = {
      id: `${productId}:${locationId}`, productId, sku: product.sku, name: 'Rice', locationId,
      location: 'Test storeroom', quantity: 8, reorderThreshold: null, stockStatus: 'in_stock',
      productArchived: false, locationArchived: false,
    };
    const stock = { productId, locationId, quantity: 8 };
    const receive = await post('/api/stock-operations/receive', stock, staff.cookie);
    assert.equal(receive.status, 200);
    assert.deepEqual(await readInventory(manager.cookie), { inventory: [storeroomRow] });

    const issue = await post('/api/stock-operations/issue', { ...stock, quantity: 3 }, manager.cookie);
    assert.equal(issue.status, 200);
    const transfer = await post('/api/stock-operations/transfer', {
      productId, sourceLocationId: locationId, destinationLocationId: pantry.id, quantity: 5,
    }, staff.cookie);
    assert.equal(transfer.status, 200);
    const pantryRow = {
      ...storeroomRow, id: `${productId}:${pantry.id}`, locationId: pantry.id, location: 'Pantry', quantity: 5,
    };
    const emptyStoreroom = { ...storeroomRow, quantity: 0, stockStatus: 'out_of_stock' };
    assert.deepEqual(await readInventory(staff.cookie), { inventory: [pantryRow, emptyStoreroom] });

    const oatsId = '9007199254740993';
    await db.pool.query(
      `INSERT INTO products (id, sku, name, category_id) OVERRIDING SYSTEM VALUE
       SELECT $1, 'OATS', 'Oats', category_id FROM products WHERE id = $2`,
      [oatsId, productId],
    );
    const oatsReceipt = await post('/api/stock-operations/receive', { productId: oatsId, locationId, quantity: 2 }, staff.cookie);
    assert.equal(oatsReceipt.status, 200);
    const oatsRow = {
      ...storeroomRow, id: `${oatsId}:${locationId}`, productId: oatsId, sku: 'OATS', name: 'Oats', quantity: 2,
    };
    await db.pool.query('UPDATE products SET archived_at = now() WHERE id = $1', [productId]);
    await db.pool.query('UPDATE locations SET archived_at = now() WHERE id = $1', [pantry.id]);
    assert.deepEqual(await readInventory(manager.cookie), { inventory: [
      oatsRow,
      { ...pantryRow, productArchived: true, locationArchived: true },
      { ...emptyStoreroom, productArchived: true },
    ] });

    await t.test('matches each filter and intersects all filters without losing archived or zero balances', async () => {
      const riceAtPantry = pantryRow.id;
      const riceAtStore = emptyStoreroom.id;
      for (const [filters, expectedIds] of [
        [{ productId: '00' + productId }, [riceAtPantry, riceAtStore]],
        [{ productId: oatsId }, [oatsRow.id]],
        [{ locationId }, [oatsRow.id, riceAtStore]],
        [{ sku: ' OATS ' }, [oatsRow.id]],
        [{ sku: 'oats' }, []],
        [{ sku: 'OAT' }, []],
        [{ name: ' iC ' }, [riceAtPantry, riceAtStore]],
        [{ productId, locationId, sku: product.sku, name: 'rIcE' }, [riceAtStore]],
        [{ productId, locationId, sku: 'OATS', name: 'rice' }, []],
      ]) {
        const { inventory } = await readInventory(staff.cookie, filters);
        assert.deepEqual(inventory.map((row) => row.id), expectedIds, JSON.stringify(filters));
      }
    });

    await t.test('treats percent and underscore literally in product-name searches', async () => {
      await db.pool.query("UPDATE products SET name = 'Oats 100%_whole' WHERE id = $1", [oatsId]);
      for (const name of ['%', '_']) {
        const { inventory } = await readInventory(staff.cookie, { name });
        assert.deepEqual(inventory.map((row) => row.id), [oatsRow.id], name);
      }
    });
  });

  it('classifies each location from its current stock and its own manager-set threshold', async () => {
    const manager = await signIn('manager');
    const staff = await signIn('staff');
    const { productId, locationId } = await createStockFixture(db.pool);
    const pair = { productId, locationId };
    const { rows: [pantry] } = await db.pool.query("INSERT INTO locations (name) VALUES ('Pantry') RETURNING id");
    const pantryPair = { productId, locationId: pantry.id };
    assert.equal((await post('/api/stock-operations/receive', { ...pantryPair, quantity: 2 }, staff.cookie)).status, 200);
    assert.equal((await post('/api/stock-operations/receive', { ...pair, quantity: 8 }, manager.cookie)).status, 200);

    async function setThreshold(reorderThreshold) {
      const response = await patchThreshold(pair, { reorderThreshold }, manager.cookie);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ...pair, reorderThreshold });
    }

    async function checkStock(quantity, reorderThreshold, stockStatus) {
      const { inventory } = await readInventory(staff.cookie, { ...pair, stockStatus });
      assert.equal(inventory.length, 1);
      assert.equal(inventory[0].quantity, quantity);
      assert.equal(inventory[0].reorderThreshold, reorderThreshold);
      assert.equal(inventory[0].stockStatus, stockStatus);
    }

    const before = await readStockState(db.pool, { ...pair, actorId: manager.id });
    await setThreshold(5);
    const after = await readStockState(db.pool, { ...pair, actorId: manager.id });
    assert.deepEqual(after.movements, before.movements);
    assert.deepEqual(after.operations, before.operations);
    await checkStock(8, 5, 'in_stock');
    assert.equal((await post('/api/stock-operations/issue', { ...pair, quantity: 3 }, staff.cookie)).status, 200);
    await checkStock(5, 5, 'low');
    const low = await readInventory(staff.cookie, { productId, stockStatus: 'low' });
    assert.deepEqual(low.inventory.map((row) => row.locationId), [locationId]);
    const other = await readInventory(staff.cookie, pantryPair);
    assert.equal(other.inventory[0].reorderThreshold, null);
    assert.equal(other.inventory[0].stockStatus, 'in_stock');

    await setThreshold(2147483647);
    await checkStock(5, 2147483647, 'low');
    await setThreshold(null);
    await checkStock(5, null, 'in_stock');
    await setThreshold(0);
    await checkStock(5, 0, 'in_stock');
    assert.equal((await post('/api/stock-operations/issue', { ...pair, quantity: 5 }, staff.cookie)).status, 200);
    await checkStock(0, 0, 'out_of_stock');
    await setThreshold(null);
    await checkStock(0, null, 'out_of_stock');
    assert.equal((await post('/api/stock-operations/receive', { ...pair, quantity: 1 }, staff.cookie)).status, 200);
    await checkStock(1, null, 'in_stock');
    assert.deepEqual(await readInventory(staff.cookie, { ...pair, stockStatus: 'out_of_stock' }), { inventory: [] });
  });

  it('rejects unauthorized or invalid threshold edits without changing the tracked balance', async () => {
    const manager = await signIn('manager');
    const staff = await signIn('staff');
    const { productId, locationId } = await createStockFixture(db.pool);
    const pair = { productId, locationId };
    const body = { reorderThreshold: 4 };
    assert.equal((await post('/api/stock-operations/receive', { ...pair, quantity: 9 }, staff.cookie)).status, 200);
    const before = await readInventory(staff.cookie, pair);
    for (const invalid of [
      {}, [], { reorderThreshold: -1 }, { reorderThreshold: 1.5 }, { reorderThreshold: '5' },
      { reorderThreshold: true }, { reorderThreshold: 2147483648 }, { ...body, quantity: 1 },
    ]) {
      await assertError(await patchThreshold(pair, invalid, manager.cookie), 400, 'validation_failed');
    }
    for (const invalidPair of [{ ...pair, productId: '0' }, { ...pair, locationId: '9223372036854775808' }]) {
      await assertError(await patchThreshold(invalidPair, body, manager.cookie), 400, 'validation_failed');
    }
    await assertError(await patchThreshold(pair, body), 401, 'unauthenticated');
    await assertError(await patchThreshold(pair, body, staff.cookie), 403, 'forbidden');
    await db.pool.query("UPDATE users SET role = 'staff' WHERE id = $1", [manager.id]);
    await assertError(await patchThreshold(pair, body, manager.cookie), 403, 'forbidden');
    await db.pool.query("UPDATE users SET role = 'manager', disabled_at = now() WHERE id = $1", [manager.id]);
    await assertError(await patchThreshold(pair, body, manager.cookie), 401, 'unauthenticated');
    assert.deepEqual(await readInventory(staff.cookie, pair), before);
  });

  it('requires a tracked pair and excludes archived items from status filters and threshold edits', async () => {
    const { cookie } = await signIn('manager');
    const { productId, locationId } = await createStockFixture(db.pool);
    const pair = { productId, locationId };
    const body = { reorderThreshold: 2 };
    await assertError(await patchThreshold(pair, body, cookie), 404, 'not_found');
    assert.deepEqual(await readInventory(cookie, pair), { inventory: [] });

    assert.equal((await post('/api/stock-operations/receive', { ...pair, quantity: 2 }, cookie)).status, 200);
    assert.equal((await patchThreshold(pair, body, cookie)).status, 200);
    await db.pool.query('UPDATE locations SET archived_at = now() WHERE id = $1', [locationId]);
    await assertError(await patchThreshold(pair, { reorderThreshold: null }, cookie), 409, 'location_archived');
    assert.deepEqual(await readInventory(cookie, { ...pair, stockStatus: 'low' }), { inventory: [] });

    await db.pool.query('UPDATE locations SET archived_at = NULL WHERE id = $1', [locationId]);
    await db.pool.query('UPDATE products SET archived_at = now() WHERE id = $1', [productId]);
    await assertError(await patchThreshold(pair, { reorderThreshold: null }, cookie), 409, 'product_archived');
    assert.deepEqual(await readInventory(cookie, { ...pair, stockStatus: 'low' }), { inventory: [] });
    const { inventory } = await readInventory(cookie, pair);
    assert.equal(inventory.length, 1);
    assert.equal(inventory[0].reorderThreshold, 2);
    assert.equal(inventory[0].stockStatus, 'low');
    assert.equal(inventory[0].productArchived, true);
  });

  it('preserves both changes when a threshold edit and an issue overlap', async () => {
    const manager = await signIn('manager');
    const staff = await signIn('staff');
    const { productId, locationId } = await createStockFixture(db.pool);
    const pair = { productId, locationId };
    assert.equal((await post('/api/stock-operations/receive', { ...pair, quantity: 6 }, staff.cookie)).status, 200);
    const results = await runConcurrently(db.pool, db.databaseName, [
      () => patchThreshold(pair, { reorderThreshold: 4 }, manager.cookie),
      () => post('/api/stock-operations/issue', { ...pair, quantity: 2 }, staff.cookie),
    ]);
    for (const result of results) {
      assert.equal(result.status, 'fulfilled');
      assert.equal(result.value.status, 200);
    }
    const { inventory } = await readInventory(staff.cookie, { ...pair, stockStatus: 'low' });
    assert.equal(inventory.length, 1);
    assert.equal(inventory[0].quantity, 4);
    assert.equal(inventory[0].reorderThreshold, 4);
  });
});
