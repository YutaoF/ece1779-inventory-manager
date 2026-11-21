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
{ "error": { "code": "insufficient_stock", "message": "There is not enough stock at this location to issue the requested quantity.", "details": { "available": 2 } } }
```

`code` is a stable, machine-readable `snake_case` string the frontend can branch on. `message` is for people. `details` is optional in general. For HTTP `409 insufficient_stock`, `error.details.available` always gives the number of units on hand when the locked balance was checked, including zero. This is the location's balance for an issue or negative correction and the source balance for a transfer.

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
| `GET` | `/api/inventory` | Staff or manager | `200 {"inventory":[...]}` with one current balance per tracked product and location. See [Inventory](#inventory). |
| `PATCH` | `/api/inventory/:productId/:locationId/threshold` | Manager | `200 {"productId":"7","locationId":"2","reorderThreshold":5}`. See [Reorder thresholds](#reorder-thresholds). |
| `GET` | `/api/movements` | Staff or manager | `200 {"movements":[...]}` with one row per committed stock change at a location. See [Movement history](#movement-history). |
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

### Inventory

**`GET /api/inventory`** takes no request body. Active staff and managers can read all tracked balances. A missing or expired session, or a disabled or missing account, returns `401 unauthenticated`.

All query parameters are optional. A request with no filters returns all tracked stock. When filters are combined, a row must match every supplied filter. For example, `GET /api/inventory?locationId=2&name=rice` finds products whose names contain “rice” at location 2.

| Query parameter | Matching rule |
| --- | --- |
| `productId` | Exact product ID. Use positive decimal digits in the PostgreSQL `bigint` range, up to `9223372036854775807`. |
| `locationId` | Exact location ID, with the same range as `productId`. Keep IDs as strings in JavaScript to preserve all digits. |
| `sku` | Exact, case-sensitive SKU. For example, `RICE` and `rice` are distinct. |
| `name` | Case-insensitive substring of the product name. The characters `%` and `_` match literally. |
| `stockStatus` | One of `low`, `out_of_stock`, or `in_stock`. Supplying this filter limits results to active products at active locations. |

Surrounding whitespace is trimmed. A blank value, a repeated filter, an invalid ID, or an unknown status returns `400 validation_failed`. Valid filters with no matching rows return `200 {"inventory":[]}`.

```json
{
  "inventory": [
    {
      "id": "7:2",
      "productId": "7",
      "sku": "RICE",
      "name": "Rice",
      "locationId": "2",
      "location": "Pantry",
      "quantity": 5,
      "reorderThreshold": 5,
      "stockStatus": "low",
      "productArchived": false,
      "locationArchived": false
    }
  ]
}
```

`quantity` is the latest committed balance for that product at that location. A tracked pair with zero stock appears with `quantity: 0`. Untracked pairs have no row. Omit `stockStatus` to include balances for archived products and locations, identified by their archive flags.

| `stockStatus` | When a tracked pair has this status |
| --- | --- |
| `out_of_stock` | Quantity is zero, even when the threshold is `null`. |
| `low` | Quantity is positive and at or below the configured threshold. |
| `in_stock` | Quantity is positive and either above the threshold or the threshold is `null`. |

For the dashboard, fetch `GET /api/inventory?stockStatus=low` for the low-stock section and `GET /api/inventory?stockStatus=out_of_stock` for the out-of-stock section. Add `&locationId=2` to either URL for a single location. Each response contains an `inventory` array whose length gives the count of matching product/location pairs.

Rows are sorted by product name, location name, product ID and location ID. Use the opaque `id` as the React row key. Use `productId` and `locationId`, both decimal strings, when submitting stock operations.


#### Reorder thresholds

**`PATCH /api/inventory/:productId/:locationId/threshold`** sets the reorder threshold for one tracked product at one active location. The product must also be active. Only a signed-in manager can make this change. A threshold edit updates the dashboard status on the next read and creates no stock movement.

For example, this request sets the Pantry threshold for rice to 5 units.

```http
PATCH /api/inventory/7/2/threshold
Content-Type: application/json

{ "reorderThreshold": 5 }
```

Send exactly one body field. `reorderThreshold` accepts a JSON integer from `0` through `2147483647`, or `null` to clear it. Both path IDs use the same positive decimal range as the inventory filters. A successful edit returns HTTP `200` with the saved setting.

```json
{ "productId": "7", "locationId": "2", "reorderThreshold": 5 }
```

| Status and code | When |
| --- | --- |
| `400 validation_failed` | Invalid path ID, missing or extra field, or invalid threshold. |
| `401 unauthenticated` | Missing or expired session, or the signed-in account was removed or disabled. |
| `403 forbidden` | The signed-in account is staff. |
| `404 not_found` | The database has no inventory row for this product/location pair. |
| `409 product_archived` or `409 location_archived` | The tracked product or its location was archived. |

### Movement history

**`GET /api/movements`** takes no request body. Active staff and managers can read movements by any actor. The browser sends the session cookie from login. A missing or expired session, or a disabled or missing account, returns `401 unauthenticated`.

All filters are optional. Omit them to read all committed movements. When filters are combined, each row must match every supplied filter.

| Query parameter | Selects |
| --- | --- |
| `productId` | Changes to one product. |
| `locationId` | Changes at one location. For a transfer, only the movement at that location matches. |
| `actorId` | Changes made by the user with this ID. |
| `from` | Movements recorded at or after this instant (inclusive). |
| `to` | Movements recorded before this instant (exclusive). |

IDs must be positive decimal integers up to `9223372036854775807`. For either date filter, send a UTC date (`2026-11-20` means midnight UTC) or a timestamp with a time zone, such as `2026-11-20T14:30:00Z` or `2026-11-20T09:30:00.123456-05:00`. Timestamps accept up to six fractional-second digits. To select the entire UTC day of November 20, use `from=2026-11-20&to=2026-11-21`. Omit empty form fields. A blank or repeated filter, an invalid ID or date, or a `from` equal to or later than `to` returns `400 validation_failed`. A valid query with no matches returns `200 {"movements":[]}`.

In this example response to `GET /api/movements?locationId=2`, Pete transferred 3 bags of rice out of the pantry.

```json
{
  "movements": [
    {
      "id": "204", "operationId": "104", "operation": "transfer",
      "actorId": "1", "actorName": "Pete",
      "productId": "7", "sku": "RICE", "name": "Rice",
      "locationId": "2", "location": "Pantry",
      "quantityDelta": -3, "quantityAfter": 8, "reason": null,
      "createdAt": "2026-11-20T14:30:00.123456Z"
    }
  ]
}
```

Rows are ordered by `createdAt`, newest first, then by descending movement ID for ties. `createdAt` is a UTC string that preserves PostgreSQL's microsecond precision. Use `id` as the React row key. IDs are strings. `operation` is `receive`, `issue`, `correction`, or `transfer`. A committed transfer produces two rows with the same `operationId`. The source shows a negative `quantityDelta` and the destination shows a positive one. A rolled-back transfer produces no rows.

`quantityAfter` is the balance at that location immediately after the movement. It can be `0`, or `null` for movements imported from migration `001`, where the balance was never recorded. `reason` can be `null` when the actor did not supply one. The API shows current actor, product, and location names. Archiving a product or location keeps its movements visible.


### Planned route prefixes

Each prefix is one folder in `backend/src/` with its own router, mounted in `backend/src/routes/api.js`. Request and response shapes are documented here by whoever implements the prefix, in the same pull request.

| Prefix | Covers | Roles |
| --- | --- | --- |
| `/api/users` | create accounts, change role, disable | manager |
| `/api/categories` | list, create | read: any; write: manager |
| `/api/products` | list/search, create, edit, archive | read: any; write: manager |
| `/api/locations` | list, create, edit, archive | read: any; write: manager |

### Retried stock requests

Stock operation requests accept an optional `clientRequestKey` (any non-blank string the client generates once per intentional submission, e.g. `crypto.randomUUID()`). A retry of the same submission reuses the key and receives the original result instead of applying the change twice. See `stock_operations.client_request_key` in [`db/SCHEMA.md`](../db/SCHEMA.md).
