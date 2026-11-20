# Backend (`inventory-api`)

Express 5 + `pg` service that serves the JSON API under `/api` and, in production, the built React app.

## Run locally

Requires Node 22 LTS (minimum 18.18 or 20.9; older 18.x releases skip the stock tests' setup and fail) and Docker.

From the repo root, start Postgres and Redis with the root [`compose.yaml`](../compose.yaml) and apply the migrations:

```bash
cp .env.example .env
docker compose up -d --wait
docker compose cp db db:/tmp/db
docker compose exec db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /tmp/db/migrate.sql'
```

Rerunning the migration is safe; versions already applied are skipped. Then, in `backend/`:

```bash
npm install
cp .env.example .env   # values already match the Compose defaults
node --env-file=.env scripts/create-user.js --email you@example.com --name "Your Name"
node --env-file=.env src/server.js
node --env-file=.env --test   # all tests; the stock and auth tests need TEST_DATABASE_URL
```

Plain `npm test` does not read `.env`, so the database tests fail with "Set TEST_DATABASE_URL" unless it is exported in your shell.

### Creating accounts

`scripts/create-user.js` adds an account directly in the database. It's the only way to create the first manager; later accounts can come from the users API (stage 3).

```bash
node --env-file=.env scripts/create-user.js --email you@example.com --name "Your Name"             # manager
node --env-file=.env scripts/create-user.js --email helper@example.com --name "Helper" --role staff
```

It prints a generated password once. To choose the password instead, set `NEW_USER_PASSWORD` (at least 8 characters) in the environment; it is never taken as an argument, so it stays out of shell history. On a server, run it inside an app container: `docker exec -it <container> node scripts/create-user.js ...`.

Passwords are hashed with scrypt (Node's built-in `crypto`, no native modules).

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
    auth/                sessions, password hashing, /api/auth routes; role middleware (stage 3)
  scripts/
    create-user.js       create an account from the command line (first manager)
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
| `SESSION_SECRET` | in production | random per process (development only) | At least 32 bytes, the same on every replica. Use `SESSION_SECRET_FILE=/run/secrets/session_secret` in Swarm. Without it in development, sign-ins reset when the app restarts |
| `REDIS_URL` | when real-time lands | — | e.g. `redis://redis:6379` |
| `STATIC_DIR` | no | — | Path to the React build |
| `NODE_ENV` | no | `development` | Set `production` in the image |
| `PORT`, `HOST` | no | `3000`, `0.0.0.0` | |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, `error` |
| `SHUTDOWN_TIMEOUT_MS` | no | `10000` | Keep below the stack's `stop_grace_period` |
