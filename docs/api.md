# API conventions

The contract every backend route and the React client follow. Runtime and deployment details are in [`backend/README.md`](../backend/README.md); the database is described in [`db/SCHEMA.md`](../db/SCHEMA.md).

## Basics

- All application endpoints live under `/api` and speak JSON (`Content-Type: application/json`). Request bodies are limited to 100 KB.
- Authentication uses a session cookie set by `POST /api/auth/login` (stage 2). The browser sends it automatically; clients never handle tokens.
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
| `401` | A missing or expired session, or a missing or disabled stock actor | `unauthenticated` |
| `403` | Logged in but the role is not allowed | `forbidden` |
| `404` | Unknown route or record | `not_found` |
| `409` | Conflicts with current state, such as insufficient stock or a reused request key with different content | `insufficient_stock`, `request_key_conflict` |
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
| `POST` | `/api/stock-operations/receive` | Staff or manager | `200` with the recorded receipt and resulting balance. |
| `POST` | `/api/stock-operations/issue` | Staff or manager | `200` with the recorded issue and resulting balance. |
| `POST` | `/api/stock-operations/correction` | Manager | `200` with the signed adjustment and resulting balance. |
| `POST` | `/api/stock-operations/transfer` | Staff or manager | `200` with both movement IDs and both resulting balances. |

See the [Stock Operations API Guide](../backend/STOCK_OPERATIONS_API_GUIDE.md) for the exact request and response objects for every stock action.

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
| `/api/movements` | history, filtered by product, location, actor or date | any logged-in user |

### Retried stock requests

Stock operation requests accept an optional `clientRequestKey` (any non-blank string the client generates once per intentional submission, e.g. `crypto.randomUUID()`). A retry of the same submission reuses the key and receives the original result instead of applying the change twice. See `stock_operations.client_request_key` in [`db/SCHEMA.md`](../db/SCHEMA.md).
