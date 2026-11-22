import { Router } from 'express';
import { HttpError } from '../middleware/errors.js';
import { MAX_PASSWORD_LENGTH, verifyAgainstDummy, verifyPassword } from './password.js';
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from './session.js';
import { findUserByEmail, findUserById, toPublicUser } from './users.js';

const MAX_EMAIL_LENGTH = 320;

function requireSessions(req) {
  if (!req.session) {
    throw new HttpError(503, 'sessions_disabled', 'Sign-in is unavailable: SESSION_SECRET is not configured.');
  }
}

// express-session's methods take callbacks; these wrap them as promises.
const regenerate = (req) => new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
const save = (req) => new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
async function destroy(req) {
  const sessionId = req.sessionID;
  await new Promise((resolve, reject) => req.session.destroy((err) => (err ? reject(err) : resolve())));
  req.app.locals.disconnectSession?.(sessionId);
}

function clearSessionCookie(req, res) {
  res.clearCookie(SESSION_COOKIE, { ...SESSION_COOKIE_OPTIONS, secure: req.secure });
}

/**
 * /api/auth
 *
 * POST /login   { email, password } -> 200 { user } and a session cookie
 * POST /logout  -> 204, session deleted (also fine when not signed in)
 * GET  /me      -> 200 { user } for the signed-in user, else 401
 */
export function authRouter() {
  const router = Router();

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.post('/login', async (req, res) => {
    requireSessions(req);
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || email.trim() === '' || email.length > MAX_EMAIL_LENGTH
      || typeof password !== 'string' || password === '' || password.length > MAX_PASSWORD_LENGTH) {
      throw new HttpError(400, 'validation_failed', 'Enter your email and password.');
    }

    const { pool } = req.app.locals;
    const user = await findUserByEmail(pool, email.trim());
    // One response for unknown email, wrong password and disabled account, so
    // the endpoint can't be used to discover which emails have accounts.
    const passwordMatches = user
      ? await verifyPassword(password, user.password_hash)
      : await verifyAgainstDummy(password);
    if (!passwordMatches || user.disabled_at !== null) {
      req.log.warn('login failed', { reason: !user ? 'unknown_email' : !passwordMatches ? 'wrong_password' : 'disabled' });
      throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.');
    }

    // New session ID on login prevents session fixation.
    const previousSessionId = req.session.userId && req.sessionID;
    await regenerate(req);
    if (previousSessionId) req.app.locals.disconnectSession?.(previousSessionId);
    req.session.userId = user.id;
    await save(req);

    req.log.info('login', { userId: user.id, role: user.role });
    res.json({ user: toPublicUser(user) });
  });

  router.post('/logout', async (req, res) => {
    requireSessions(req);
    const userId = req.session.userId;
    await destroy(req);
    clearSessionCookie(req, res);
    if (userId) req.log.info('logout', { userId });
    res.status(204).end();
  });

  router.get('/me', async (req, res) => {
    requireSessions(req);
    const userId = req.session.userId;
    if (!userId) throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');

    const user = await findUserById(req.app.locals.pool, userId);
    if (!user || user.disabled_at !== null) {
      // The account was removed or disabled after this session started.
      await destroy(req);
      clearSessionCookie(req, res);
      throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');
    }
    res.json({ user: toPublicUser(user) });
  });

  return router;
}
