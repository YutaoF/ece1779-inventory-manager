import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { loadConfig, readSetting } from '../src/config.js';

const tmp = mkdtempSync(path.join(tmpdir(), 'inventory-config-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function secretFile(name, contents) {
  const file = path.join(tmp, name);
  writeFileSync(file, contents);
  return file;
}

const minimal = { DATABASE_URL: 'postgres://app@db:5432/inventory' };

describe('readSetting', () => {
  it('reads a direct value', () => {
    assert.equal(readSetting({ FOO: 'bar' }, 'FOO'), 'bar');
  });

  it('treats an empty value as unset', () => {
    assert.equal(readSetting({ FOO: '' }, 'FOO'), undefined);
  });

  it('reads NAME_FILE and strips one trailing newline', () => {
    const file = secretFile('secret-lf', 's3cret\n');
    assert.equal(readSetting({ FOO_FILE: file }, 'FOO'), 's3cret');
  });

  it('strips a Windows line ending', () => {
    const file = secretFile('secret-crlf', 's3cret\r\n');
    assert.equal(readSetting({ FOO_FILE: file }, 'FOO'), 's3cret');
  });

  it('rejects setting both NAME and NAME_FILE', () => {
    const file = secretFile('secret-both', 'x');
    assert.throws(() => readSetting({ FOO: 'a', FOO_FILE: file }, 'FOO'), /either FOO or FOO_FILE/);
  });

  it('rejects an unreadable file', () => {
    assert.throws(
      () => readSetting({ FOO_FILE: path.join(tmp, 'missing') }, 'FOO'),
      /Could not read FOO_FILE/,
    );
  });

  it('rejects an empty file', () => {
    const file = secretFile('secret-empty', '\n');
    assert.throws(() => readSetting({ FOO_FILE: file }, 'FOO'), /empty file/);
  });
});

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(minimal);
    assert.equal(config.nodeEnv, 'development');
    assert.equal(config.isProduction, false);
    assert.equal(config.host, '0.0.0.0');
    assert.equal(config.port, 3000);
    assert.equal(config.logLevel, 'info');
    assert.equal(config.database.url, minimal.DATABASE_URL);
    assert.equal(config.database.password, undefined);
    assert.equal(config.database.poolMax, 10);
    assert.equal(config.staticDir, undefined);
  });

  it('requires DATABASE_URL', () => {
    assert.throws(() => loadConfig({}), /DATABASE_URL/);
  });

  it('reads the database password from a secret file', () => {
    const file = secretFile('db_password', 'from-secret\n');
    const config = loadConfig({ ...minimal, DATABASE_PASSWORD_FILE: file });
    assert.equal(config.database.password, 'from-secret');
  });

  it('flags production', () => {
    assert.equal(loadConfig({ ...minimal, NODE_ENV: 'production' }).isProduction, true);
  });

  it('rejects a non-numeric PORT', () => {
    assert.throws(() => loadConfig({ ...minimal, PORT: 'eighty' }), /PORT must be a whole number/);
  });

  it('rejects an out-of-range PORT', () => {
    assert.throws(() => loadConfig({ ...minimal, PORT: '70000' }), /PORT must be between/);
  });

  it('rejects an unknown LOG_LEVEL', () => {
    assert.throws(() => loadConfig({ ...minimal, LOG_LEVEL: 'verbose' }), /LOG_LEVEL/);
  });
});
