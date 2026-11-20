import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { hashPassword } from '../src/auth/password.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { fakePool, startApp } from './helpers.js';
import { createStockFixture, createTestDatabase } from './helpers/stock-database.js';

const SECRET = 'test-session-secret-at-least-32-bytes-long';
const PASSWORD = 'correct horse battery';

/** Pulls `inventory.sid=...` out of a response, for sending back as a Cookie header. */
function sessionCookie(res) {
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return header?.split(';')[0];
}

function post(url, path, body, cookie) {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie && { cookie }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function getMe(url, cookie) {
  return fetch(`${url}/api/auth/me`, { headers: cookie ? { cookie } : {} });
}

describe('auth without a session secret', () => {
  it('reports sign-in as unavailable instead of crashing', async () => {
    const server = await startApp({ pool: fakePool(() => ({ rows: [] })) });
    try {
      const res = await post(server.url, '/api/auth/login', { email: 'a@b.c', password: PASSWORD });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error.code, 'sessions_disabled');
    } finally {
      await server.close();
    }
  });
});

describe('auth with PostgreSQL', () => {
  let db;
  let server;

  async function createUser({ role = 'staff', disabled = false, email = `${randomUUID()}@Example.com` } = {}) {
    const result = await db.pool.query(
      `INSERT INTO users (name, email, password_hash, role, disabled_at)
       VALUES ('Test person', $1, $2, $3, $4) RETURNING id::text AS id`,
      [email, await hashPassword(PASSWORD), role, disabled ? new Date() : null],
    );
    return { id: result.rows[0].id, email, role };
  }

  async function login(email, password = PASSWORD) {
    const res = await post(server.url, '/api/auth/login', { email, password });
    return { res, body: await res.json(), cookie: sessionCookie(res) };
  }

  before(async () => {
    db = await createTestDatabase();
    server = await startApp({ pool: db.pool, sessionSecret: SECRET });
  });

  after(async () => {
    await server?.close();
    await db?.close();
  });

  it('logs in, returns the public user and sets an httpOnly cookie scoped to /api', async () => {
    const user = await createUser({ role: 'manager' });
    const { res, body } = await login(user.email);
    assert.equal(res.status, 200);
    assert.deepEqual(body, { user: { id: user.id, name: 'Test person', email: user.email, role: 'manager' } });
    assert.equal(res.headers.get('cache-control'), 'no-store');

    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    assert.match(setCookie, /; Path=\/api/);
    assert.match(setCookie, /; HttpOnly/);
    assert.match(setCookie, /; SameSite=Lax/);
  });

  it('matches email case-insensitively and ignores surrounding spaces', async () => {
    const user = await createUser();
    const { res } = await login(`  ${user.email.toUpperCase()}  `);
    assert.equal(res.status, 200);
  });

  it('gives the same 401 for a wrong password, an unknown email and a disabled account', async () => {
    const active = await createUser();
    const disabled = await createUser({ disabled: true });
    const attempts = [
      await login(active.email, 'wrong password'),
      await login(`nobody-${randomUUID()}@example.com`),
      await login(disabled.email),
    ];
    for (const { res, body, cookie } of attempts) {
      assert.equal(res.status, 401);
      assert.deepEqual(body, { error: { code: 'invalid_credentials', message: 'Email or password is incorrect.' } });
      assert.equal(cookie, undefined);
    }
  });

  it('rejects missing or non-string credentials with 400', async () => {
    for (const body of [{}, { email: 'a@b.c' }, { password: PASSWORD }, { email: 1, password: PASSWORD }, { email: ' ', password: PASSWORD }]) {
      const res = await post(server.url, '/api/auth/login', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((await res.json()).error.code, 'validation_failed');
    }
  });

  it('/me returns the signed-in user, and 401 without a session', async () => {
    const user = await createUser();
    const { cookie } = await login(user.email);

    const me = await getMe(server.url, cookie);
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.id, user.id);

    const anonymous = await getMe(server.url);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error.code, 'unauthenticated');
  });

  it('issues a new session ID on login (no session fixation)', async () => {
    const first = await createUser();
    const second = await createUser();
    const { cookie: before } = await login(first.email);

    const res = await post(server.url, '/api/auth/login', { email: second.email, password: PASSWORD }, before);
    const after = sessionCookie(res);
    assert.ok(after);
    assert.notEqual(after, before);

    const old = await getMe(server.url, before);
    assert.equal(old.status, 401, 'the pre-login session must no longer be valid');
  });

  it('logout deletes the session server-side and clears the cookie', async () => {
    const user = await createUser();
    const { cookie } = await login(user.email);

    const res = await post(server.url, '/api/auth/logout', undefined, cookie);
    assert.equal(res.status, 204);
    assert.match(res.headers.getSetCookie().join('\n'), new RegExp(`${SESSION_COOKIE}=;.*Expires=Thu, 01 Jan 1970`));

    // Replaying the old cookie must not work.
    assert.equal((await getMe(server.url, cookie)).status, 401);
  });

  it('logout without a session is a harmless 204', async () => {
    const res = await post(server.url, '/api/auth/logout');
    assert.equal(res.status, 204);
  });

  it('ends the session when the account is disabled after login', async () => {
    const user = await createUser();
    const { cookie } = await login(user.email);
    await db.pool.query('UPDATE users SET disabled_at = now() WHERE id = $1', [user.id]);

    const me = await getMe(server.url, cookie);
    assert.equal(me.status, 401);
    const rows = await db.pool.query("SELECT count(*)::int AS n FROM sessions WHERE sess->>'userId' = $1", [user.id]);
    assert.equal(rows.rows[0].n, 0);
  });

  it('stores the session in Postgres so another replica accepts the cookie', async () => {
    const user = await createUser();
    const { cookie } = await login(user.email);

    const otherReplica = await startApp({ pool: db.pool, sessionSecret: SECRET });
    try {
      const me = await getMe(otherReplica.url, cookie);
      assert.equal(me.status, 200);
      assert.equal((await me.json()).user.id, user.id);
    } finally {
      await otherReplica.close();
    }
  });

  it('a signed-in user can perform a stock operation as themselves', async () => {
    const fixture = await createStockFixture(db.pool, 'staff');
    const user = await createUser();
    const { cookie } = await login(user.email);

    const receive = { productId: fixture.productId, locationId: fixture.locationId, quantity: 5 };
    const anonymous = await post(server.url, '/api/stock-operations/receive', receive);
    assert.equal(anonymous.status, 401);

    const res = await post(server.url, '/api/stock-operations/receive', receive, cookie);
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const actor = await db.pool.query(
      'SELECT actor_id::text AS actor_id FROM stock_operations ORDER BY id DESC LIMIT 1',
    );
    assert.equal(actor.rows[0].actor_id, user.id);
  });
});
