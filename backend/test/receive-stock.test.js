import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { receiveStock } from '../src/stock/receive-stock.js';
import {
  createTestDatabase, createStockFixture, readStockState, runConcurrently,
} from './helpers/stock-database.js';

let testDatabase;
let pool;

before(async () => {
  testDatabase = await createTestDatabase();
  pool = testDatabase.pool;
});

after(async () => {
  await testDatabase?.close();
});

function createFixture(role = 'staff') {
  return createStockFixture(pool, role);
}

function readState(request) {
  return readStockState(pool, request);
}

function receiveConcurrently(requests) {
  return runConcurrently(pool, testDatabase.databaseName,
    requests.map((request) => () => receiveStock(pool, request)));
}

describe('receiveStock with PostgreSQL', { concurrency: false, timeout: 20_000 }, () => {
  it('creates the first balance and records its operation, movement, and saved result', async () => {
    const request = await createFixture();
    const result = await receiveStock(pool, { ...request, reason: 'Delivery' });
    const state = await readState(request);

    assert.equal(state.inventory.quantity, 10);
    assert.equal(state.operations.length, 1);
    assert.equal(state.movements.length, 1);
    assert.deepEqual(result, {
      operationId: state.operations[0].id,
      movementId: state.movements[0].id,
      productId: request.productId,
      locationId: request.locationId,
      quantityReceived: 10,
      quantityAfter: 10,
    });
    assert.equal(state.operations[0].operation, 'receive');
    assert.equal(state.operations[0].reason, 'Delivery');
    assert.deepEqual(state.operations[0].saved_result, result);
    assert.equal(state.movements[0].operation_id, result.operationId);
    assert.equal(state.movements[0].quantity_delta, 10);
    assert.equal(state.movements[0].quantity_after, 10);
  });

  it('adds to existing stock and preserves its threshold', async () => {
    const request = await createFixture('manager');
    await pool.query(
      'INSERT INTO inventory (product_id, location_id, quantity, reorder_threshold) VALUES ($1, $2, 5, 3)',
      [request.productId, request.locationId],
    );
    const result = await receiveStock(pool, request);
    const state = await readState(request);
    assert.equal(result.quantityAfter, 15);
    assert.equal(state.inventory.quantity, 15);
    assert.equal(state.inventory.reorder_threshold, 3);
    assert.equal(state.movements[0].quantity_after, 15);
  });

  it('treats submissions without request keys as independent receipts', async () => {
    const request = await createFixture();
    delete request.clientRequestKey;
    await receiveStock(pool, request);
    await receiveStock(pool, { ...request, clientRequestKey: null });
    const state = await readState(request);
    assert.equal(state.inventory.quantity, 20);
    assert.equal(state.operations.length, 2);
    assert.equal(state.movements.length, 2);
  });

  it('returns the saved result on retry even after another receipt changes the balance', async () => {
    const request = await createFixture();
    const original = await receiveStock(pool, request);
    await receiveStock(pool, { ...request, clientRequestKey: randomUUID() });
    const replay = await receiveStock(pool, request);
    assert.deepEqual(replay, original);
    const state = await readState(request);
    assert.equal(state.inventory.quantity, 20);
    assert.equal(state.operations.length, 2);
    assert.equal(state.movements.length, 2);
  });

  it('compares numeric and decimal-string IDs consistently on retries', async () => {
    const request = await createFixture();
    const original = await receiveStock(pool, {
      ...request,
      actorId: Number(request.actorId),
      productId: Number(request.productId),
      locationId: Number(request.locationId),
    });
    const replay = await receiveStock(pool, {
      ...request,
      actorId: `00${request.actorId}`,
      productId: `00${request.productId}`,
      locationId: `00${request.locationId}`,
      reason: null,
    });
    assert.deepEqual(replay, original);
    assert.equal((await readState(request)).inventory.quantity, 10);
  });

  it('preserves bigint IDs beyond JavaScript safe integer precision', async () => {
    const request = await createFixture();
    await pool.query(
      `INSERT INTO users (id, name, email, password_hash, role) OVERRIDING SYSTEM VALUE
       SELECT $1, name, 'bigint-' || email, password_hash, role FROM users WHERE id = $2`,
      ['9007199254740993', request.actorId],
    );
    await pool.query(
      `INSERT INTO products (id, sku, name, category_id) OVERRIDING SYSTEM VALUE
       SELECT $1, 'BIG' || sku, name, category_id FROM products WHERE id = $2`,
      ['9007199254740995', request.productId],
    );
    await pool.query(
      `INSERT INTO locations (id, name) OVERRIDING SYSTEM VALUE
       SELECT $1, name FROM locations WHERE id = $2`,
      ['9007199254740997', request.locationId],
    );
    Object.assign(request, {
      actorId: '9007199254740993', productId: '9007199254740995', locationId: '9007199254740997',
    });
    const result = await receiveStock(pool, request);
    assert.equal(result.productId, request.productId);
    assert.equal(result.locationId, request.locationId);
    assert.deepEqual(await receiveStock(pool, request), result);
    assert.equal((await readState(request)).operations[0].actor_id, request.actorId);
  });

  it('rejects a reused key when the requested quantity, product, location, or reason changes', async () => {
    const request = await createFixture();
    await receiveStock(pool, request);
    for (const change of [
      { quantity: 11 }, { productId: '9223372036854775807' },
      { locationId: '9223372036854775807' }, { reason: 'Another delivery' },
    ]) {
      await assert.rejects(receiveStock(pool, { ...request, ...change }), { code: 'REQUEST_KEY_CONFLICT' });
    }
    const state = await readState(request);
    assert.equal(state.inventory.quantity, 10);
    assert.equal(state.operations.length, 1);
    assert.equal(state.movements.length, 1);
  });

  it('allows different actors to use the same request key', async () => {
    const request = await createFixture();
    const anotherActor = await createFixture('manager');
    const first = await receiveStock(pool, request);
    const second = await receiveStock(pool, { ...request, actorId: anotherActor.actorId });
    assert.notEqual(first.operationId, second.operationId);
    const state = await readState(request);
    assert.equal(state.inventory.quantity, 20);
    assert.equal(state.movements.length, 2);
  });

  it('rejects a key belonging to another operation type', async () => {
    const request = await createFixture();
    await receiveStock(pool, request);
    const key = randomUUID();
    await pool.query(
      `INSERT INTO stock_operations (actor_id, operation, client_request_key, request_details, saved_result)
       SELECT actor_id, 'issue', $1, request_details, saved_result
       FROM stock_operations WHERE actor_id = $2 AND client_request_key = $3`,
      [key, request.actorId, request.clientRequestKey],
    );
    await assert.rejects(receiveStock(pool, { ...request, clientRequestKey: key }), { code: 'REQUEST_KEY_CONFLICT' });
    assert.equal((await readState(request)).inventory.quantity, 10);
  });

  it('rejects an existing operation with no saved result', async () => {
    const request = await createFixture();
    await receiveStock(pool, request);
    const key = randomUUID();
    await pool.query(
      `INSERT INTO stock_operations (actor_id, operation, client_request_key, request_details)
       SELECT actor_id, operation, $1, request_details
       FROM stock_operations WHERE actor_id = $2 AND client_request_key = $3`,
      [key, request.actorId, request.clientRequestKey],
    );
    await assert.rejects(receiveStock(pool, { ...request, clientRequestKey: key }), { code: 'OPERATION_INCOMPLETE' });
    assert.equal((await readState(request)).inventory.quantity, 10);
  });

  it('rejects invalid inputs before recording stock', async () => {
    const request = await createFixture();
    for (const quantity of [0, -1, 1.5, '10', 2_147_483_648, NaN, Infinity]) {
      await assert.rejects(receiveStock(pool, { ...request, quantity }), { code: 'INVALID_INPUT' });
    }
    for (const field of ['actorId', 'productId', 'locationId']) {
      for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '', 'abc', '9223372036854775808']) {
        await assert.rejects(receiveStock(pool, { ...request, [field]: value }), { code: 'INVALID_INPUT' });
      }
    }
    for (const change of [{ reason: 42 }, { clientRequestKey: '' }, { clientRequestKey: '  ' }, { clientRequestKey: 7 }]) {
      await assert.rejects(receiveStock(pool, { ...request, ...change }), { code: 'INVALID_INPUT' });
    }
    assert.deepEqual(await readState(request), { inventory: undefined, operations: [], movements: [] });
  });

  it('rejects missing actors, products, and locations', async () => {
    const request = await createFixture();
    for (const [field, code] of [
      ['actorId', 'ACTOR_NOT_FOUND'], ['productId', 'PRODUCT_NOT_FOUND'], ['locationId', 'LOCATION_NOT_FOUND'],
    ]) {
      await assert.rejects(receiveStock(pool, { ...request, [field]: '9223372036854775807' }), { code });
    }
    assert.deepEqual(await readState(request), { inventory: undefined, operations: [], movements: [] });
  });

  it('rejects disabled users and archived products or locations', async () => {
    for (const [table, column, field, code] of [
      ['users', 'disabled_at', 'actorId', 'ACTOR_DISABLED'],
      ['products', 'archived_at', 'productId', 'PRODUCT_ARCHIVED'],
      ['locations', 'archived_at', 'locationId', 'LOCATION_ARCHIVED'],
    ]) {
      const request = await createFixture();
      await pool.query(`UPDATE ${table} SET ${column} = CURRENT_TIMESTAMP WHERE id = $1`, [request[field]]);
      await assert.rejects(receiveStock(pool, request), { code });
      assert.deepEqual(await readState(request), { inventory: undefined, operations: [], movements: [] });
    }
  });

  it('replays a completed receipt after archival, but rejects new receipts and disabled actors', async () => {
    const request = await createFixture();
    const original = await receiveStock(pool, request);
    await pool.query('UPDATE products SET archived_at = CURRENT_TIMESTAMP WHERE id = $1', [request.productId]);
    await pool.query('UPDATE locations SET archived_at = CURRENT_TIMESTAMP WHERE id = $1', [request.locationId]);
    assert.deepEqual(await receiveStock(pool, request), original);
    await assert.rejects(receiveStock(pool, { ...request, clientRequestKey: randomUUID() }), { code: 'PRODUCT_ARCHIVED' });
    await pool.query('UPDATE users SET disabled_at = CURRENT_TIMESTAMP WHERE id = $1', [request.actorId]);
    await assert.rejects(receiveStock(pool, request), { code: 'ACTOR_DISABLED' });
    assert.equal((await readState(request)).inventory.quantity, 10);
  });

  it('rejects an overflowing balance and rolls back the attempted operation', async () => {
    const request = await createFixture();
    await receiveStock(pool, { ...request, quantity: 2_147_483_647 });
    const before = await readState(request);
    await assert.rejects(
      receiveStock(pool, { ...request, quantity: 1, clientRequestKey: randomUUID() }),
      { code: 'QUANTITY_OVERFLOW' },
    );
    assert.deepEqual(await readState(request), before);
  });

  it('includes both concurrent first receipts in one inventory row', async () => {
    const request = await createFixture();
    const outcomes = await receiveConcurrently([
      request, { ...request, quantity: 7, clientRequestKey: randomUUID() },
    ]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ['fulfilled', 'fulfilled']);
    const state = await readState(request);
    assert.equal(state.inventory.quantity, 17);
    assert.equal(state.operations.length, 2);
    assert.equal(state.movements.length, 2);
    assert.equal(state.movements.reduce((sum, movement) => sum + movement.quantity_delta, 0), 17);
    assert.equal(state.movements.at(-1).quantity_after, 17);
  });

  it('applies concurrent requests sharing a retry key exactly once', async () => {
    const request = await createFixture();
    const outcomes = await receiveConcurrently([request, request]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ['fulfilled', 'fulfilled']);
    assert.deepEqual(outcomes[0].value, outcomes[1].value);
    const state = await readState(request);
    assert.equal(state.inventory.quantity, 10);
    assert.equal(state.operations.length, 1);
    assert.equal(state.movements.length, 1);
  });

  it('rejects one of two concurrent different requests sharing a key', async () => {
    const request = await createFixture();
    const outcomes = await receiveConcurrently([request, { ...request, quantity: 7 }]);
    const succeeded = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const failed = outcomes.filter((outcome) => outcome.status === 'rejected');
    assert.equal(succeeded.length, 1);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].reason.code, 'REQUEST_KEY_CONFLICT');
    const state = await readState(request);
    assert.equal(state.inventory.quantity, succeeded[0].value.quantityReceived);
    assert.equal(state.operations.length, 1);
    assert.equal(state.movements.length, 1);
  });

  it('rolls back a database failure after balance writes and allows retrying the same key', async () => {
    await pool.query(`
      CREATE FUNCTION fail_test_movement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (SELECT quantity FROM inventory
            WHERE product_id = NEW.product_id AND location_id = NEW.location_id) = NEW.quantity_after THEN
          RAISE EXCEPTION 'Forced failure after inventory update';
        END IF;
        RAISE EXCEPTION 'Expected inventory update before movement';
      END;
      $$;
    `);
    try {
      for (const initialQuantity of [null, 5]) {
        const request = await createFixture();
        if (initialQuantity !== null) {
          await pool.query('INSERT INTO inventory (product_id, location_id, quantity) VALUES ($1, $2, $3)',
            [request.productId, request.locationId, initialQuantity]);
        }
        const before = await readState(request);
        await pool.query(`
          CREATE TRIGGER fail_test_receipt BEFORE INSERT ON stock_movements
          FOR EACH ROW WHEN (NEW.product_id = ${request.productId})
          EXECUTE FUNCTION fail_test_movement()
        `);
        try {
          await assert.rejects(receiveStock(pool, request), {
            code: 'P0001', message: 'Forced failure after inventory update',
          });
          assert.deepEqual(await readState(request), before);
        } finally {
          await pool.query('DROP TRIGGER fail_test_receipt ON stock_movements');
        }
        const retried = await receiveStock(pool, request);
        assert.equal(retried.quantityAfter, (initialQuantity ?? 0) + 10);
        assert.equal((await readState(request)).operations.length, 1);
      }
    } finally {
      await pool.query('DROP FUNCTION fail_test_movement()');
    }
  });
});
