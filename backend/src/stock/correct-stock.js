import { applyStockChange } from './stock-operation.js';

export { StockError } from './stock-operation.js';

/** Apply a manager's signed adjustment and record the reason in stock history. */
export async function correctStock(pool, input) {
  return applyStockChange(pool, input, 'correction');
}
