# Backend (`inventory-api`)

Express 5 + `pg` service that serves the JSON API under `/api` and, in production, the built React app.

## Run locally

Requires Node 18.17+ (Node 22 LTS recommended) and a PostgreSQL database migrated with [`db/migrate.sql`](../db/migrate.sql).

```bash
cd backend
npm install
cp .env.example .env   # then edit DATABASE_URL / DATABASE_PASSWORD
node --env-file=.env src/server.js   # Node 20+; on Node 18 export the variables yourself
npm test
```

## Layout

```
backend/
  src/
    server.js            entry point: config, pool, HTTP server, graceful shutdown
    app.js               createApp(): middleware order, routers, frontend serving
    config.js            all environment/secret-file settings, validated at startup
    db.js                shared pg pool, REQUIRED_SCHEMA_VERSION
    logger.js            JSON-lines logger
    middleware/          request IDs + access log, HttpError + error handler
    routes/
      health.js          /healthz, /readyz
      api.js             mounts every feature router under /api
    auth/                sessions, password hashing, role middleware   (stage 2–3)
    <feature>/           one folder per feature area: router + service + queries
  test/                  node:test suites (`npm test`)
```

Conventions for adding a feature:

- Put it in `src/<feature>/` with a `router.js` exporting a function that returns an Express `Router`, and mount it in `src/routes/api.js`.
- Get the pool from `req.app.locals.pool` and the request logger from `req.log`.
- Throw `HttpError(status, code, message, details?)` for expected failures. Anything else becomes a generic 500 and is logged with its stack.
- Async handlers can just `throw`/reject; Express 5 forwards it to the error handler.

## Runtime contract (for the Dockerfile, Compose and Swarm stack)

| Item | Value |
| --- | --- |
| Start command | `node src/server.js` (from `backend/`); no build step |
| Install | `npm ci --omit=dev` |
| Listens on | `PORT` (default `3000`) on `HOST` (default `0.0.0.0`) |
| Liveness | `GET /healthz` → `200 {"status":"ok"}`; never touches the database |
| Readiness | `GET /readyz` → `200` when the database is reachable and migrated to `REQUIRED_SCHEMA_VERSION`, otherwise `503` with a `reason` |
| Shutdown | Handles `SIGTERM`: stops accepting connections, finishes in-flight requests, closes the pool, exits within `SHUTDOWN_TIMEOUT_MS` (default 10 s) |
| Logs | One JSON object per line on stdout; `/healthz` and `/readyz` hits are only logged at `LOG_LEVEL=debug` |
| Migrations | Not run by the app. Run `psql -v ON_ERROR_STOP=1 -f db/migrate.sql` before (or alongside) starting it; `/readyz` stays `503` until done |
| Frontend | Set `STATIC_DIR` to the React build directory to serve it; unknown non-`/api` GET paths return its `index.html` |

### Settings

Every setting can be given as `NAME` or as `NAME_FILE` pointing to a file holding the value (Swarm secrets mount at `/run/secrets/<name>`). Setting both is an error, and invalid values stop the process at startup.

| Setting | Required | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | — | e.g. `postgres://inventory@db:5432/inventory`; may omit the password |
| `DATABASE_PASSWORD` | no | — | Overrides the URL's password. In Swarm use `DATABASE_PASSWORD_FILE=/run/secrets/db_password`, the same secret the postgres service reads via `POSTGRES_PASSWORD_FILE` |
| `DATABASE_POOL_MAX` | no | `10` | Per replica. Keep `replicas × pool max` under Postgres's `max_connections` (100 by default) |
| `SESSION_SECRET` | from stage 2 | — | Use `SESSION_SECRET_FILE` in Swarm |
| `REDIS_URL` | when real-time lands | — | e.g. `redis://redis:6379` |
| `STATIC_DIR` | no | — | Path to the React build |
| `NODE_ENV` | no | `development` | Set `production` in the image |
| `PORT`, `HOST` | no | `3000`, `0.0.0.0` | |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, `error` |
| `SHUTDOWN_TIMEOUT_MS` | no | `10000` | Keep below the stack's `stop_grace_period` |
