import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

/**
 * Password hashing with Node's built-in scrypt: memory-hard, no native
 * dependency to compile in the Docker image.
 *
 * Stored format (in users.password_hash):
 *   scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
 * The parameters travel with each hash, so they can be raised later without
 * breaking existing accounts.
 */
const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
// scrypt needs 128 * N * r bytes; allow headroom above Node's 32 MiB default.
const MAX_MEMORY = 128 * 1024 * 1024;

/** Longer inputs are rejected so a huge "password" can't tie up the CPU. */
export const MAX_PASSWORD_LENGTH = 1024;
export const MIN_PASSWORD_LENGTH = 8;

async function derive(password, salt, { N, r, p }, keyLength) {
  return scryptAsync(password.normalize('NFKC'), salt, keyLength, { N, r, p, maxmem: MAX_MEMORY });
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new RangeError(`Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`);
  }
  const salt = randomBytes(SALT_LENGTH);
  const hash = await derive(password, salt, PARAMS, KEY_LENGTH);
  const { N, r, p } = PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function parseStoredHash(stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isSafeInteger) || N < 2 || (N & (N - 1)) !== 0 || r < 1 || p < 1) return null;
  if (128 * N * r > MAX_MEMORY) return null;
  const salt = Buffer.from(parts[4], 'base64');
  const hash = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || hash.length === 0) return null;
  return { params: { N, r, p }, salt, hash };
}

/**
 * True only if `password` matches `stored`. Never throws for a bad password
 * or a malformed/unknown stored hash (e.g. the test-only placeholders); those
 * just don't match.
 */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return false;
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  const candidate = await derive(password, parsed.salt, parsed.params, parsed.hash.length);
  return timingSafeEqual(candidate, parsed.hash);
}

/**
 * A real hash of a random password, checked when the email is unknown so a
 * failed login takes about as long whether or not the account exists.
 */
let dummyHash;
export async function verifyAgainstDummy(password) {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64'));
  await verifyPassword(typeof password === 'string' ? password : '', await dummyHash);
  return false;
}
