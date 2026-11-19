# Stock Operations API Guide

| Call | Who can use it | Required frontend fields |
| --- | --- | --- |
| [`receiveStock(pool, input)`](src/stock/receive-stock.js) | Staff or manager | `productId`, `locationId`, `quantity` |
| [`issueStock(pool, input)`](src/stock/issue-stock.js) | Staff or manager | `productId`, `locationId`, `quantity` |
| [`correctStock(pool, input)`](src/stock/correct-stock.js) | Manager | `productId`, `locationId`, `quantityDelta`, `reason` |
| [`transferStock(pool, input)`](src/stock/transfer-stock.js) | Staff or manager | `productId`, `sourceLocationId`, `destinationLocationId`, `quantity` |

## What the frontend sends

- **IDs** are positive decimal strings, such as `"12"`.
- **Quantities** are JSON numbers in whole units. For receive, issue, and transfer, `quantity` must be between `1` and `2147483647`. A correction takes a signed `quantityDelta` between `-2147483648` and `2147483647`, excluding zero.
- **`reason`** is a required nonblank string for corrections. For other calls it may be a string, omitted, or `null`.
- **`clientRequestKey`** is an optional nonblank string on all four calls. BUT TO PREVENT duplicate submissions due to unexpected time-out issues like dropout of responses, generate it once when the user confirms a new submission. If the response times out, resend the saved payload with the same key. A second intentional submission gets a fresh key, even if the quantity is identical. Omitting the key or sending `null` makes each call independent.
-- **Side notes for frontend：** a possible solution for the scenario "retrying a request after the stock change has committed but the response has been lost"
  1. You enter 5 and click Receive. The form creates key A, saves the request, and sends it. While it’s sending, the button is disabled so a double-click counts once.
  2. If it succeeds, the screen shows “Received 5 bags” and clears the form. When another 5 bags arrive, you enter 5 again and click Receive again. Submitting that fresh form is the exact event that creates key B.
  3. If the first request times out (e.g. no response received), the form stays open and shows Retry. Clicking Retry resends the request already saved with key A.


## Receive stock

Adds `quantity` at the specified location. A first receipt creates the inventory row with a starting balance of zero. In this example the location already has 12 bags.

**Frontend input**

```json
{ "productId": "7", "locationId": "2", "quantity": 5, "clientRequestKey": "delivery-42" }
```

**Service result**

```json
{
  "operationId": "101", "movementId": "201", "productId": "7", "locationId": "2",
  "quantityReceived": 5, "quantityAfter": 17
}
```

## Issue stock

Removes `quantity` from the location. Send a positive number. Issuing 4 from 17 leaves 13. If the location holds fewer than 4, the call fails with `INSUFFICIENT_STOCK`.

**Frontend input**

```json
{ "productId": "7", "locationId": "2", "quantity": 4, "reason": "Handed out at pickup" }
```

**Service result**

```json
{
  "operationId": "102", "movementId": "202", "productId": "7", "locationId": "2",
  "quantityIssued": 4, "quantityAfter": 13
}
```

## Correct stock

Applies a manager's signed adjustment. If the recorded balance is 13 and the physical count is 11, send `quantityDelta: -2` and explain the difference. A positive delta adds units. A staff caller receives `FORBIDDEN`.

**Frontend input**

```json
{ "productId": "7", "locationId": "2", "quantityDelta": -2, "reason": "Two damaged bags removed" }
```

**Service result**

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
{ "productId": "7", "sourceLocationId": "2", "destinationLocationId": "9", "quantity": 3 }
```

**Service result**

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


On failure the service throws. [Shared service implementation](src/stock/stock-operation.js)

| Service error code | What it means |
| --- | --- |
| `INVALID_INPUT` | A field is missing or invalid, the transfer locations are the same, or a correction has a blank reason. |
| `ACTOR_NOT_FOUND`, `ACTOR_DISABLED` | The session user is missing or disabled. |
| `FORBIDDEN` | A correction requires a manager. |
| `PRODUCT_NOT_FOUND`, `PRODUCT_ARCHIVED` | A new operation requires an existing, active product. |
| `LOCATION_NOT_FOUND`, `LOCATION_ARCHIVED` | Each location on a new operation must exist and be active. |
| `INSUFFICIENT_STOCK` | An issue, transfer, or negative correction would take stock below zero. |
| `QUANTITY_OVERFLOW` | The resulting balance would exceed `2147483647`. |
| `REQUEST_KEY_CONFLICT` | This user already used the key with another action or different request details. |
| `OPERATION_INCOMPLETE` | A matching operation exists but has no saved result. |
