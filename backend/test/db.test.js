import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'pg-connection-string';
import { connectionStringWithPassword } from '../src/db.js';

describe('connectionStringWithPassword', () => {
  it('leaves the URL alone when no password is given', () => {
    const url = 'postgres://inventory:inline@db:5432/inventory';
    assert.equal(connectionStringWithPassword(url, undefined), url);
  });

  it('adds the password to a URL without one', () => {
    const result = parse(connectionStringWithPassword('postgres://inventory@db:5432/inventory', 's3cret'));
    assert.equal(result.user, 'inventory');
    assert.equal(result.password, 's3cret');
    assert.equal(result.host, 'db');
    assert.equal(result.port, '5432');
    assert.equal(result.database, 'inventory');
  });

  it('replaces a password already in the URL', () => {
    const result = parse(connectionStringWithPassword('postgres://inventory:old@db/inventory', 'new'));
    assert.equal(result.password, 'new');
  });

  it('survives special characters in generated secrets', () => {
    const password = 'a/b+c=d@e:f?g#h%i j';
    const result = parse(connectionStringWithPassword('postgres://inventory@db/inventory', password));
    assert.equal(result.password, password);
  });

  it('rejects a non-URL connection string when a password is given', () => {
    assert.throws(() => connectionStringWithPassword('host=db user=inventory', 'x'), /must be a URL/);
  });
});
