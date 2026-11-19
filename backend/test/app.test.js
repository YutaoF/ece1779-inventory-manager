import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import express from 'express';
import { errorHandler, HttpError } from '../src/middleware/errors.js';
import { createLogger } from '../src/logger.js';
import { closeServer, fakePool, startApp } from './helpers.js';

const pool = fakePool(() => ({ rows: [{ version: 2 }] }));

describe('API routing', () => {
  it('returns a JSON 404 for unknown /api paths', async () => {
    const server = await startApp({ pool });
    try {
      const res = await fetch(`${server.url}/api/nope`);
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), {
        error: { code: 'not_found', message: 'No route for GET /api/nope' },
      });
    } finally {
      await server.close();
    }
  });

  it('rejects malformed JSON with 400 invalid_json', async () => {
    const server = await startApp({ pool });
    try {
      const res = await fetch(`${server.url}/api/anything`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"oops":',
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, 'invalid_json');
    } finally {
      await server.close();
    }
  });

  it('does not advertise Express', async () => {
    const server = await startApp({ pool });
    try {
      const res = await fetch(`${server.url}/healthz`);
      assert.equal(res.headers.get('x-powered-by'), null);
    } finally {
      await server.close();
    }
  });
});

describe('request IDs', () => {
  it('generates one when none is sent', async () => {
    const server = await startApp({ pool });
    try {
      const res = await fetch(`${server.url}/healthz`);
      assert.match(res.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    } finally {
      await server.close();
    }
  });

  it('keeps a safe upstream ID and replaces an unsafe one', async () => {
    const server = await startApp({ pool });
    try {
      const kept = await fetch(`${server.url}/healthz`, { headers: { 'x-request-id': 'nginx-abc123' } });
      assert.equal(kept.headers.get('x-request-id'), 'nginx-abc123');

      const replaced = await fetch(`${server.url}/healthz`, { headers: { 'x-request-id': 'bad id<script>' } });
      assert.notEqual(replaced.headers.get('x-request-id'), 'bad id<script>');
    } finally {
      await server.close();
    }
  });
});

describe('errorHandler', () => {
  async function run(handler) {
    const lines = [];
    const logger = createLogger({ stream: { write: (line) => lines.push(JSON.parse(line)) } });
    const app = express();
    app.use((req, res, next) => {
      req.log = logger;
      next();
    });
    app.get('/boom', handler);
    app.use(errorHandler);
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/boom`);
      return { status: res.status, body: await res.json(), lines };
    } finally {
      await closeServer(server);
    }
  }

  it('returns HttpError status, code, message and details', async () => {
    const { status, body } = await run(async () => {
      throw new HttpError(409, 'insufficient_stock', 'Not enough stock', { available: 2 });
    });
    assert.equal(status, 409);
    assert.deepEqual(body, {
      error: { code: 'insufficient_stock', message: 'Not enough stock', details: { available: 2 } },
    });
  });

  it('hides unexpected errors from the client but logs them', async () => {
    const { status, body, lines } = await run(async () => {
      throw new Error('duplicate key value violates unique constraint "users_email_unique"');
    });
    assert.equal(status, 500);
    assert.deepEqual(body, { error: { code: 'internal_error', message: 'Internal server error' } });
    assert.equal(lines.length, 1);
    assert.match(lines[0].err.message, /users_email_unique/);
  });
});

describe('frontend serving', () => {
  const staticDir = mkdtempSync(path.join(tmpdir(), 'inventory-static-'));
  writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(path.join(staticDir, 'app.js'), 'console.log("hi")');
  after(() => rmSync(staticDir, { recursive: true, force: true }));

  it('serves static files and falls back to index.html for client routes', async () => {
    const server = await startApp({ pool, staticDir });
    try {
      const asset = await fetch(`${server.url}/app.js`);
      assert.equal(asset.status, 200);
      assert.equal(await asset.text(), 'console.log("hi")');

      for (const route of ['/', '/products/42']) {
        const page = await fetch(`${server.url}${route}`);
        assert.equal(page.status, 200, route);
        assert.match(await page.text(), /id="root"/, route);
      }
    } finally {
      await server.close();
    }
  });

  it('still returns JSON 404 for unknown /api paths', async () => {
    const server = await startApp({ pool, staticDir });
    try {
      const res = await fetch(`${server.url}/api/nope`);
      assert.equal(res.status, 404);
      assert.equal((await res.json()).error.code, 'not_found');
    } finally {
      await server.close();
    }
  });
});
