import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { sessionMiddleware } from '../src/auth/session.js';
import { closeServer, startApp } from './helpers.js';
import { createStockFixture, createTestDatabase, readStockState } from './helpers/stock-database.js';

const sessionSecret = randomUUID();
const stockPath = '/api/stock-operations';
let database;
let server;

before(async () => {
  database = await createTestDatabase();
  server = await startApp({ pool: database.pool, sessionSecret });
});

after(async () => {
  try {
    await server?.close();
  } finally {
    await database?.close();
  }
});

function post(path, body, cookie, url = server.url) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  return fetch(url + path, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function ok(response) {
  const json = await response.json();
  assert.equal(response.status, 200, JSON.stringify(json));
  return json;
}

async function expectError(response, status, code) {
  const json = await response.json();
  assert.equal(response.status, status, JSON.stringify(json));
  assert.equal(json.error.code, code);
  assert.equal(typeof json.error.message, 'string');
  assert.ok(response.headers.get('x-request-id'));
}

// A separate, short-lived test app performs the handoff expected from the login handler.
async function createSessionFixture(role = 'staff') {
  const fixture = await createStockFixture(database.pool, role);
  const issuer = express();
  issuer.use('/api', sessionMiddleware(database.pool, sessionSecret, false));
  issuer.post('/api/test-session', (req, res) => {
    req.session.userId = fixture.actorId;
    res.sendStatus(204);
  });
  const listener = issuer.listen(0, '127.0.0.1');
  try {
    await once(listener, 'listening');
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/test-session`, { method: 'POST' });
    assert.equal(response.status, 204);
    const setCookie = response.headers.get('set-cookie');
    assert.match(setCookie, /^connect\.sid=/);
    assert.match(setCookie, /;\s*HttpOnly\b/i);
    return { fixture, cookie: setCookie.split(';')[0] };
  } finally {
    await closeServer(listener);
  }
}

describe('stock routes with authenticated PostgreSQL sessions', () => {
  it('rejects missing, invalidly signed, and expired sessions before changing inventory', async () => {
    const { fixture, cookie } = await createSessionFixture();
    const body = { productId: fixture.productId, locationId: fixture.locationId, quantity: 3 };
    await expectError(await post(stockPath + '/receive', body), 401, 'unauthenticated');
    await expectError(await post(stockPath + '/receive', body, cookie + 'invalid'), 401, 'unauthenticated');
    const expired = await database.pool.query(
      "UPDATE sessions SET expire = now() - interval '1 day' WHERE sess->>'userId' = $1",
      [fixture.actorId],
    );
    assert.equal(expired.rowCount, 1);
    await expectError(await post(stockPath + '/receive', body, cookie), 401, 'unauthenticated');
    assert.equal((await readStockState(database.pool, fixture)).operations.length, 0);
  });

  it('receives, issues, and transfers stock, with one actor and signed movements in history', async () => {
    const { fixture, cookie } = await createSessionFixture();
    const { productId, locationId, actorId } = fixture;
    const destination = await database.pool.query("INSERT INTO locations (name) VALUES ('Pantry') RETURNING id");
    const destinationId = destination.rows[0].id;
    const receipt = { productId: Number(productId), locationId, quantity: 10, clientRequestKey: randomUUID() };
    const received = await ok(await post(stockPath + '/receive', receipt, cookie));
    assert.equal(received.productId, productId);
    assert.equal(received.locationId, locationId);
    assert.equal(received.quantityReceived, 10);
    assert.equal(received.quantityAfter, 10);
    const issued = await ok(await post(stockPath + '/issue', { productId, locationId, quantity: 2 }, cookie));
    assert.equal(issued.quantityIssued, 2);
    assert.equal(issued.quantityAfter, 8);
    assert.deepEqual(await ok(await post(stockPath + '/receive', receipt, cookie)), received);
    const transfer = await ok(await post(stockPath + '/transfer', {
      productId, sourceLocationId: locationId, destinationLocationId: destinationId, quantity: 3,
    }, cookie));
    assert.equal(transfer.sourceLocationId, locationId);
    assert.equal(transfer.destinationLocationId, destinationId);
    assert.equal(transfer.quantityTransferred, 3);
    assert.equal(transfer.sourceQuantityAfter, 5);
    assert.equal(transfer.destinationQuantityAfter, 3);

    const { inventory, operations, movements } = await readStockState(database.pool, fixture);
    assert.equal(inventory.quantity, 5);
    assert.deepEqual(operations.map((op) => [op.id, op.actor_id, op.operation]), [
      [received.operationId, actorId, 'receive'], [issued.operationId, actorId, 'issue'],
      [transfer.operationId, actorId, 'transfer'],
    ]);
    assert.deepEqual(movements.map((m) => [m.id, m.operation_id, m.location_id, m.quantity_delta]), [
      [received.movementId, received.operationId, locationId, 10],
      [issued.movementId, issued.operationId, locationId, -2],
      [transfer.sourceMovementId, transfer.operationId, locationId, -3],
      [transfer.destinationMovementId, transfer.operationId, destinationId, 3],
    ]);
  });

  it('returns ordinary and large IDs as exact decimal strings on receipt and replay', async () => {
    const { fixture, cookie } = await createSessionFixture();
    const productId = '9007199254740993';
    await database.pool.query(
      `INSERT INTO products (id, sku, name, category_id) OVERRIDING SYSTEM VALUE
       SELECT $1, sku || 'G', name, category_id FROM products WHERE id = $2`,
      [productId, fixture.productId],
    );
    const body = { productId, locationId: fixture.locationId, quantity: 5, clientRequestKey: fixture.clientRequestKey };
    const result = await ok(await post(stockPath + '/receive', body, cookie));
    assert.equal(result.productId, productId);
    assert.equal(result.locationId, fixture.locationId);
    assert.match(result.operationId, /^[1-9]\d*$/);
    assert.match(result.movementId, /^[1-9]\d*$/);
    assert.deepEqual(await ok(await post(stockPath + '/receive', body, cookie)), result);
    const { inventory, movements } = await readStockState(database.pool, { ...fixture, productId });
    assert.equal(inventory.quantity, 5);
    assert.equal(movements.length, 1);
  });

  it('requires a session, rejects caller-supplied identity or role, and reserves corrections for managers', async () => {
    const staff = await createSessionFixture();
    const manager = await createSessionFixture('manager');
    const { productId, locationId } = staff.fixture;
    const correction = { productId, locationId, quantityDelta: 2, reason: 'Physical recount' };
    await expectError(await post(stockPath + '/correction', correction), 401, 'unauthenticated');
    for (const field of [{ actorId: manager.fixture.actorId }, { role: 'manager' }]) {
      await expectError(await post(stockPath + '/receive', { productId, locationId, quantity: 1, ...field }, staff.cookie),
        400, 'validation_failed');
    }
    await expectError(await post(stockPath + '/correction', correction, staff.cookie), 403, 'forbidden');
    const corrected = await ok(await post(stockPath + '/correction', correction, manager.cookie));
    assert.equal(corrected.quantityDelta, 2);
    assert.equal(corrected.quantityAfter, 2);
    const op = await database.pool.query('SELECT actor_id, reason FROM stock_operations WHERE id = $1', [corrected.operationId]);
    assert.deepEqual(op.rows, [{ actor_id: manager.fixture.actorId, reason: correction.reason }]);
  });

  it('maps invalid input, insufficient stock, missing products, and conflicting retry keys to HTTP errors', async () => {
    const { fixture, cookie } = await createSessionFixture();
    const { productId, locationId, clientRequestKey } = fixture;
    const receipt = { productId, locationId, quantity: 1, clientRequestKey };
    await expectError(await post(stockPath + '/receive', { ...receipt, quantity: 0 }, cookie), 400, 'validation_failed');
    await expectError(await post(stockPath + '/issue', receipt, cookie), 409, 'insufficient_stock');
    await expectError(await post(stockPath + '/receive', { ...receipt, productId: '9223372036854775807' }, cookie), 404, 'not_found');
    await ok(await post(stockPath + '/receive', receipt, cookie));
    await expectError(await post(stockPath + '/receive', { ...receipt, quantity: 2 }, cookie), 409, 'request_key_conflict');
    const state = await readStockState(database.pool, fixture);
    assert.equal(state.inventory.quantity, 1);
    assert.equal(state.movements.length, 1);
  });

  it('recognizes the same session and retry key on a second replica', async () => {
    const { fixture, cookie } = await createSessionFixture();
    const { productId, locationId, quantity, clientRequestKey } = fixture;
    const receipt = { productId, locationId, quantity, clientRequestKey };
    const result = await ok(await post(stockPath + '/receive', receipt, cookie));
    const replica = await startApp({ pool: database.pool, sessionSecret });
    try {
      assert.deepEqual(await ok(await post(stockPath + '/receive', receipt, cookie, replica.url)), result);
      assert.equal((await readStockState(database.pool, fixture)).movements.length, 1);
    } finally {
      await replica.close();
    }
  });

  it('rejects a valid cookie when the server has no session secret configured', async () => {
    const { fixture, cookie } = await createSessionFixture();
    const unconfigured = await startApp({ pool: database.pool, sessionSecret: undefined });
    try {
      const receipt = { productId: fixture.productId, locationId: fixture.locationId, quantity: 3 };
      await expectError(await post(stockPath + '/receive', receipt, cookie, unconfigured.url), 401, 'unauthenticated');
      assert.equal((await readStockState(database.pool, fixture)).operations.length, 0);
    } finally {
      await unconfigured.close();
    }
  });

  it('rechecks the session user before a retry after account deactivation', async () => {
    const { fixture, cookie } = await createSessionFixture();
    const { productId, locationId, quantity, clientRequestKey } = fixture;
    const receipt = { productId, locationId, quantity, clientRequestKey };
    await ok(await post(stockPath + '/receive', receipt, cookie));
    await database.pool.query('UPDATE users SET disabled_at = now() WHERE id = $1', [fixture.actorId]);
    await expectError(await post(stockPath + '/receive', receipt, cookie), 401, 'unauthenticated');
    assert.equal((await readStockState(database.pool, fixture)).movements.length, 1);
  });

  it('keeps unexpected database error details out of HTTP responses and rolls back stock', async () => {
    const { fixture, cookie } = await createSessionFixture();
    await database.pool.query('ALTER TABLE stock_movements ADD CONSTRAINT test_stock_http_failure CHECK (quantity_delta <> 91)');
    try {
      const receipt = { productId: fixture.productId, locationId: fixture.locationId, quantity: 91 };
      const response = await post(stockPath + '/receive', receipt, cookie);
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: { code: 'internal_error', message: 'Internal server error' } });
      const state = await readStockState(database.pool, fixture);
      assert.equal(state.inventory, undefined);
      assert.equal(state.operations.length, 0);
      assert.equal(state.movements.length, 0);
    } finally {
      await database.pool.query('ALTER TABLE stock_movements DROP CONSTRAINT test_stock_http_failure');
    }
  });
});
