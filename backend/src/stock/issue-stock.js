import { applyStockChange } from './stock-operation.js';

export { StockError } from './stock-operation.js';

/** Issue a positive quantity, rejecting requests that exceed available stock. */
export async function issueStock(pool, input) {
  return applyStockChange(pool, input, 'issue');
}
