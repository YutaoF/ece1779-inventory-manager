import { findUserById } from '../auth/users.js';
import { HttpError } from './errors.js';

export async function requireActiveUser(req, res, next) {
  res.set('Cache-Control', 'no-store');
  const userId = req.session?.userId;
  const user = userId && await findUserById(req.app.locals.pool, userId);
  if (!user || user.disabled_at !== null) {
    throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');
  }
  res.locals.userRole = user.role;
  next();
}

export function requireManager(req, res, next) {
  if (res.locals.userRole !== 'manager') {
    throw new HttpError(403, 'forbidden', 'A manager account is required.');
  }
  next();
}
