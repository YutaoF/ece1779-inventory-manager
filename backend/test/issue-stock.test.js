import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { issueStock, StockError } from '../src/stock/issue-stock.js';
import { receiveStock, StockError as ReceiveStockError } from '../src/stock/receive-stock.js';
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

async function createFixture(initialQuantity = 10, role = 'staff') {
  const request = await createStockFixture(pool, role);
  request.quantity = 4;
  if (initialQuantity !== null) {
    await pool.query(
      `INSERT INTO inventory (product_id, location_id, quantity, reorder_threshold)
       VALUES ($1, $2, $3, 3)`,
      [request.productId, request.locationId, initialQuantity],
    );
  }
  return request;
}

function readState(request) {
  return readStockState(pool, request);
}

function issueConcurrently(requests) {
  return runConcurrently(pool, testDatabase.databaseName,
    requests.map((request) => () => issueStock(pool, request)));
}

describe('issueStock with PostgreSQL', { concurrency: false, timeout: 20_000 }, () => {
  it('decrements inventory and records a negative movement and saved result', async () => {
    assert.equal(StockError, ReceiveStockError);
    const request = await createFixture();
    const result = await issueStock(pool, { ...request, reason: 'Distributed to volunteers' });
    const state = await readState(request);

    assert.equal(state.inventory.quantity, 6);
    assert.equal(state.inventory.reorder_threshold, 3);
    assert.equal(state.operations.length, 1);
    assert.equal(state.movements.length, 1);
    assert.deepEqual(result, {
      operationId: state.operations[0].id,
      movementId: state.movements[0].id,
      productId: request.productId,
      locationId: request.locationId,
      quantityIssued: 4,
      quantityAfter: 6,
    });
    assert.equal(state.operations[0].operation, 'issue');
    assert.equal(state.operations[0].reason, 'Distributed to volunteers');
    assert.deepEqual(state.operations[0].saved_result, result);
    assert.equal(state.movements[0].operation_id, result.operationId);
    assert.equal(state.movements[0].quantity_delta, -4);
    assert.equal(state.movements[0].quantity_after, 6);
  });

  it('allows a manager to issue the exact remaining quantity and retains the zero balance', async () => {
    const request = await createFixture(4, 'manager');
    const result = await issueStock(pool, request);
    const state = await readState(request);
    assert.equal(result.quantityAfter, 0);
    assert.equal(state.inventory.quantity, 0);
    assert.equal(state.inventory.reorder_threshold, 3);
    assert.equal(state.movements[0].quantity_delta, -4);
  });

  it('rejects insufficient, empty, and untracked stock without persisting writes', async () => {
    for (const initialQuantity of [3, 0, null]) {
      const request = await createFixture(initialQuantity);
      const before = await readState(request);
      await assert.rejects(issueStock(pool, request), (error) => {
        assert.ok(error instanceof StockError);
        assert.equal(error.code, 'INSUFFICIENT_STOCK');
        assert.deepEqual(error.details, { available: initialQuantity ?? 0 });
        return true;
      });
      assert.deepEqual(await readState(request), before);
    }
  });

  it('allows the failed issue key to be retried after stock is replenished', async () => {
    const request = await createFixture(null);
    await assert.rejects(issueStock(pool, request), { code: 'INSUFFICIENT_STOCK' });
    await receiveStock(pool, { ...request, quantity: 5, clientRequestKey: randomUUID() });
    const result = await issueStock(pool, request);
    const state = await readState(request);
    assert.equal(result.quantityAfter, 1);
    assert.equal(state.inventory.quantity, 1);
    assert.deepEqual(state.operations.map((operation) => operation.operation), ['receive', 'issue']);
    assert.deepEqual(state.movements.map((movement) => movement.quantity_delta), [5, -4]);
  });

  it('returns the original result after later issues exhaust the remaining stock', async () => {
    const request = await createFixture(8);
    const original = await issueStock(pool, request);
    await issueStock(pool, { ...request, clientRequestKey: randomUUID() });
    assert.deepEqual(await issueStock(pool, request), original);
    const state = await readState(request);
    assert.equal(original.quantityAfter, 4);
    assert.equal(state.inventory.quantity, 0);
    assert.equal(state.operations.length, 2);
    assert.equal(state.movements.length, 2);
  });

  it('treats issues without request keys as independent operations', async () => {
    const request = await createFixture();
    delete request.clientRequestKey;
    await issueStock(pool, request);
    await issueStock(pool, { ...request, clientRequestKey: null });
    const state = await readState(request);
    assert.equal(state.inventory.quantity, 2);
    assert.equal(state.operations.length, 2);
    assert.deepEqual(state.movements.map((movement) => movement.quantity_delta), [-4, -4]);
  });

  it('rejects a retry with changed quantity, product, location, or reason', async () => {
    const request = await createFixture();
    await issueStock(pool, request);
    const before = await readState(request);
    for (const change of [
      { quantity: 3 }, { productId: '9223372036854775807' },
      { locationId: '9223372036854775807' }, { reason: 'Different request' },
    ]) {
      await assert.rejects(issueStock(pool, { ...request, ...change }), { code: 'REQUEST_KEY_CONFLICT' });
    }
    assert.deepEqual(await readState(request), before);
  });

  it('keeps receipt and issue keys in the same per-actor namespace', async () => {
    const request = await createFixture();
    await receiveStock(pool, request);
    const afterReceipt = await readState(request);
    await assert.rejects(issueStock(pool, request), { code: 'REQUEST_KEY_CONFLICT' });
    assert.deepEqual(await readState(request), afterReceipt);

    const issueRequest = { ...request, clientRequestKey: randomUUID() };
    await issueStock(pool, issueRequest);
    const afterIssue = await readState(request);
    await assert.rejects(receiveStock(pool, issueRequest), { code: 'REQUEST_KEY_CONFLICT' });
    assert.deepEqual(await readState(request), afterIssue);
  });

  it('compares numeric and decimal-string IDs consistently on issue retries', async () => {
    const request = await createFixture();
    const result = await issueStock(pool, {
      ...request,
      actorId: Number(request.actorId),
      productId: Number(request.productId),
      locationId: Number(request.locationId),
    });
    assert.deepEqual(await issueStock(pool, {
      ...request,
      actorId: `00${request.actorId}`,
      productId: `00${request.productId}`,
      locationId: `00${request.locationId}`,
      reason: null,
    }), result);
    assert.equal((await readState(request)).inventory.quantity, 6);
  });

  it('rejects invalid issue quantities and keys before changing stock', async () => {
    const request = await createFixture();
    const before = await readState(request);
    for (const quantity of [0, -4, 1.5, '4', 2_147_483_648, NaN]) {
      await assert.rejects(issueStock(pool, { ...request, quantity }), { code: 'INVALID_INPUT' });
    }
    await assert.rejects(issueStock(pool, { ...request, clientRequestKey: ' ' }), { code: 'INVALID_INPUT' });
    assert.deepEqual(await readState(request), before);
  });

  it('rejects missing or inactive actors, products, and locations', async () => {
    const missingRequest = await createFixture();
    const beforeMissing = await readState(missingRequest);
    for (const [field, code] of [
      ['actorId', 'ACTOR_NOT_FOUND'], ['productId', 'PRODUCT_NOT_FOUND'], ['locationId', 'LOCATION_NOT_FOUND'],
    ]) {
      await assert.rejects(issueStock(pool, { ...missingRequest, [field]: '9223372036854775807' }), { code });
    }
    assert.deepEqual(await readState(missingRequest), beforeMissing);

    for (const [table, column, field, code] of [
      ['users', 'disabled_at', 'actorId', 'ACTOR_DISABLED'],
      ['products', 'archived_at', 'productId', 'PRODUCT_ARCHIVED'],
      ['locations', 'archived_at', 'locationId', 'LOCATION_ARCHIVED'],
    ]) {
      const request = await createFixture();
      await pool.query(`UPDATE ${table} SET ${column} = CURRENT_TIMESTAMP WHERE id = $1`, [request[field]]);
      const before = await readState(request);
      await assert.rejects(issueStock(pool, request), { code });
      assert.deepEqual(await readState(request), before);
    }
  });

  it('replays a completed issue after archival while requiring an active actor', async () => {
    const request = await createFixture();
    const original = await issueStock(pool, request);
    await pool.query('UPDATE products SET archived_at = CURRENT_TIMESTAMP WHERE id = $1', [request.productId]);
    await pool.query('UPDATE locations SET archived_at = CURRENT_TIMESTAMP WHERE id = $1', [request.locationId]);
    assert.deepEqual(await issueStock(pool, request), original);
    await pool.query('UPDATE users SET disabled_at = CURRENT_TIMESTAMP WHERE id = $1', [request.actorId]);
    await assert.rejects(issueStock(pool, request), { code: 'ACTOR_DISABLED' });
    assert.equal((await readState(request)).inventory.quantity, 6);
  });

  it('allows only one of two actors to issue four units from a balance of five', async () => {
    const request = await createFixture(5);
    const anotherActor = await createStockFixture(pool, 'manager');
    const secondRequest = { ...request, actorId: anotherActor.actorId, clientRequestKey: randomUUID() };
    const outcomes = await issueConcurrently([request, secondRequest]);
    const succeeded = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const failed = outcomes.filter((outcome) => outcome.status === 'rejected');
    assert.equal(succeeded.length, 1);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].reason.code, 'INSUFFICIENT_STOCK');
    assert.deepEqual(failed[0].reason.details, { available: 1 });
    assert.equal(succeeded[0].value.quantityAfter, 1);
    const firstState = await readState(request);
    const secondState = await readState(secondRequest);
    assert.equal(firstState.inventory.quantity, 1);
    assert.equal(firstState.operations.length + secondState.operations.length, 1);
    assert.equal(firstState.movements.length, 1);
    assert.equal(firstState.movements[0].quantity_delta, -4);
    assert.equal(firstState.movements[0].quantity_after, 1);
  });

  it('applies both concurrent issues when stock covers both quantities', async () => {
    const request = await createFixture();
    const outcomes = await issueConcurrently([
      request, { ...request, quantity: 3, clientRequestKey: randomUUID() },
    ]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ['fulfilled', 'fulfilled']);
    const state = await readState(request);
    assert.equal(state.inventory.quantity, 3);
    assert.equal(state.operations.length, 2);
    assert.equal(state.movements.length, 2);
    assert.equal(state.movements.reduce((sum, movement) => sum + movement.quantity_delta, 0), -7);
    assert.equal(state.movements.at(-1).quantity_after, 3);
  });

  it('deduplicates concurrent issues sharing a key even when stock covers only one', async () => {
    const request = await createFixture(5);
    const outcomes = await issueConcurrently([request, request]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ['fulfilled', 'fulfilled']);
    assert.deepEqual(outcomes[0].value, outcomes[1].value);
    const state = await readState(request);
    assert.equal(state.inventory.quantity, 1);
    assert.equal(state.operations.length, 1);
    assert.equal(state.movements.length, 1);
  });

  it('rejects one concurrent issue when the same key carries different quantities', async () => {
    const request = await createFixture();
    const outcomes = await issueConcurrently([request, { ...request, quantity: 3 }]);
    const succeeded = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const failed = outcomes.filter((outcome) => outcome.status === 'rejected');
    assert.equal(succeeded.length, 1);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].reason.code, 'REQUEST_KEY_CONFLICT');
    const state = await readState(request);
    assert.equal(state.inventory.quantity, 10 - succeeded[0].value.quantityIssued);
    assert.equal(state.operations.length, 1);
    assert.equal(state.movements.length, 1);
  });

  it('preserves both changes when a receipt and an issue run concurrently', async () => {
    const request = await createFixture(5);
    const outcomes = await runConcurrently(pool, testDatabase.databaseName, [
      () => issueStock(pool, request),
      () => receiveStock(pool, { ...request, quantity: 3, clientRequestKey: randomUUID() }),
    ]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ['fulfilled', 'fulfilled']);
    const state = await readState(request);
    assert.equal(state.inventory.quantity, 4);
    assert.equal(state.operations.length, 2);
    assert.equal(state.movements.length, 2);
    assert.deepEqual(state.movements.map((movement) => movement.quantity_delta).sort((a, b) => a - b), [-4, 3]);
    assert.equal(state.movements.at(-1).quantity_after, 4);
  });

  it('rolls back a failure after decrementing stock and permits retrying the same key', async () => {
    const request = await createFixture();
    const before = await readState(request);
    await pool.query(`
      CREATE FUNCTION fail_test_issue_movement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.quantity_delta = -4 AND NEW.quantity_after = 6
            AND (SELECT quantity FROM inventory
                 WHERE product_id = NEW.product_id AND location_id = NEW.location_id) = 6 THEN
          RAISE EXCEPTION 'Forced failure after inventory decrement';
        END IF;
        RAISE EXCEPTION 'Expected inventory decrement before movement';
      END;
      $$;
      CREATE TRIGGER fail_test_issue BEFORE INSERT ON stock_movements
      FOR EACH ROW WHEN (NEW.product_id = ${request.productId})
      EXECUTE FUNCTION fail_test_issue_movement();
    `);
    try {
      await assert.rejects(issueStock(pool, request), {
        code: 'P0001', message: 'Forced failure after inventory decrement',
      });
      assert.deepEqual(await readState(request), before);
    } finally {
      await pool.query('DROP TRIGGER fail_test_issue ON stock_movements');
      await pool.query('DROP FUNCTION fail_test_issue_movement()');
    }
    const retried = await issueStock(pool, request);
    const state = await readState(request);
    assert.equal(retried.quantityAfter, 6);
    assert.equal(state.inventory.quantity, 6);
    assert.equal(state.operations.length, 1);
    assert.equal(state.movements.length, 1);
  });
});
