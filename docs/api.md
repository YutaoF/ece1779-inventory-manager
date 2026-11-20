# API conventions

The contract every backend route and the React client follow. Runtime and deployment details are in [`backend/README.md`](../backend/README.md); the database is described in [`db/SCHEMA.md`](../db/SCHEMA.md).

## Basics

- All application endpoints live under `/api` and speak JSON (`Content-Type: application/json`). Request bodies are limited to 100 KB.
- Authentication uses an `httpOnly` session cookie (`inventory.sid`, path `/api`, 8 hours) set by `POST /api/auth/login`. The browser sends it automatically; JavaScript can't read it and clients never handle tokens. Serve the frontend from the same origin as the API (the Vite dev server should proxy `/api` to the backend) so the cookie is sent without CORS setup.
- Only the backend enforces permissions. The frontend may hide controls by role, but every protected route checks the role again.
- Stock responses always return IDs as decimal strings, including on retries. Stock requests accept positive decimal strings and positive, safe JSON integers. Quantities are JSON numbers. Timestamps use ISO 8601 in UTC.
- Every response carries an `X-Request-Id` header. Include it when reporting a bug; it matches the server log line.

## Errors

Every error response has the same shape:

```json
{ "error": { "code": "insufficient_stock", "message": "Not enough stock at this location" } }
```

`code` is a stable, machine-readable `snake_case` string the frontend can branch on. `message` is for people. `details` is optional.

| Status | When | Example `code` |
| --- | --- | --- |
| `400` | Malformed request (bad JSON, wrong types, missing fields) | `invalid_json`, `validation_failed` |
| `401` | A missing or expired session, or a missing or disabled stock actor; on login, wrong credentials | `unauthenticated`, `invalid_credentials` |
| `403` | Logged in but the role is not allowed | `forbidden` |
| `404` | Unknown route or record | `not_found` |
| `409` | Conflicts with current state, such as insufficient stock or a reused request key with different content | `insufficient_stock`, `request_key_conflict` |
| `413` | Body over 100 KB | `payload_too_large` |
| `500` | Unexpected server error; details are only in the server log | `internal_error` |
| `503` | Not ready (health check), or sign-in unavailable because sessions aren't configured | `sessions_disabled` |

In server code, throw `new HttpError(status, code, message, details)` from `backend/src/middleware/errors.js`.

## Endpoints

### Implemented

| Method | Path | Auth | Response |
| --- | --- | --- | --- |
| `GET` | `/healthz` | none | `200 {"status":"ok"}` |
| `GET` | `/readyz` | none | `200 {"status":"ready","schemaVersion":2}` or `503 {"status":"not_ready","reason":"database_unreachable" \| "schema_missing" \| "schema_outdated" \| "shutting_down"}` |
| `POST` | `/api/auth/login` | none | `200 {"user":{...}}` and the session cookie. See [Auth](#auth). |
| `POST` | `/api/auth/logout` | none | `204`; deletes the session (also `204` when not signed in). |
| `GET` | `/api/auth/me` | signed in | `200 {"user":{...}}`, or `401 unauthenticated`. |
| `POST` | `/api/stock-operations/receive` | Staff or manager | `200` with the recorded receipt and resulting balance. |
| `POST` | `/api/stock-operations/issue` | Staff or manager | `200` with the recorded issue and resulting balance. |
| `POST` | `/api/stock-operations/correction` | Manager | `200` with the signed adjustment and resulting balance. |
| `POST` | `/api/stock-operations/transfer` | Staff or manager | `200` with both movement IDs and both resulting balances. |

See the [Stock Operations API Guide](../backend/STOCK_OPERATIONS_API_GUIDE.md) for the exact request and response objects for every stock action.

`/healthz` and `/readyz` are for Docker and the gateway. They are not under `/api` and may be blocked from the public internet at Nginx.

### Auth

**`POST /api/auth/login`**

```json
{ "email": "sam@example.com", "password": "correct horse battery" }
```

Email matching ignores case and surrounding spaces. Success:

```json
{ "user": { "id": "1", "name": "Sam Lee", "email": "sam@example.com", "role": "manager" } }
```

| Status | `code` | When |
| --- | --- | --- |
| `400` | `validation_failed` | `email` or `password` missing, empty or not a string |
| `401` | `invalid_credentials` | Wrong password, unknown email or disabled account (deliberately the same response) |
| `503` | `sessions_disabled` | The server has no `SESSION_SECRET` |

Signing in replaces any previous session. `role` is `"manager"` or `"staff"`; use it to show or hide controls, but the server checks it again on every request.

**`GET /api/auth/me`** returns the same `{ "user": ... }` for the current session. Call it when the app loads to decide between the login page and the main view. A `401` means not signed in, the session expired, or the account was disabled since login.

**`POST /api/auth/logout`** takes no body and returns `204`.

Any request can return `401 unauthenticated` once the 8-hour session expires; send the user back to the login page when that happens.

### Planned route prefixes

Each prefix is one folder in `backend/src/` with its own router, mounted in `backend/src/routes/api.js`. Request and response shapes are documented here by whoever implements the prefix, in the same pull request.

| Prefix | Covers | Roles |
| --- | --- | --- |
| `/api/users` | create accounts, change role, disable | manager |
| `/api/categories` | list, create | read: any; write: manager |
| `/api/products` | list/search, create, edit, archive | read: any; write: manager |
| `/api/locations` | list, create, edit, archive | read: any; write: manager |
| `/api/inventory` | balances per product/location, low-stock dashboard, reorder thresholds | read: any; thresholds: manager |
| `/api/movements` | history, filtered by product, location, actor or date | any logged-in user |

### Retried stock requests

Stock operation requests accept an optional `clientRequestKey` (any non-blank string the client generates once per intentional submission, e.g. `crypto.randomUUID()`). A retry of the same submission reuses the key and receives the original result instead of applying the change twice. See `stock_operations.client_request_key` in [`db/SCHEMA.md`](../db/SCHEMA.md).
