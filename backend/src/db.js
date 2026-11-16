import pg from 'pg';

/**
 * The newest migration this code depends on. Bump it in the same pull request
 * that adds a migration the code needs; /readyz stays unready until the
 * database has been migrated at least this far.
 */
export const REQUIRED_SCHEMA_VERSION = 2;

/**
 * Returns the connection URL with `password` written into it.
 *
 * pg gives values parsed from the connection string priority over separate
 * options, so passing `password` alongside a URL without one does not work;
 * the password has to go into the URL itself. It is percent-encoded first
 * because the URL setter leaves characters such as `%` and `+` as they are,
 * which pg would then misread.
 */
export function connectionStringWithPassword(url, password) {
  if (password === undefined) return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DATABASE_URL must be a URL like postgres://user@host:5432/db when DATABASE_PASSWORD is set');
  }
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

/**
 * Creates the shared connection pool. Every route and service gets this pool
 * from `req.app.locals.pool` rather than opening its own connections.
 */
export function createPool(databaseConfig, logger) {
  const pool = new pg.Pool({
    connectionString: connectionStringWithPassword(databaseConfig.url, databaseConfig.password),
    max: databaseConfig.poolMax,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    application_name: 'inventory-api',
  });

  // An idle client losing its connection (e.g. the db container restarting)
  // emits 'error' on the pool; without a listener that would crash the process.
  pool.on('error', (err) => {
    logger.warn('idle database client error', { err });
  });

  return pool;
}
