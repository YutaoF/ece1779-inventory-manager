import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hashPassword, MAX_PASSWORD_LENGTH, verifyAgainstDummy, verifyPassword,
} from '../src/auth/password.js';

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery');
    assert.match(stored, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.equal(await verifyPassword('correct horse battery', stored), true);
    assert.equal(await verifyPassword('correct horse batterz', stored), false);
  });

  it('salts each hash', async () => {
    const [a, b] = await Promise.all([hashPassword('same password'), hashPassword('same password')]);
    assert.notEqual(a, b);
  });

  it('treats Unicode-equivalent passwords as the same', async () => {
    const stored = await hashPassword('café-password');
    assert.equal(await verifyPassword('café-password', stored), true);
  });

  it('refuses to hash passwords that are too short or too long', async () => {
    await assert.rejects(hashPassword('short'), RangeError);
    await assert.rejects(hashPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1)), RangeError);
  });

  it('never matches malformed or placeholder stored hashes', async () => {
    for (const stored of ['test-only-hash', '', null, 'scrypt$1$8$1$AA==$AA==', 'scrypt$1048576$8$1$AA==$AA==', 'bcrypt$x$y$z$a$b']) {
      assert.equal(await verifyPassword('anything-at-all', stored), false, String(stored));
    }
  });

  it('rejects empty and oversized login attempts without hashing', async () => {
    const stored = await hashPassword('correct horse battery');
    assert.equal(await verifyPassword('', stored), false);
    assert.equal(await verifyPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1), stored), false);
    assert.equal(await verifyPassword(undefined, stored), false);
  });

  it('dummy verification always fails', async () => {
    assert.equal(await verifyAgainstDummy('whatever'), false);
  });
});
