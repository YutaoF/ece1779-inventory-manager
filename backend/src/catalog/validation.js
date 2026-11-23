import { HttpError } from '../middleware/errors.js';
import { idFilter, textFilter } from '../routes/query-filters.js';

export function readBody(body, allowedFields, requiredFields = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length) {
    throw new HttpError(400, 'validation_failed', 'Provide a JSON object with at least one field.');
  }
  for (const field of Object.keys(body)) {
    if (!allowedFields.includes(field)) {
      throw new HttpError(400, 'validation_failed', 'Unknown field: ' + field);
    }
  }
  for (const field of requiredFields) {
    if (!Object.hasOwn(body, field)) {
      throw new HttpError(400, 'validation_failed', 'Missing field: ' + field);
    }
  }
  return body;
}

export function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new HttpError(400, 'validation_failed', field + ' must be nonblank text.');
  }
  return value.trim();
}

export function descriptionValue(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new HttpError(400, 'validation_failed', 'Description must be text or null.');
  }
  return value.trim() || null;
}

export function catalogId(value, field) {
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) {
    throw new HttpError(400, 'validation_failed', field + ' must be a positive ID string or safe integer.');
  }
  return idFilter({ [field]: String(value) }, field);
}

export function archivedFilter(query) {
  const value = textFilter(query, 'archived');
  if (value === null || value === 'false') return false;
  if (value === 'true') return true;
  throw new HttpError(400, 'validation_failed', 'archived must be true or false.');
}
