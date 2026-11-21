import { HttpError } from '../middleware/errors.js';

export function textFilter(query, field) {
  const value = query[field];
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new HttpError(400, 'validation_failed', `Provide one nonblank text value for ${field}.`);
  }
  return value.trim();
}

export function idFilter(query, field) {
  const value = textFilter(query, field);
  if (value === null) return null;
  const id = /^\d+$/.test(value) ? BigInt(value) : 0n;
  if (id < 1n || id > 9223372036854775807n) {
    throw new HttpError(400, 'validation_failed', `${field} must be a positive PostgreSQL bigint ID.`);
  }
  return id.toString();
}
