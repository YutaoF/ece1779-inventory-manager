const MAX_QUANTITY = 2147483647;
const MAX_ID = 9223372036854775807n;
const resultQuantityFields = {
  receive: 'quantityReceived',
  issue: 'quantityIssued',
  correction: 'quantityDelta',
  transfer: 'quantityTransferred',
};

export class StockError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StockError';
    this.code = code;
  }
}

function normalizeId(value, field) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }

  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const id = BigInt(value);
    if (id > 0n && id <= MAX_ID) {
      return id.toString();
    }
  }

  throw new StockError('INVALID_INPUT', `${field} must be a positive bigint ID string or safe integer.`);
}

function normalizeRequest(input, operationType) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    const article = operationType === 'issue' ? 'An' : 'A';
    throw new StockError('INVALID_INPUT', `${article} ${operationType} request is required.`);
  }

  const actorId = normalizeId(input.actorId, 'actorId');
  const productId = normalizeId(input.productId, 'productId');
  let locations;
  if (operationType === 'transfer') {
    const sourceLocationId = normalizeId(input.sourceLocationId, 'sourceLocationId');
    const destinationLocationId = normalizeId(input.destinationLocationId, 'destinationLocationId');
    if (sourceLocationId === destinationLocationId) {
      throw new StockError('INVALID_INPUT', 'Source and destination must be different locations.');
    }
    locations = { sourceLocationId, destinationLocationId };
  } else {
    locations = { locationId: normalizeId(input.locationId, 'locationId') };
  }
  const isCorrection = operationType === 'correction';
  const inputField = isCorrection ? 'quantityDelta' : 'quantity';
  const quantity = input[inputField];
  if (isCorrection) {
    if (!Number.isInteger(quantity) || quantity === 0 || quantity < -2147483648 || quantity > MAX_QUANTITY) {
      throw new StockError('INVALID_INPUT', 'quantityDelta must be a nonzero signed 32-bit integer.');
    }
  } else if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_QUANTITY) {
    throw new StockError('INVALID_INPUT', `quantity must be a whole number from 1 to ${MAX_QUANTITY}.`);
  }

  const reason = input.reason ?? null;
  if (reason !== null && typeof reason !== 'string') {
    throw new StockError('INVALID_INPUT', 'reason must be a string or null.');
  }
  if (isCorrection && (reason === null || reason.trim() === '')) {
    throw new StockError('INVALID_INPUT', 'A stock correction requires a nonblank reason.');
  }

  const clientRequestKey = input.clientRequestKey ?? null;
  if (clientRequestKey !== null
      && (typeof clientRequestKey !== 'string' || clientRequestKey.trim() === '')) {
    throw new StockError('INVALID_INPUT', 'clientRequestKey must be a nonblank string or null.');
  }

  const requestDetails = { productId, ...locations, [inputField]: quantity, reason };
  return { actorId, quantity, requestDetails, clientRequestKey };
}

async function lockInventory(client, productId, locationIds) {
  const locations = await client.query(
    `SELECT id, archived_at FROM public.locations
     WHERE id = ANY($1::bigint[]) ORDER BY id FOR SHARE`,
    [locationIds],
  );
  if (locations.rowCount !== locationIds.length) {
    throw new StockError('LOCATION_NOT_FOUND', 'The location does not exist.');
  }
  if (locations.rows.some((location) => location.archived_at !== null)) {
    throw new StockError('LOCATION_ARCHIVED', 'The location is archived.');
  }

  const inventory = new Map();
  // Create and lock balances in numeric location order, even on a reverse transfer.
  for (const { id } of locations.rows) {
    await client.query(
      `INSERT INTO public.inventory (product_id, location_id)
       VALUES ($1, $2) ON CONFLICT (product_id, location_id) DO NOTHING`,
      [productId, id],
    );
    const balance = await client.query(
      `SELECT product_id, location_id, quantity FROM public.inventory
       WHERE product_id = $1 AND location_id = $2 FOR UPDATE`,
      [productId, id],
    );
    inventory.set(id, balance.rows[0]);
  }
  return inventory;
}

async function recordMovement(client, operationId, operationType, balance, quantityDelta) {
  const quantityAfter = balance.quantity + quantityDelta;
  if (quantityAfter < 0) {
    const messages = {
      issue: 'There is not enough stock at this location to issue the requested quantity.',
      correction: 'The correction would take stock at this location below zero.',
      transfer: 'There is not enough stock at the source location to transfer the requested quantity.',
    };
    throw new StockError('INSUFFICIENT_STOCK', messages[operationType]);
  }
  if (quantityAfter > MAX_QUANTITY) {
    throw new StockError('QUANTITY_OVERFLOW', 'The resulting balance exceeds the supported quantity limit.');
  }

  await client.query(
    `UPDATE public.inventory SET quantity = $3
     WHERE product_id = $1 AND location_id = $2`,
    [balance.product_id, balance.location_id, quantityAfter],
  );
  const movement = await client.query(
    `INSERT INTO public.stock_movements
       (operation_id, product_id, location_id, quantity_delta, quantity_after)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [operationId, balance.product_id, balance.location_id, quantityDelta, quantityAfter],
  );
  return { movementId: movement.rows[0].id, quantityAfter };
}

/**
 * Shared transaction for stock operations.
 * actorId must come from the authenticated caller.
 * IDs in the result are strings so PostgreSQL bigint values keep their precision.
 */
export async function applyStockChange(pool, input, operationType) {
  if (!Object.hasOwn(resultQuantityFields, operationType)) {
    throw new TypeError('Unsupported stock operation.');
  }
  const { actorId, quantity, requestDetails, clientRequestKey } = normalizeRequest(input, operationType);
  const { productId, locationId, sourceLocationId, destinationLocationId, reason } = requestDetails;
  const client = await pool.connect();
  let destroyClient = false;

  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');

    // Hold status rows stable until commit so deactivation cannot race the request.
    const actor = await client.query(
      'SELECT role, disabled_at FROM public.users WHERE id = $1 FOR SHARE',
      [actorId],
    );
    if (actor.rowCount === 0) {
      throw new StockError('ACTOR_NOT_FOUND', 'The acting user does not exist.');
    }
    if (actor.rows[0].disabled_at !== null) {
      throw new StockError('ACTOR_DISABLED', 'The acting user is disabled.');
    }
    if (operationType === 'correction' && actor.rows[0].role !== 'manager') {
      throw new StockError('FORBIDDEN', 'Only managers can correct stock.');
    }

    // A concurrent request with this key waits for the first transaction here.
    const operation = await client.query(
      `INSERT INTO public.stock_operations
         (actor_id, operation, reason, client_request_key, request_details)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (actor_id, client_request_key) DO NOTHING
       RETURNING id`,
      [actorId, operationType, reason, clientRequestKey, requestDetails],
    );

    if (operation.rowCount === 0) {
      // A separate READ COMMITTED statement sees the concurrent winner's commit.
      const existing = await client.query(
        `SELECT operation, saved_result,
                request_details = $3::jsonb AND reason IS NOT DISTINCT FROM $4 AS matches
         FROM public.stock_operations
         WHERE actor_id = $1 AND client_request_key = $2`,
        [actorId, clientRequestKey, requestDetails, reason],
      );
      const original = existing.rows[0];
      if (!original || original.operation !== operationType || original.matches !== true) {
        throw new StockError('REQUEST_KEY_CONFLICT', 'This request key was used for a different stock request.');
      }
      if (original.saved_result === null) {
        throw new StockError('OPERATION_INCOMPLETE', 'The existing operation has no saved result.');
      }

      await client.query('COMMIT');
      return original.saved_result;
    }

    const product = await client.query(
      'SELECT archived_at FROM public.products WHERE id = $1 FOR SHARE',
      [productId],
    );
    if (product.rowCount === 0) {
      throw new StockError('PRODUCT_NOT_FOUND', 'The product does not exist.');
    }
    if (product.rows[0].archived_at !== null) {
      throw new StockError('PRODUCT_ARCHIVED', 'The product is archived.');
    }

    const operationId = operation.rows[0].id;
    let result;
    if (operationType === 'transfer') {
      const inventory = await lockInventory(client, productId, [sourceLocationId, destinationLocationId]);
      const source = await recordMovement(client, operationId, operationType, inventory.get(sourceLocationId), -quantity);
      const destination = await recordMovement(client, operationId, operationType, inventory.get(destinationLocationId), quantity);
      result = {
        operationId, productId, sourceLocationId, destinationLocationId, quantityTransferred: quantity,
        sourceMovementId: source.movementId, sourceQuantityAfter: source.quantityAfter,
        destinationMovementId: destination.movementId, destinationQuantityAfter: destination.quantityAfter,
      };
    } else {
      const inventory = await lockInventory(client, productId, [locationId]);
      const quantityDelta = operationType === 'issue' ? -quantity : quantity;
      const movement = await recordMovement(client, operationId, operationType, inventory.get(locationId), quantityDelta);
      result = { operationId, productId, locationId, [resultQuantityFields[operationType]]: quantity, ...movement };
    }

    await client.query(
      'UPDATE public.stock_operations SET saved_result = $2 WHERE id = $1',
      [operationId, result],
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // A connection that could not roll back must be removed from the pool.
      destroyClient = true;
    }
    throw error;
  } finally {
    client.release(destroyClient);
  }
}
