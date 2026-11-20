# Stock Operations API Guide

| HTTP endpoint | Backend service | Who can use it | Required JSON fields |
| --- | --- | --- | --- |
| `POST /api/stock-operations/receive` | [`receiveStock`](src/stock/receive-stock.js) | Staff or manager | `productId`, `locationId`, `quantity` |
| `POST /api/stock-operations/issue` | [`issueStock`](src/stock/issue-stock.js) | Staff or manager | `productId`, `locationId`, `quantity` |
| `POST /api/stock-operations/correction` | [`correctStock`](src/stock/correct-stock.js) | Manager | `productId`, `locationId`, `quantityDelta`, `reason` |
| `POST /api/stock-operations/transfer` | [`transferStock`](src/stock/transfer-stock.js) | Staff or manager | `productId`, `sourceLocationId`, `destinationLocationId`, `quantity` |

## What the frontend sends

- **IDs** can be positive decimal strings or positive, safe JSON integers. Every ID in a stock response is a decimal string, including on retries. Send larger IDs as strings, such as `"9007199254740993"`, to preserve precision.
- **Quantities** are JSON numbers in whole units. For receive, issue, and transfer, `quantity` must be between `1` and `2147483647`. A correction takes a signed `quantityDelta` between `-2147483648` and `2147483647`, excluding zero.
- **`reason`** is a required nonblank string for corrections. For other calls it may be a string, omitted, or `null`.
- **`clientRequestKey`** is an optional nonblank string on all four calls. Generate it once when the user confirms a new submission. If the response times out, resend the saved payload with the same key. A second intentional submission gets a fresh key, even if the quantity is identical. Omitting the key or sending `null` makes each call independent.

For example, a Receive form can handle retries like this.

  1. You enter 5 and click Receive. The form creates key A, saves the request, and sends it. While it’s sending, the button is disabled so a double-click counts once.
  2. If it succeeds, the screen shows “Received 5 bags” and clears the form. When another 5 bags arrive, you enter 5 again and click Receive again. Submitting that fresh form is the exact event that creates key B.
  3. If the first request times out (e.g. no response received), the form stays open and shows Retry. Clicking Retry resends the request already saved with key A.


## Receive stock

Adds `quantity` at the specified location. A first receipt creates the inventory row with a starting balance of zero. In this example the location already has 12 bags.

**Frontend input**

```json
{ "productId": 7, "locationId": 2, "quantity": 5, "clientRequestKey": "delivery-42" }
```

**HTTP 200 response**

```json
{
  "operationId": "101", "movementId": "201", "productId": "7", "locationId": "2",
  "quantityReceived": 5, "quantityAfter": 17
}
```

## Issue stock

Removes `quantity` from the location. Send a positive number. Issuing 4 from 17 leaves 13. If the location holds fewer than 4, the endpoint returns `409 insufficient_stock`.

**Frontend input**

```json
{ "productId": 7, "locationId": 2, "quantity": 4, "reason": "Handed out at pickup" }
```

**HTTP 200 response**

```json
{
  "operationId": "102", "movementId": "202", "productId": "7", "locationId": "2",
  "quantityIssued": 4, "quantityAfter": 13
}
```

## Correct stock

Applies a manager's signed adjustment. If the recorded balance is 13 and the physical count is 11, send `quantityDelta: -2` and explain the difference. A positive delta adds units. A staff caller receives `403 forbidden`.

**Frontend input**

```json
{ "productId": 7, "locationId": 2, "quantityDelta": -2, "reason": "Two damaged bags removed" }
```

**HTTP 200 response**

```json
{
  "operationId": "103", "movementId": "203", "productId": "7", "locationId": "2",
  "quantityDelta": -2, "quantityAfter": 11
}
```

## Transfer stock

Moves one product between two distinct locations. Here the source has 11 bags and the destination has 2. Moving 3 leaves 8 and 5. An untracked destination starts at zero. The two movements have separate IDs and share one `operationId`. Both balances and both movements commit together.

**Frontend input**

```json
{ "productId": 7, "sourceLocationId": 2, "destinationLocationId": 9, "quantity": 3 }
```

**HTTP 200 response**

```json
{
  "operationId": "104", "productId": "7", "sourceLocationId": "2", "destinationLocationId": "9",
  "quantityTransferred": 3, "sourceMovementId": "204", "sourceQuantityAfter": 8,
  "destinationMovementId": "205", "destinationQuantityAfter": 5
}
```

## Errors and retries

Each function returns a Promise. On success, `operationId` identifies the whole request in stock history. Each movement ID identifies a change at one location. The returned balances are the quantities immediately after that operation. 

A matching retry by the same authorized user returns the original saved result, even if later operations changed the balance or a location was archived. Request keys are shared across all four actions for that user. For example:
You signed in. The storeroom has 12 bags, and you click Receive 5. The browser sends request key A.
1. The receipt succeeds. The database now has 17 bags and saves the result for your request A: “Received 5, balance after receipt 17.” Your browser times out before it sees the response.
2. A coworker issues 4 bags. The current balance is now 13.
3. Your browser retries Receive 5 with key A. The backend recognizes the same user, key, and request details. It returns the saved result: “Received 5, balance after receipt 17.” The current balance stays 13.


The service raises a `StockError` for an expected failure. The route maps it to an HTTP status and JSON error. For example, attempting to issue 5 units when only 2 remain returns HTTP `409`. [Shared service implementation](src/stock/stock-operation.js)

```json
{
  "error": {
    "code": "insufficient_stock",
    "message": "There is not enough stock at this location to issue the requested quantity.",
    "details": { "available": 2 }
  }
}
```

When `error.code` is `insufficient_stock`, display `error.details.available` as the number of units on hand when PostgreSQL checked the locked inventory row. This number can be `0`. It refers to the requested location for an issue or negative correction and the source location for a transfer. Later stock operations can change the balance.

| HTTP status and code | When it applies |
| --- | --- |
| `400 validation_failed` | Invalid fields, identical transfer locations, or a missing correction reason. |
| `401 unauthenticated` | The session is missing or expired, or its user is missing or disabled. |
| `403 forbidden` | A correction requires a manager. |
| `404 not_found` | A specified product or location does not exist. |
| `409 product_archived`, `409 location_archived` | The product or a location has been archived. |
| `409 insufficient_stock` | An issue, transfer, or negative correction would take stock below zero. |
| `409 quantity_overflow` | The resulting balance would exceed `2147483647`. |
| `409 request_key_conflict` | This user already used the key with another action or different request details. |
| `500 internal_error` | The service could not complete the request or read the original saved result. |
