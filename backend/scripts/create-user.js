#!/usr/bin/env node
/**
 * Creates a user account. Mainly for the first manager, since nobody can sign
 * in to create accounts before one exists.
 *
 *   node --env-file=.env scripts/create-user.js --email you@example.com --name "Your Name" [--role manager|staff]
 *
 * The password comes from the NEW_USER_PASSWORD environment variable if set
 * (so it never appears in shell history or `ps`); otherwise a random one is
 * generated and printed once. In a running container:
 *
 *   docker exec -it <app container> node scripts/create-user.js --email ... --name ...
 *
 * Uses the same DATABASE_URL / DATABASE_PASSWORD(_FILE) settings as the app.
 */
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/auth/password.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { createLogger } from '../src/logger.js';

const UNIQUE_VIOLATION = '23505';
const ROLES = ['manager', 'staff'];

function fail(message) {
  console.error(`create-user: ${message}`);
  process.exit(1);
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      role: { type: 'string', default: 'manager' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (err) {
  fail(err.message);
}

if (args.help) {
  console.log('Usage: node scripts/create-user.js --email <email> --name <name> [--role manager|staff]');
  console.log('Password: NEW_USER_PASSWORD env var, or a generated one printed once.');
  process.exit(0);
}

const email = args.email?.trim();
const name = args.name?.trim();
if (!email || !email.includes('@')) fail('--email is required (e.g. --email you@example.com)');
if (!name) fail('--name is required (e.g. --name "Your Name")');
if (!ROLES.includes(args.role)) fail(`--role must be one of ${ROLES.join(', ')}`);

const providedPassword = process.env.NEW_USER_PASSWORD;
if (providedPassword !== undefined && providedPassword.length < MIN_PASSWORD_LENGTH) {
  fail(`NEW_USER_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
}
const password = providedPassword ?? randomBytes(15).toString('base64url');

let config;
try {
  config = loadConfig();
} catch (err) {
  fail(err.message);
}

const pool = createPool(config.database, createLogger({ level: 'error' }));
try {
  const passwordHash = await hashPassword(password);
  const result = await pool.query(
    'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id::text AS id',
    [name, email, passwordHash, args.role],
  );
  console.log(`Created ${args.role} ${email} (id ${result.rows[0].id}).`);
  if (providedPassword === undefined) {
    console.log(`Generated password (shown once, store it now): ${password}`);
  }
} catch (err) {
  if (err.code === UNIQUE_VIOLATION) fail(`a user with email ${email} already exists`);
  fail(err.message);
} finally {
  await pool.end();
}
