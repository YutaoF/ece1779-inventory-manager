import { Pool } from 'pg';

/** Create one shared pool per application process and call pool.end() on shutdown. */
export function createDatabasePool({
  connectionString = process.env.DATABASE_URL,
  ...options
} = {}) {
  if (typeof connectionString !== 'string' || connectionString.trim() === '') {
    throw new Error('Set DATABASE_URL or pass a PostgreSQL connectionString.');
  }

  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    ...options,
  });

  // Active query errors reach the caller. Idle connection errors need a listener.
  pool.on('error', (error) => {
    console.error('Idle PostgreSQL connection failed', { code: error.code });
  });

  return pool;
}
