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
| `GET` / `POST` | `/api/categories` | Staff or manager for reads, manager for creates | List or create a category. See [Catalog](#catalog). |
| `GET` / `POST` | `/api/products`, `/api/locations` | Staff or manager for reads, manager for creates | List catalog records or create one. See [Catalog](#catalog). |
| `PATCH` / `DELETE` | `/api/products/:id`, `/api/locations/:id` | Manager | Edit or archive one record. See [Catalog](#catalog). |
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

### Catalog

Use `GET /api/products` and `GET /api/locations` for product and location pickers. A new catalog record appears immediately, so a manager can set a threshold before the first receipt.

| Endpoint | Input | Success |
| --- | --- | --- |
| `GET /api/categories` | No body | `200 {"categories":[{"id":"2","name":"Grains"}]}` |
| `POST /api/categories` | `{"name":"Grains"}` | `201 {"category":{"id":"2","name":"Grains"}}` |
| `GET /api/products` | Optional query fields `name`, `sku`, `categoryId`, `archived` | `200 {"products":[...]}` |
| `POST /api/products` | `{"sku":"RICE01","name":"Rice","categoryId":"2","description":"5 kg bag"}` | `201 {"product":{...}}` |
| `PATCH /api/products/:id` | One or more of `sku`, `name`, `categoryId`, `description` | `200 {"product":{...}}` |
| `DELETE /api/products/:id` | No body | `200 {"product":{...}}` with `archivedAt` set |
| `GET /api/locations` | Optional query field `archived` | `200 {"locations":[...]}` |
| `POST /api/locations` | `{"name":"Pantry","description":"Ground floor"}` | `201 {"location":{...}}` |
| `PATCH /api/locations/:id` | One or both of `name`, `description` | `200 {"location":{...}}` |
| `DELETE /api/locations/:id` | No body | `200 {"location":{...}}` with `archivedAt` set |

Create the category first, then use its returned ID in `POST /api/products`. A successful response includes the new product and its ID.

```json
{"product":{"id":"7","sku":"RICE01","name":"Rice","categoryId":"2","description":"5 kg bag","archivedAt":null}}
```

A location has `id`, `name`, `description`, and `archivedAt`. IDs are decimal strings. A product's category must exist. SKUs use ASCII letters and digits and are case-sensitive. Category names are also case-sensitive and unique. Locations can share a name, so use their IDs when receiving stock. Descriptions are optional on create. Omit a field on edit to keep its value, or send `"description": null` to clear it.

Lists are sorted by name, then ID. Products and locations default to active records. Use `?archived=true` for archived records only. Product filters combine: `GET /api/products?name=rice&categoryId=2` matches a case-insensitive name substring within category 2. The SKU filter matches exactly.

Archiving keeps balances and movement history. Repeating the archive returns the original archive timestamp. A committed edit or first archive of a product or location sends the existing `inventory:changed` notification so open inventory and movement views can refresh.

Editing an archived record returns `409 product_archived` or `409 location_archived`. Other errors include `400 validation_failed` for invalid fields, `403 forbidden` for staff writes, `404 not_found` for an unknown record or category ID, and `409 duplicate_sku` or `409 duplicate_category` for a uniqueness conflict.

### Live updates

Signed-in browsers listen for the payload-free `inventory:changed` event on Socket.IO's `/api/socket.io/` path using WebSocket transport. Fetch `GET /api/inventory` and `GET /api/movements` on each connection and after a notification. [Implementation and two-replica demo](real-time-updates.md)

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

**`PATCH /api/inventory/:productId/:locationId/threshold`** lets a signed-in manager set or clear a threshold for one active product at one active location. Setting a number, including `0`, starts tracking the pair at quantity `0` if it has no inventory row. An existing balance keeps its quantity. Threshold changes create no stock movements.

For example, a manager selects Rice (`7`) and Pantry (`2`) from the catalog lists and sets a threshold of 5 before the first delivery.

```http
PATCH /api/inventory/7/2/threshold
Content-Type: application/json

{ "reorderThreshold": 5 }
```

Send exactly one body field. `reorderThreshold` accepts a JSON integer from `0` through `2147483647`, or `null` to clear it. The default is `null`. Clearing a threshold keeps an existing inventory row. For an active pair with no row, clearing returns `200` with `reorderThreshold: null` and leaves the pair untracked. Both path IDs use the same positive decimal range as the inventory filters.

The example returns HTTP `200` with the saved setting. Rice now appears under `out_of_stock` at the Pantry. Receiving 3 units there keeps the threshold at 5 and changes the status to `low`.

```json
{ "productId": "7", "locationId": "2", "reorderThreshold": 5 }
```

| Status and code | When |
| --- | --- |
| `400 validation_failed` | Invalid path ID, missing or extra field, or invalid threshold. |
| `401 unauthenticated` | Missing or expired session, or the signed-in account was removed or disabled. |
| `403 forbidden` | The signed-in account is staff. |
| `404 not_found` | The product ID or location ID does not exist. |
| `409 product_archived` or `409 location_archived` | The selected product or location is archived. |

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

### Retried stock requests

Stock operation requests accept an optional `clientRequestKey` (any non-blank string the client generates once per intentional submission, e.g. `crypto.randomUUID()`). A retry of the same submission reuses the key and receives the original result instead of applying the change twice. See `stock_operations.client_request_key` in [`db/SCHEMA.md`](../db/SCHEMA.md).
