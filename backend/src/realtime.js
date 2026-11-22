import { hostname } from 'node:os';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { Server } from 'socket.io';
import { findUserById } from './auth/users.js';

const EVENT = 'inventory:changed';
const room = (sessionId) => `session:${sessionId}`;

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // Native clients still have to present a valid session.
  const scheme = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  try {
    return new URL(origin).origin === new URL(`${scheme}://${req.headers.host}`).origin;
  } catch {
    return false;
  }
}

// The adapter issues these Redis commands without awaiting their promises.
// Observe their failures so a lost notification cannot terminate the HTTP server.
function logAdapterErrors(client, commands, logger, observe) {
  for (const name of commands) {
    const command = client[name].bind(client);
    client[name] = (...args) => {
      const result = command(...args);
      observe?.(result);
      return result.catch((err) => logger.warn('Redis adapter command failed', { command: name, err }));
    };
  }
}

export async function attachRealtime(server, app, { redisUrl } = {}) {
  const { pool, logger, sessionMiddleware } = app.locals;
  const replica = `${hostname()}:${process.pid}`;
  const io = new Server({ path: '/api/socket.io/', transports: ['websocket'], serveClient: false,
    allowRequest: (req, done) => done(null, sameOrigin(req)),
  });

  // Verify local recipients against the live session and account on every notification.
  // One lookup covers all local tabs; a disabled user or deleted session stops receiving events.
  async function refreshLocal() {
    const sockets = [...io.of('/').sockets.values()];
    if (!sockets.length) return;
    try {
      const sessionIds = [...new Set(sockets.map((socket) => socket.request.sessionID))];
      const { rows } = await pool.query(`
        SELECT s.sid FROM public.sessions s
        JOIN public.users u ON u.id::text = s.sess->>'userId'
        WHERE s.sid = ANY($1::varchar[]) AND s.expire > now() AND u.disabled_at IS NULL
      `, [sessionIds]);
      const active = new Set(rows.map(({ sid }) => sid));
      for (const socket of sockets) {
        if (!socket.connected) continue;
        if (active.has(socket.request.sessionID)) socket.emit(EVENT);
        else socket.disconnect(true);
      }
    } catch (err) {
      logger.warn('could not verify realtime recipients', { err });
    }
  }

  let publisher;
  let subscriber;
  let running = false;
  async function closeRedis() {
    await Promise.allSettled([publisher, subscriber].filter((client) => client?.isOpen)
      .map((client) => client.isReady ? client.quit() : client.disconnect()));
  }
  function notifyInventoryChanged() {
    if (publisher?.isReady) io.serverSideEmit(EVENT);
    return refreshLocal();
  }
  if (redisUrl) {
    publisher = createClient({ url: redisUrl, disableOfflineQueue: true, socket: {
      // Fail startup if the configured Redis is unavailable. Once live, reconnect automatically.
      reconnectStrategy: (attempt) => running && Math.min((attempt + 1) * 250, 5000),
    } });
    subscriber = publisher.duplicate();
    for (const client of [publisher, subscriber]) client.on('error', (err) => logger.warn('Redis connection error', { err }));
    logAdapterErrors(publisher, ['publish'], logger);
    let initialSubscriptions = [];
    logAdapterErrors(subscriber, ['pSubscribe', 'subscribe', 'pUnsubscribe', 'unsubscribe'], logger,
      (result) => initialSubscriptions?.push(result));
    try {
      const connections = await Promise.allSettled([publisher.connect(), subscriber.connect()]);
      const failure = connections.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
      io.adapter(createAdapter(publisher, subscriber));
      // The adapter starts SUBSCRIBE and PSUBSCRIBE without awaiting them. A successful
      // TCP connection alone gives no assurance that Redis accepted those subscriptions.
      await Promise.all(initialSubscriptions);
      initialSubscriptions = null;
    } catch (err) {
      await closeRedis();
      throw err;
    }
    // A Pub/Sub outage can lose invalidations while browsers remain connected.
    publisher.on('ready', () => { if (running) void notifyInventoryChanged(); });
    subscriber.on('ready', () => { if (running) void refreshLocal(); });
    io.on(EVENT, refreshLocal); // Redis adapter forwards server-side events to the other replicas.
  }

  io.attach(server);
  if (sessionMiddleware) io.engine.use(sessionMiddleware);
  io.use(async (socket, next) => {
    const userId = socket.request.session?.userId;
    try {
      const user = userId && await findUserById(pool, userId);
      if (user && user.disabled_at === null) return next();
    } catch (err) {
      logger.warn('socket authentication lookup failed', { err });
      const error = new Error('authentication_unavailable');
      error.data = { code: 'authentication_unavailable' };
      return next(error);
    }
    const error = new Error('unauthenticated');
    error.data = { code: 'unauthenticated' };
    next(error);
  });
  io.on('connection', (socket) => {
    socket.join(room(socket.request.sessionID));
    const { userId, cookie } = socket.request.session;
    const timer = setTimeout(() => socket.disconnect(true), new Date(cookie.expires).getTime() - Date.now());
    timer.unref();
    socket.once('disconnect', () => clearTimeout(timer));
    logger.info('realtime client connected', { replica, userId });
  });
  running = true;
  app.locals.notifyInventoryChanged = notifyInventoryChanged;
  app.locals.disconnectSession = (sessionId) => {
    const sockets = io.in(room(sessionId));
    sockets.local.disconnectSockets(true);
    if (publisher?.isReady) sockets.disconnectSockets(true);
  };
  return {
    async close() {
      running = false;
      await io.close();
      await closeRedis();
    },
  };
}
