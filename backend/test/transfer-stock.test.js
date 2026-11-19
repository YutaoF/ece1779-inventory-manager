import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { issueStock } from '../src/stock/issue-stock.js';
import { transferStock } from '../src/stock/transfer-stock.js';
import { createStockFixture, createTestDatabase, readStockState, runConcurrently } from './helpers/stock-database.js';

let database;
let pool;

before(async () => {
  database = await createTestDatabase();
  pool = database.pool;
});

after(async () => {
  await database?.close();
});

async function createTransfer(sourceQuantity = 10, destinationQuantity = null, role = 'staff') {
  const { actorId, productId, locationId: sourceLocationId, clientRequestKey } = await createStockFixture(pool, role);
  const destination = await pool.query("INSERT INTO locations (name) VALUES ('Destination') RETURNING id");
  const destinationLocationId = destination.rows[0].id;
  for (const [locationId, quantity] of [[sourceLocationId, sourceQuantity], [destinationLocationId, destinationQuantity]]) {
    if (quantity !== null) {
      await pool.query(
        'INSERT INTO inventory (product_id, location_id, quantity, reorder_threshold) VALUES ($1, $2, $3, 2)',
        [productId, locationId, quantity],
      );
    }
  }
  return { actorId, productId, sourceLocationId, destinationLocationId, quantity: 3, clientRequestKey };
}

async function readTransferState(request) {
  const [source, destination] = await Promise.all([
    readStockState(pool, { ...request, locationId: request.sourceLocationId }),
    pool.query('SELECT * FROM inventory WHERE product_id = $1 AND location_id = $2',
      [request.productId, request.destinationLocationId]),
  ]);
  return {
    source: source.inventory, destination: destination.rows[0],
    operations: source.operations, movements: source.movements,
  };
}

function transferConcurrently(...requests) {
  return runConcurrently(pool, database.databaseName, requests.map((request) => () => transferStock(pool, request)));
}

describe('transferStock with PostgreSQL', { concurrency: false, timeout: 20_000 }, () => {
  it('moves stock for staff and records both signed movements under one operation', async () => {
    const request = await createTransfer(10, 2);
    request.reason = 'Refill the pantry';
    const result = await transferStock(pool, request);
    const { source, destination, operations, movements } = await readTransferState(request);
    assert.equal(source.quantity, 7);
    assert.equal(destination.quantity, 5);
    assert.equal(source.reorder_threshold, 2);
    assert.equal(destination.reorder_threshold, 2);
    assert.equal(operations.length, 1);
    assert.equal(operations[0].actor_id, request.actorId);
    assert.equal(operations[0].operation, 'transfer');
    assert.equal(operations[0].reason, request.reason);
    assert.equal(movements.length, 2);
    const debit = movements.find((row) => row.location_id === request.sourceLocationId);
    const credit = movements.find((row) => row.location_id === request.destinationLocationId);
    assert.deepEqual([debit.operation_id, debit.quantity_delta, debit.quantity_after], [operations[0].id, -3, 7]);
    assert.deepEqual([credit.operation_id, credit.quantity_delta, credit.quantity_after], [operations[0].id, 3, 5]);
    assert.deepEqual(result, {
      operationId: operations[0].id, sourceMovementId: debit.id, destinationMovementId: credit.id,
      productId: request.productId, sourceLocationId: request.sourceLocationId,
      destinationLocationId: request.destinationLocationId, quantityTransferred: 3,
      sourceQuantityAfter: 7, destinationQuantityAfter: 5,
    });
    assert.deepEqual(operations[0].saved_result, result);
  });

  it('allows a manager to transfer the last units to a previously untracked destination', async () => {
    const request = await createTransfer(3, null, 'manager');
    await transferStock(pool, request);
    const state = await readTransferState(request);
    assert.equal(state.source.quantity, 0);
    assert.equal(state.destination.quantity, 3);
    assert.equal(state.destination.reorder_threshold, null);
  });

  it('rejects identical locations after normalizing IDs and requires a positive whole quantity', async () => {
    const request = await createTransfer();
    const before = await readTransferState(request);
    for (const change of [
      { destinationLocationId: '00' + request.sourceLocationId }, { sourceLocationId: null },
      { destinationLocationId: null }, { quantity: 0 }, { quantity: -3 }, { quantity: 1.5 },
    ]) {
      await assert.rejects(transferStock(pool, { ...request, ...change }), { code: 'INVALID_INPUT' });
    }
    assert.deepEqual(await readTransferState(request), before);
  });

  it('requires both locations to exist and be active', async () => {
    for (const field of ['sourceLocationId', 'destinationLocationId']) {
      const request = await createTransfer();
      const before = await readTransferState(request);
      await assert.rejects(transferStock(pool, { ...request, [field]: '9223372036854775807' }), { code: 'LOCATION_NOT_FOUND' });
      await pool.query('UPDATE locations SET archived_at = now() WHERE id = $1', [request[field]]);
      await assert.rejects(transferStock(pool, request), { code: 'LOCATION_ARCHIVED' });
      assert.deepEqual(await readTransferState(request), before);
    }
  });

  it('leaves both inventories and history untouched for insufficient, untracked, or overflowing stock', async () => {
    for (const [initialSource, initialDestination, code] of [
      [null, null, 'INSUFFICIENT_STOCK'], [2, null, 'INSUFFICIENT_STOCK'], [10, 2_147_483_645, 'QUANTITY_OVERFLOW'],
    ]) {
      const request = await createTransfer(initialSource, initialDestination);
      const before = await readTransferState(request);
      await assert.rejects(transferStock(pool, request), { code });
      assert.deepEqual(await readTransferState(request), before);
    }
  });

  it('replays a saved result and detects a reused key with a different direction, destination, quantity, or action', async () => {
    const request = await createTransfer();
    const original = await transferStock(pool, request);
    await transferStock(pool, { ...request, clientRequestKey: randomUUID() });
    const before = await readTransferState(request);
    assert.deepEqual(await transferStock(pool, { ...request, sourceLocationId: '00' + request.sourceLocationId }), original);
    for (const change of [
      { sourceLocationId: request.destinationLocationId, destinationLocationId: request.sourceLocationId },
      { destinationLocationId: '9223372036854775807' }, { quantity: 2 },
    ]) {
      await assert.rejects(transferStock(pool, { ...request, ...change }), { code: 'REQUEST_KEY_CONFLICT' });
    }
    await assert.rejects(issueStock(pool, { ...request, locationId: request.sourceLocationId }), { code: 'REQUEST_KEY_CONFLICT' });
    assert.deepEqual(await readTransferState(request), before);
  });

  it('rolls back both balances, both movements and the retry key when the database rejects the commit', async () => {
    const request = await createTransfer();
    const before = await readTransferState(request);
    // The deferred trigger raises at COMMIT, after the transaction has written the destination credit.
    await pool.query(`
      CREATE FUNCTION reject_test_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Forced transfer commit failure';
      END;
      $$;
      CREATE CONSTRAINT TRIGGER reject_transfer_credit AFTER INSERT ON stock_movements
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.quantity_delta > 0)
      EXECUTE FUNCTION reject_test_transfer();
    `);
    try {
      await assert.rejects(transferStock(pool, request), { code: 'P0001', message: 'Forced transfer commit failure' });
      assert.deepEqual(await readTransferState(request), before);
    } finally {
      await pool.query('DROP TRIGGER reject_transfer_credit ON stock_movements');
      await pool.query('DROP FUNCTION reject_test_transfer()');
    }
    const result = await transferStock(pool, request);
    assert.equal(result.sourceQuantityAfter, 7);
    assert.equal(result.destinationQuantityAfter, 3);
  });

  it('completes simultaneous transfers in opposite directions and preserves total stock', async () => {
    const request = await createTransfer(10, 5);
    const reverse = {
      ...request, sourceLocationId: request.destinationLocationId, destinationLocationId: request.sourceLocationId,
      quantity: 4, clientRequestKey: randomUUID(),
    };
    const outcomes = await transferConcurrently(request, reverse);
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ['fulfilled', 'fulfilled']);
    const state = await readTransferState(request);
    assert.equal(state.source.quantity, 11);
    assert.equal(state.destination.quantity, 4);
    assert.equal(state.operations.length, 2);
    assert.equal(state.movements.length, 4);
  });

  it('prevents simultaneous transfers from spending the same source stock twice', async () => {
    const request = await createTransfer(5);
    const secondDestination = await pool.query("INSERT INTO locations (name) VALUES ('Another destination') RETURNING id");
    const other = { ...request, destinationLocationId: secondDestination.rows[0].id, clientRequestKey: randomUUID() };
    const outcomes = await transferConcurrently(request, other);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find((outcome) => outcome.status === 'rejected').reason.code, 'INSUFFICIENT_STOCK');
    const winner = outcomes[0].status === 'fulfilled' ? request : other;
    const loser = outcomes[0].status === 'fulfilled' ? other : request;
    const winnerState = await readTransferState(winner);
    assert.equal(winnerState.source.quantity, 2);
    assert.equal(winnerState.destination.quantity, 3);
    assert.equal(winnerState.operations.length, 1);
    assert.equal(winnerState.movements.length, 2);
    assert.equal((await readTransferState(loser)).destination, undefined);
  });

  it('preserves an issue and a transfer updating the same destination balance concurrently', async () => {
    const request = await createTransfer(10, 2);
    const issue = { ...request, locationId: request.destinationLocationId, quantity: 1, clientRequestKey: randomUUID() };
    const outcomes = await runConcurrently(pool, database.databaseName, [
      () => issueStock(pool, issue), () => transferStock(pool, request),
    ]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ['fulfilled', 'fulfilled']);
    const state = await readTransferState(request);
    assert.equal(state.source.quantity, 7);
    assert.equal(state.destination.quantity, 4);
    assert.equal(state.operations.length, 2);
    assert.equal(state.movements.length, 3);
  });

  it('applies concurrent retries only once even when only one transfer is affordable', async () => {
    const request = await createTransfer(3);
    const outcomes = await transferConcurrently(request, request);
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ['fulfilled', 'fulfilled']);
    assert.deepEqual(outcomes[0].value, outcomes[1].value);
    const state = await readTransferState(request);
    assert.equal(state.source.quantity, 0);
    assert.equal(state.destination.quantity, 3);
    assert.equal(state.operations.length, 1);
    assert.equal(state.movements.length, 2);
  });
});
