# API conventions

The contract every backend route and the React client follow. Runtime and deployment details are in [`backend/README.md`](../backend/README.md); the database is described in [`db/SCHEMA.md`](../db/SCHEMA.md).

## Basics

- All application endpoints live under `/api` and speak JSON (`Content-Type: application/json`). Request bodies are limited to 100 KB.
- Authentication uses a session cookie set by `POST /api/auth/login` (stage 2). The browser sends it automatically; clients never handle tokens.
- Only the backend enforces permissions. The frontend may hide controls by role, but every protected route checks the role again.
- IDs are numbers in JSON. Timestamps are ISO 8601 strings in UTC.
- Every response carries an `X-Request-Id` header. Include it when reporting a bug; it matches the server log line.

## Errors

Every error response has the same shape:

```json
{ "error": { "code": "insufficient_stock", "message": "Not enough stock at this location", "details": { "available": 2 } } }
```

`code` is a stable, machine-readable `snake_case` string the frontend can branch on. `message` is for people. `details` is optional.

| Status | When | Example `code` |
| --- | --- | --- |
| `400` | Malformed request (bad JSON, wrong types, missing fields) | `invalid_json`, `validation_failed` |
| `401` | Not logged in, or the session expired | `unauthenticated` |
| `403` | Logged in but the role is not allowed | `forbidden` |
| `404` | Unknown route or record | `not_found` |
| `409` | Conflicts with current state (negative stock, duplicate SKU, reused request key with different content) | `insufficient_stock`, `duplicate_sku` |
| `413` | Body over 100 KB | `payload_too_large` |
| `500` | Unexpected server error; details are only in the server log | `internal_error` |
| `503` | Not ready (health check only) | — |

In server code, throw `new HttpError(status, code, message, details)` from `backend/src/middleware/errors.js`.

## Endpoints

### Implemented

| Method | Path | Auth | Response |
| --- | --- | --- | --- |
| `GET` | `/healthz` | none | `200 {"status":"ok"}` |
| `GET` | `/readyz` | none | `200 {"status":"ready","schemaVersion":2}` or `503 {"status":"not_ready","reason":"database_unreachable" \| "schema_missing" \| "schema_outdated" \| "shutting_down"}` |

`/healthz` and `/readyz` are for Docker and the gateway. They are not under `/api` and may be blocked from the public internet at Nginx.

### Planned route prefixes

Each prefix is one folder in `backend/src/` with its own router, mounted in `backend/src/routes/api.js`. Request and response shapes are documented here by whoever implements the prefix, in the same pull request.

| Prefix | Covers | Roles |
| --- | --- | --- |
| `/api/auth` | login, logout, current user | public (login), any logged-in user |
| `/api/users` | create accounts, change role, disable | manager |
| `/api/categories` | list, create | read: any; write: manager |
| `/api/products` | list/search, create, edit, archive | read: any; write: manager |
| `/api/locations` | list, create, edit, archive | read: any; write: manager |
| `/api/inventory` | balances per product/location, low-stock dashboard, reorder thresholds | read: any; thresholds: manager |
| `/api/stock-operations` | receive, issue, transfer (any user); correction (manager) | any logged-in user |
| `/api/movements` | history, filtered by product, location, actor or date | any logged-in user |

### Retried stock requests (proposed; final shape is up to the stock operations owner)

Stock operation requests accept an optional `clientRequestKey` (any non-blank string the client generates once per intentional submission, e.g. `crypto.randomUUID()`). A retry of the same submission reuses the key and receives the original result instead of applying the change twice. See `stock_operations.client_request_key` in [`db/SCHEMA.md`](../db/SCHEMA.md).
