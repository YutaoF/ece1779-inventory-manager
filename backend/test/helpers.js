import { createApp } from '../src/app.js';
import { silentLogger } from '../src/logger.js';

/** A stand-in for pg.Pool whose query() returns or throws what the test says. */
export function fakePool(respond) {
  return { query: async (...args) => respond(...args) };
}

/** Starts the app on a random port and returns its base URL plus a close(). */
export async function startApp(options = {}) {
  const app = createApp({ logger: silentLogger, ...options });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    app,
    url: `http://127.0.0.1:${port}`,
    close: () => closeServer(server),
  };
}

/** Closes a server without waiting for fetch's keep-alive sockets to time out. */
export function closeServer(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}
