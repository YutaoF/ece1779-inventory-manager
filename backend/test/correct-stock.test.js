import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { correctStock } from '../src/stock/correct-stock.js';
import { receiveStock } from '../src/stock/receive-stock.js';
import {
  createTestDatabase, createStockFixture, readStockState, runConcurrently,
} from './helpers/stock-database.js';

let database;
let pool;

before(async () => {
  database = await createTestDatabase();
  pool = database.pool;
});

after(async () => {
  await database?.close();
});

async function correctionRequest(role = 'manager') {
  const { actorId, productId, locationId, clientRequestKey } = await createStockFixture(pool, role);
  return { actorId, productId, locationId, clientRequestKey, quantityDelta: 5, reason: 'Shelf recount' };
}

describe('correctStock with PostgreSQL', { concurrency: false, timeout: 20_000 }, () => {
  it('records a manager’s signed corrections and preserves both history entries at zero stock', async () => {
    const request = await correctionRequest();
    const increase = await correctStock(pool, request);
    const decrease = await correctStock(pool, {
      ...request, clientRequestKey: randomUUID(), quantityDelta: -5, reason: 'Damaged units',
    });
    const { inventory, operations, movements } = await readStockState(pool, request);
    assert.equal(inventory.quantity, 0);
    assert.equal(operations.length, 2);
    assert.equal(movements.length, 2);
    assert.deepEqual(operations.map((row) => row.reason), ['Shelf recount', 'Damaged units']);
    for (const [index, result, delta, balance] of [[0, increase, 5, 5], [1, decrease, -5, 0]]) {
      const operation = operations[index];
      const movement = movements[index];
      assert.equal(operation.actor_id, request.actorId);
      assert.equal(operation.operation, 'correction');
      assert.equal(movement.operation_id, operation.id);
      assert.equal(movement.quantity_delta, delta);
      assert.equal(movement.quantity_after, balance);
      assert.deepEqual(result, {
        operationId: operation.id, movementId: movement.id,
        productId: request.productId, locationId: request.locationId, quantityDelta: delta, quantityAfter: balance,
      });
      assert.deepEqual(operation.saved_result, result);
    }
  });

  it('rejects a staff correction even when the request claims a manager role', async () => {
    const request = await correctionRequest('staff');
    const before = await readStockState(pool, request);
    await assert.rejects(correctStock(pool, { ...request, role: 'manager' }), { code: 'FORBIDDEN' });
    assert.deepEqual(await readStockState(pool, request), before);
  });

  it('checks current permissions before replaying a correction after demotion or deactivation', async () => {
    const request = await correctionRequest();
    await correctStock(pool, request);
    const before = await readStockState(pool, request);
    await pool.query("UPDATE users SET role = 'staff' WHERE id = $1", [request.actorId]);
    await assert.rejects(correctStock(pool, request), { code: 'FORBIDDEN' });
    await pool.query("UPDATE users SET role = 'manager', disabled_at = NOW() WHERE id = $1", [request.actorId]);
    await assert.rejects(correctStock(pool, request), { code: 'ACTOR_DISABLED' });
    assert.deepEqual(await readStockState(pool, request), before);
  });

  it('requires a reason containing a non-whitespace character', async () => {
    const request = await correctionRequest();
    const before = await readStockState(pool, request);
    for (const reason of [undefined, null, '', ' \t\n ', 42]) {
      await assert.rejects(correctStock(pool, { ...request, reason }), { code: 'INVALID_INPUT' });
    }
    assert.deepEqual(await readStockState(pool, request), before);
  });

  it('rejects zero, noninteger, and out-of-range adjustments', async () => {
    const request = await correctionRequest();
    const before = await readStockState(pool, request);
    for (const quantityDelta of [undefined, 0, -0.5, '2', 2_147_483_648, -2_147_483_649]) {
      await assert.rejects(correctStock(pool, { ...request, quantityDelta }), { code: 'INVALID_INPUT' });
    }
    assert.deepEqual(await readStockState(pool, request), before);
  });

  it('rolls back negative balances for untracked and stocked locations, freeing the failed key', async () => {
    const request = await correctionRequest();
    const decrease = { ...request, quantityDelta: -6 };
    const empty = await readStockState(pool, request);
    await assert.rejects(correctStock(pool, decrease), { code: 'INSUFFICIENT_STOCK' });
    assert.deepEqual(await readStockState(pool, request), empty);

    await correctStock(pool, { ...request, clientRequestKey: randomUUID() });
    const stocked = await readStockState(pool, request);
    await assert.rejects(correctStock(pool, decrease), { code: 'INSUFFICIENT_STOCK' });
    assert.deepEqual(await readStockState(pool, request), stocked);

    await correctStock(pool, { ...request, clientRequestKey: randomUUID(), quantityDelta: 1 });
    assert.equal((await correctStock(pool, decrease)).quantityAfter, 0);
  });

  it('rejects a correction that would overflow the inventory quantity', async () => {
    const request = await correctionRequest();
    await correctStock(pool, { ...request, quantityDelta: 2_147_483_647 });
    const before = await readStockState(pool, request);
    await assert.rejects(correctStock(pool, { ...request, clientRequestKey: randomUUID() }), { code: 'QUANTITY_OVERFLOW' });
    await assert.rejects(
      correctStock(pool, { ...request, clientRequestKey: randomUUID(), quantityDelta: -2_147_483_648 }),
      { code: 'INSUFFICIENT_STOCK' },
    );
    assert.deepEqual(await readStockState(pool, request), before);
  });

  it('replays the saved correction and rejects key reuse with a changed reason, delta, or operation', async () => {
    const request = await correctionRequest();
    const original = await correctStock(pool, request);
    await correctStock(pool, { ...request, quantityDelta: -2, clientRequestKey: randomUUID() });
    const before = await readStockState(pool, request);
    assert.deepEqual(await correctStock(pool, request), original);
    for (const change of [{ quantityDelta: -5 }, { reason: 'Another recount' }]) {
      await assert.rejects(correctStock(pool, { ...request, ...change }), { code: 'REQUEST_KEY_CONFLICT' });
    }
    await assert.rejects(receiveStock(pool, { ...request, quantity: 5 }), { code: 'REQUEST_KEY_CONFLICT' });
    assert.deepEqual(await readStockState(pool, request), before);
  });

  it('allows only one of two concurrent downward corrections when stock covers one', async () => {
    const request = await correctionRequest();
    await correctStock(pool, request);
    const tasks = [randomUUID(), randomUUID()].map((clientRequestKey) => () =>
      correctStock(pool, { ...request, clientRequestKey, quantityDelta: -4 }));
    const results = await runConcurrently(pool, database.databaseName, tasks);
    const successes = results.filter((result) => result.status === 'fulfilled');
    const failures = results.filter((result) => result.status === 'rejected');
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].reason.code, 'INSUFFICIENT_STOCK');
    const { inventory, operations, movements } = await readStockState(pool, request);
    assert.equal(inventory.quantity, 1);
    assert.equal(operations.length, 2);
    assert.deepEqual(movements.map((row) => row.quantity_delta), [5, -4]);
    assert.deepEqual(movements.map((row) => row.quantity_after), [5, 1]);
  });
});
