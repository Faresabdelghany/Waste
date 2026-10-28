// A warehouse's stock balance (O30 of #290, row 9.8): how many containers of
// each type stand in a warehouse — in stock, and in maintenance there — read
// off the ledger's projection, beside the Stock Minimum the office set for
// the type. Below the minimum is fewer in stock than it: a container in
// maintenance is not one the office can issue, so it does not count towards
// it, and a type with no minimum is never below one. Nothing follows from it
// but the reading: no alert, no order.
//
// Pure: the API counts the containers and reads the minimums, and this joins
// the two, so a type with a minimum and nothing in stock still reads, as zero.

/** A warehouse's containers of one type, by where they stand in it. */
export type StockCount = { projectId: string; warehouseId: string; containerTypeId: string; inWarehouse: number; inMaintenance: number }

/** The office's minimum for a warehouse and a type. */
export type StockMinimumOf = { projectId: string; warehouseId: string; containerTypeId: string; minimum: number }

/** A warehouse's balance of one type: the counts, the minimum or null, and whether the stock is below it. */
export type StockBalance = StockCount & { minimum: number | null; belowMinimum: boolean }

/** The most minimums one warehouse holds: one per container type, bounded so a set replaced whole stays a small body. */
export const STOCK_MINIMUMS_MAX = 200

/** Whether the containers in stock are fewer than the minimum; no minimum is never below. */
export const belowMinimum = (inWarehouse: number, minimum: number | null): boolean => minimum !== null && inWarehouse < minimum

const keyOf = (row: { warehouseId: string; containerTypeId: string }): string => `${row.warehouseId}|${row.containerTypeId}`

/** The balances of every warehouse and type that has stock or a minimum, ordered by warehouse, then type. */
export function stockBalances(counts: readonly StockCount[], minimums: readonly StockMinimumOf[]): StockBalance[] {
  const byKey = new Map<string, StockBalance>()
  for (const count of counts) byKey.set(keyOf(count), { ...count, minimum: null, belowMinimum: false })
  for (const { projectId, warehouseId, containerTypeId, minimum } of minimums) {
    const row = byKey.get(keyOf({ warehouseId, containerTypeId })) ?? { projectId, warehouseId, containerTypeId, inWarehouse: 0, inMaintenance: 0, minimum: null, belowMinimum: false }
    byKey.set(keyOf(row), { ...row, minimum, belowMinimum: belowMinimum(row.inWarehouse, minimum) })
  }
  return [...byKey.values()].sort((a, b) => a.warehouseId.localeCompare(b.warehouseId) || a.containerTypeId.localeCompare(b.containerTypeId))
}
