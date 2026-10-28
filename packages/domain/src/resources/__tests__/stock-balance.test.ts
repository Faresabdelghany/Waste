import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { belowMinimum, stockBalances } from "../stock-balance"

describe("a warehouse's stock balance (O30 of #290, row 9.8)", () => {
  test("is below its minimum when fewer than the minimum stand in stock; maintenance is not stock, and no minimum is never below", () => {
    assert.equal(belowMinimum(2, 3), true)
    assert.equal(belowMinimum(3, 3), false, "at the minimum is not below it")
    assert.equal(belowMinimum(0, null), false)
  })

  test("joins the counts and the minimums per warehouse and type: a minimum with no stock reads zero, stock with no minimum reads none, ordered by warehouse then type", () => {
    const balances = stockBalances(
      [
        { projectId: "p1", warehouseId: "wh-b", containerTypeId: "bin-240", inWarehouse: 4, inMaintenance: 1 },
        { projectId: "p1", warehouseId: "wh-a", containerTypeId: "bin-660", inWarehouse: 1, inMaintenance: 0 },
      ],
      [
        { projectId: "p1", warehouseId: "wh-a", containerTypeId: "bin-660", minimum: 2 },
        { projectId: "p1", warehouseId: "wh-a", containerTypeId: "bin-240", minimum: 5 },
      ],
    )
    assert.deepEqual(balances, [
      { projectId: "p1", warehouseId: "wh-a", containerTypeId: "bin-240", inWarehouse: 0, inMaintenance: 0, minimum: 5, belowMinimum: true },
      { projectId: "p1", warehouseId: "wh-a", containerTypeId: "bin-660", inWarehouse: 1, inMaintenance: 0, minimum: 2, belowMinimum: true },
      { projectId: "p1", warehouseId: "wh-b", containerTypeId: "bin-240", inWarehouse: 4, inMaintenance: 1, minimum: null, belowMinimum: false },
    ])
  })
})
