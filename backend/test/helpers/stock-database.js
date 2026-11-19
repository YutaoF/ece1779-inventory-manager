import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createDatabasePool } from '../../src/db.js';

export async function createTestDatabase() {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString, 'Set TEST_DATABASE_URL to a PostgreSQL connection whose role can create databases.');

  const databaseName = `inventory_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000 });
  let pool;
  let databaseCreated = false;

  async function close() {
    try {
      await pool?.end();
    } finally {
      try {
        if (databaseCreated) {
          await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        }
      } finally {
        await admin.end();
      }
    }
  }

  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;

    const testUrl = new URL(connectionString);
    testUrl.pathname = `/${databaseName}`;
    pool = createDatabasePool({
      connectionString: testUrl.toString(),
      application_name: databaseName,
      max: 8,
      statement_timeout: 10_000,
    });

    const migrationDirectory = new URL('../../../db/migrations/', import.meta.url);
    const migrations = (await readdir(migrationDirectory))
      .filter((name) => /^\d{3}_.*\.sql$/.test(name))
      .sort();
    const client = await pool.connect();
    try {
      const target = await client.query('SELECT current_database() AS name');
      assert.equal(target.rows[0].name, databaseName, 'Tests must use the generated database.');
      await client.query('BEGIN');
      for (const migration of migrations) {
        await client.query(await readFile(new URL(migration, migrationDirectory), 'utf8'));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return { pool, databaseName, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function createStockFixture(pool, role = 'staff') {
  const suffix = randomUUID().replaceAll('-', '');
  const actor = await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ('Test user', $1, 'test-only-hash', $2) RETURNING id`,
    [`${suffix}@example.invalid`, role],
  );
  const category = await pool.query('INSERT INTO categories (name) VALUES ($1) RETURNING id', [suffix]);
  const product = await pool.query(
    `INSERT INTO products (sku, name, category_id)
     VALUES ($1, 'Rice', $2) RETURNING id`,
    [suffix, category.rows[0].id],
  );
  const location = await pool.query("INSERT INTO locations (name) VALUES ('Test storeroom') RETURNING id");
  return {
    actorId: actor.rows[0].id,
    productId: product.rows[0].id,
    locationId: location.rows[0].id,
    quantity: 10,
    clientRequestKey: randomUUID(),
  };
}

export async function readStockState(pool, request) {
  const [inventory, operations, movements] = await Promise.all([
    pool.query('SELECT * FROM inventory WHERE product_id = $1 AND location_id = $2',
      [request.productId, request.locationId]),
    pool.query('SELECT * FROM stock_operations WHERE actor_id = $1 ORDER BY id', [request.actorId]),
    pool.query('SELECT * FROM stock_movements WHERE product_id = $1 ORDER BY id', [request.productId]),
  ]);
  return {
    inventory: inventory.rows[0],
    operations: operations.rows,
    movements: movements.rows,
  };
}

// Hold service connections at actual database locks before releasing them.
export async function runConcurrently(pool, databaseName, tasks) {
  const blocker = await pool.connect();
  let outcomes;
  let waitError;
  try {
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE inventory IN SHARE MODE');
    outcomes = Promise.allSettled(tasks.map((task) => task()));

    const deadline = Date.now() + 5_000;
    let waiting = 0;
    while (waiting < tasks.length) {
      const result = await pool.query(
        `SELECT count(*)::integer AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND application_name = $1
           AND state = 'active' AND wait_event_type = 'Lock'`,
        [databaseName],
      );
      waiting = result.rows[0].waiting;
      assert.ok(Date.now() < deadline, 'Expected concurrent stock requests to overlap at database locks.');
      if (waiting < tasks.length) await delay(10);
    }
  } catch (error) {
    waitError = error;
  } finally {
    try {
      await blocker.query('ROLLBACK');
    } finally {
      blocker.release();
    }
  }
  const results = await outcomes;
  if (waitError) throw waitError;
  return results;
}
