import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REQUIRED_SCHEMA_VERSION } from '../src/db.js';
import { fakePool, startApp } from './helpers.js';

async function get(options, path) {
  const server = await startApp(options);
  try {
    const res = await fetch(`${server.url}${path}`);
    return { status: res.status, body: await res.json(), headers: res.headers };
  } finally {
    await server.close();
  }
}

const migrated = fakePool(() => ({ rows: [{ version: REQUIRED_SCHEMA_VERSION }] }));

describe('GET /healthz', () => {
  it('is ok without touching the database', async () => {
    const pool = fakePool(() => {
      throw new Error('should not query');
    });
    const { status, body, headers } = await get({ pool }, '/healthz');
    assert.equal(status, 200);
    assert.deepEqual(body, { status: 'ok' });
    assert.equal(headers.get('cache-control'), 'no-store');
  });
});

describe('GET /readyz', () => {
  it('is ready when the schema is at the required version', async () => {
    const { status, body } = await get({ pool: migrated }, '/readyz');
    assert.equal(status, 200);
    assert.deepEqual(body, { status: 'ready', schemaVersion: REQUIRED_SCHEMA_VERSION });
  });

  it('is not ready when the schema is behind', async () => {
    const pool = fakePool(() => ({ rows: [{ version: REQUIRED_SCHEMA_VERSION - 1 }] }));
    const { status, body } = await get({ pool }, '/readyz');
    assert.equal(status, 503);
    assert.equal(body.reason, 'schema_outdated');
    assert.equal(body.requiredSchemaVersion, REQUIRED_SCHEMA_VERSION);
  });

  it('is not ready when migrations have never run', async () => {
    const pool = fakePool(() => {
      throw Object.assign(new Error('relation "schema_migrations" does not exist'), { code: '42P01' });
    });
    const { status, body } = await get({ pool }, '/readyz');
    assert.equal(status, 503);
    assert.equal(body.reason, 'schema_missing');
  });

  it('is not ready when the database is unreachable, without leaking the error', async () => {
    const pool = fakePool(() => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' });
    });
    const { status, body } = await get({ pool }, '/readyz');
    assert.equal(status, 503);
    assert.deepEqual(body, { status: 'not_ready', reason: 'database_unreachable' });
  });

  it('is not ready when the database hangs past the timeout', async () => {
    const pool = fakePool(() => new Promise(() => {}));
    const { status, body } = await get({ pool, readinessTimeoutMs: 50 }, '/readyz');
    assert.equal(status, 503);
    assert.equal(body.reason, 'database_unreachable');
  });

  it('is not ready while shutting down', async () => {
    const server = await startApp({ pool: migrated });
    try {
      server.app.locals.shuttingDown = true;
      const res = await fetch(`${server.url}/readyz`);
      assert.equal(res.status, 503);
      assert.equal((await res.json()).reason, 'shutting_down');
    } finally {
      await server.close();
    }
  });
});
