import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';

const PgSessionStore = connectPgSimple(session);

export function sessionMiddleware(pool, secret, secure) {
  const store = new PgSessionStore({
    pool,
    schemaName: 'public',
    tableName: 'sessions',
    createTableIfMissing: false,
  });

  return session({
    secret,
    store,
    resave: false,
    saveUninitialized: false,
    cookie: {
      path: '/api',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: 8 * 60 * 60 * 1000,
    },
  });
}
