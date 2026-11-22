import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { io } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { silentLogger } from '../src/logger.js';
import { attachRealtime } from '../src/realtime.js';
import { createStockFixture, createTestDatabase } from '../test/helpers/stock-database.js';

const redisUrl = process.env.TEST_REDIS_URL;
const changed = 'inventory:changed';

function nextEvent(socket, event) {
  return once(socket, event, { signal: AbortSignal.timeout(5000) });
}

async function request(base, path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(cookie && { cookie }), ...(body && { 'content-type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  const data = response.status === 204 ? undefined : await response.json();
  return { response, data };
}

describe('Socket.IO across two app replicas', { skip: !redisUrl && 'Set TEST_REDIS_URL to a dedicated Redis instance' }, () => {
  let db;
  let first;
  let second;
  let writer;
  let reader;
  const sessionSecret = randomUUID();
  const password = 'test-only socket password';
  let passwordHash;

  async function startReplica() {
    const app = createApp({ pool: db.pool, logger: silentLogger, sessionSecret });
    const server = createServer(app);
    const realtime = await attachRealtime(server, app, { redisUrl });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return {
      app,
      url: `http://127.0.0.1:${server.address().port}`,
      async close() {
        server.closeIdleConnections();
        await realtime.close();
        await app.locals.sessionStore.close();
      },
    };
  }

  async function signIn(role) {
    const email = randomUUID() + '@example.invalid';
    const { rows: [user] } = await db.pool.query(
      "INSERT INTO users (name, email, role, password_hash) VALUES ('Socket test', $1, $2, $3) RETURNING id",
      [email, role, passwordHash],
    );
    const { response } = await request(first.url, '/api/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().find((header) => header.startsWith(SESSION_COOKIE + '='));
    assert.ok(cookie);
    return { id: user.id, cookie: cookie.split(';')[0] };
  }

  function makeSocket(t, replica, cookie, origin = replica.url) {
    const socket = io(replica.url, {
      path: '/api/socket.io/', transports: ['websocket'], autoConnect: false, reconnection: false,
      extraHeaders: { origin, ...(cookie && { cookie }) },
    });
    t.after(() => socket.disconnect());
    return socket;
  }

  async function connect(socket, expected = 'connect') {
    const result = nextEvent(socket, expected);
    socket.connect();
    return result;
  }

  async function write(path, body, method = 'POST') {
    return request(first.url, path, { method, cookie: writer.cookie, body });
  }

  before(async () => {
    db = await createTestDatabase();
    first = await startReplica();
    second = await startReplica();
    passwordHash = await hashPassword(password);
    writer = await signIn('manager');
    reader = await signIn('staff');
  });

  after(async () => {
    await Promise.all([first?.close(), second?.close()]);
    await db?.close();
  });

  it('requires an active session and disconnects a socket when the same session logs out on another replica', async (t) => {
    const unauthorized = makeSocket(t, second);
    assert.equal((await connect(unauthorized, 'connect_error'))[0].message, 'unauthenticated');
    const disabled = await signIn('staff');
    const openSocket = makeSocket(t, second, disabled.cookie);
    await connect(openSocket);
    await db.pool.query('UPDATE users SET disabled_at = now() WHERE id = $1', [disabled.id]);
    await Promise.all([nextEvent(openSocket, 'disconnect'), first.app.locals.notifyInventoryChanged()]);
    assert.equal((await connect(makeSocket(t, second, disabled.cookie), 'connect_error'))[0].message, 'unauthenticated');

    const session = await signIn('staff');
    const otherOrigin = makeSocket(t, second, session.cookie, 'https://another-app.example.invalid');
    await connect(otherOrigin, 'connect_error');
    assert.equal(otherOrigin.connected, false);
    const socket = makeSocket(t, second, session.cookie);
    await connect(socket);
    const [logout] = await Promise.all([
      request(first.url, '/api/auth/logout', { cookie: session.cookie, method: 'POST' }),
      nextEvent(socket, 'disconnect'),
    ]);
    assert.equal(logout.response.status, 204);
    assert.equal((await connect(socket, 'connect_error'))[0].message, 'unauthenticated');
  });

  it('notifies both replicas once for each committed change and leaves retries and rollbacks silent', async (t) => {
    const local = makeSocket(t, first, writer.cookie);
    const remote = makeSocket(t, second, reader.cookie);
    await Promise.all([connect(local), connect(remote)]);
    // Count actual publication calls too: a rollback or retry must be silent even on a slow network.
    const publish = t.mock.method(first.app.locals, 'notifyInventoryChanged');
    async function expectChange(action) {
      const count = publish.mock.callCount();
      const [localEvent, remoteEvent, { response, data }] = await Promise.all([
        nextEvent(local, changed), nextEvent(remote, changed), action(),
      ]);
      assert.equal(response.status, 200);
      assert.deepEqual(localEvent, []);
      assert.deepEqual(remoteEvent, []);
      assert.equal(publish.mock.callCount(), count + 1);
      return data;
    }
    const { productId, locationId, clientRequestKey } = await createStockFixture(db.pool);
    const receipt = { productId, locationId, quantity: 8, clientRequestKey };
    const result = await expectChange(() => write('/api/stock-operations/receive', receipt));
    const replay = await write('/api/stock-operations/receive', receipt);
    assert.deepEqual(replay.data, result);
    assert.equal(publish.mock.callCount(), 1);

    const { rows: [pantry] } = await db.pool.query("INSERT INTO locations (name) VALUES ('Socket pantry') RETURNING id");
    const transfer = { productId, sourceLocationId: locationId, destinationLocationId: pantry.id, quantity: 3 };
    const failed = await write('/api/stock-operations/transfer', { ...transfer, quantity: 20 });
    assert.equal(failed.response.status, 409);
    assert.equal(publish.mock.callCount(), 1);
    await expectChange(() => write('/api/stock-operations/transfer', transfer));
    const thresholdPath = `/api/inventory/${productId}/${locationId}/threshold`;
    await expectChange(() => write(thresholdPath, { reorderThreshold: 5 }, 'PATCH'));
    const sameThreshold = await write(thresholdPath, { reorderThreshold: 5 }, 'PATCH');
    assert.equal(sameThreshold.response.status, 200);
    assert.equal(publish.mock.callCount(), 3);
    const { data: { inventory } } = await request(second.url, `/api/inventory?productId=${productId}&stockStatus=low`, { cookie: reader.cookie });
    assert.deepEqual(inventory.map(({ locationId, quantity }) => [locationId, quantity]), [[locationId, 5]]);
    await expectChange(() => write('/api/stock-operations/issue', { productId, locationId, quantity: 1 }));
    await expectChange(() => write('/api/stock-operations/correction', { productId, locationId, quantityDelta: 1, reason: 'Recount' }));
  });

  it('does not publish a transfer rejected at commit, and preserves a committed response if notification fails', async (t) => {
    const { productId, locationId, clientRequestKey } = await createStockFixture(db.pool);
    const receipt = { productId, locationId, quantity: 8, clientRequestKey };
    const { rows: [destination] } = await db.pool.query("INSERT INTO locations (name) VALUES ('Commit test') RETURNING id");
    const publish = t.mock.method(first.app.locals, 'notifyInventoryChanged', () => { throw new Error('test publisher offline'); });
    const { response, data } = await write('/api/stock-operations/receive', receipt);
    assert.equal(response.status, 200);
    assert.equal(publish.mock.callCount(), 1);
    assert.deepEqual((await write('/api/stock-operations/receive', receipt)).data, data);

    // The constraint fires only after the transfer has written both movements.
    await db.pool.query(`
      CREATE FUNCTION fail_socket_test_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test commit failure'; END;
      $$;
      CREATE CONSTRAINT TRIGGER fail_socket_test_commit AFTER INSERT ON stock_movements
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_socket_test_commit()
    `);
    try {
      const failed = await write('/api/stock-operations/transfer', {
        productId, sourceLocationId: locationId, destinationLocationId: destination.id, quantity: 1,
      });
      assert.equal(failed.response.status, 500);
      assert.equal(publish.mock.callCount(), 1);
    } finally {
      await db.pool.query('DROP TRIGGER fail_socket_test_commit ON stock_movements; DROP FUNCTION fail_socket_test_commit()');
    }
  });

  it('reads the current inventory and history after reconnecting to a different replica following a missed change', async (t) => {
    const before = makeSocket(t, first, reader.cookie);
    await connect(before);
    before.disconnect();
    const { productId, locationId } = await createStockFixture(db.pool);
    const { response } = await write('/api/stock-operations/receive', { productId, locationId, quantity: 6 });
    assert.equal(response.status, 200);

    const after = makeSocket(t, second, reader.cookie);
    await connect(after);
    const snapshots = await Promise.all(['/api/inventory', '/api/movements'].map((path) =>
      request(second.url, path + '?productId=' + productId, { cookie: reader.cookie })));
    assert.deepEqual(snapshots.map(({ response }) => response.status), [200, 200]);
    assert.deepEqual(snapshots[0].data.inventory.map((row) => row.quantity), [6]);
    assert.deepEqual(snapshots[1].data.movements.map((row) => row.quantityDelta), [6]);
  });
});
