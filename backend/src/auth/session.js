import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';

const PgSessionStore = connectPgSimple(session);

/** Name of the session cookie. Scoped to /api, so static files never carry it. */
export const SESSION_COOKIE = 'inventory.sid';
export const SESSION_COOKIE_OPTIONS = {
  path: '/api',
  httpOnly: true,
  sameSite: 'lax',
};
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

/**
 * Sessions live in the Postgres `sessions` table (created by migration 002),
 * so every app replica sees the same logins. The store is also returned so
 * shutdown can stop its expired-session pruning timer.
 */
export function sessionMiddleware(pool, secret, secure) {
  const store = new PgSessionStore({
    pool,
    schemaName: 'public',
    tableName: 'sessions',
    createTableIfMissing: false,
  });

  const middleware = session({
    name: SESSION_COOKIE,
    secret,
    store,
    resave: false,
    saveUninitialized: false,
    cookie: { ...SESSION_COOKIE_OPTIONS, secure, maxAge: SESSION_MAX_AGE_MS },
  });

  return { middleware, store };
}
