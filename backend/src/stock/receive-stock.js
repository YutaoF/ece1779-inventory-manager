import { applyStockChange } from './stock-operation.js';

export { StockError } from './stock-operation.js';

/** Receive a positive quantity and return its recorded result. */
export async function receiveStock(pool, input) {
  return applyStockChange(pool, input, 'receive');
}
