import { applyStockChange } from './stock-operation.js';

export { StockError } from './stock-operation.js';

/** Move stock between two locations and record both movements in one transaction. */
export async function transferStock(pool, input) {
  return applyStockChange(pool, input, 'transfer');
}
