import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { ASSET_STATUS_OF_PLACE, assetStateOf, MOVEMENT_SHAPES, movementShape } from "../asset-state"
import { ADJUSTMENT_TARGETS, ASSET_STATUSES, STOCK_MOVEMENT_KINDS, STOCK_PLACE_KINDS, STOCK_PLACES, type StockMovementKind, type StockPlaceKind } from "../vocabulary"

/** Every (kind, from, to) triple the vocabulary can spell. */
const everyTriple = STOCK_MOVEMENT_KINDS.flatMap((kind) => STOCK_PLACE_KINDS.flatMap((from) => STOCK_PLACE_KINDS.map((to) => [kind, from, to] as const)))

/** The pairs a kind allows, spelled out, so the table is pinned in words and not only in itself. */
const allowed: Record<StockMovementKind, [StockPlaceKind, StockPlaceKind][]> = {
  receipt: [["supplier", "warehouse"]],
  issue: [
    ["warehouse", "service"],
    ["maintenance", "service"],
  ],
  return: [
    ["service", "warehouse"],
    ["service", "maintenance"],
  ],
  transfer: [
    ["warehouse", "warehouse"],
    ["warehouse", "maintenance"],
    ["maintenance", "warehouse"],
    ["maintenance", "maintenance"],
  ],
  decommission: [
    ["warehouse", "scrap"],
    ["maintenance", "scrap"],
    ["service", "scrap"],
  ],
  adjustment: [
    ["supplier", "warehouse"],
    ["supplier", "maintenance"],
    ["supplier", "scrap"],
    ["warehouse", "warehouse"],
    ["warehouse", "maintenance"],
    ["warehouse", "scrap"],
    ["maintenance", "warehouse"],
    ["maintenance", "maintenance"],
    ["maintenance", "scrap"],
    ["scrap", "warehouse"],
    ["scrap", "maintenance"],
    ["scrap", "scrap"],
  ],
}

describe("assetStateOf", () => {
  test("folds where a movement arrived onto the glossary's four states, and a supplier onto none", () => {
    assert.deepEqual(ASSET_STATUS_OF_PLACE, { warehouse: "in-warehouse", maintenance: "in-maintenance", service: "in-service", scrap: "retired" })
    assert.equal(assetStateOf({ toKind: "warehouse" }), "in-warehouse")
    assert.equal(assetStateOf({ toKind: "maintenance" }), "in-maintenance")
    assert.equal(assetStateOf({ toKind: "service" }), "in-service")
    assert.equal(assetStateOf({ toKind: "scrap" }), "retired")
    assert.equal(assetStateOf({ toKind: "supplier" }), null)
  })

  test("every state is reached by some place, and every place but the supplier reaches one", () => {
    const reached = new Set(STOCK_PLACE_KINDS.map((toKind) => assetStateOf({ toKind })))
    assert.deepEqual([...reached].filter((state) => state !== null).sort(), [...ASSET_STATUSES].sort())
    assert.deepEqual(
      STOCK_PLACE_KINDS.filter((toKind) => assetStateOf({ toKind }) === null),
      ["supplier"],
    )
  })
})

describe("movementShape", () => {
  test("allows exactly the pairs the glossary gives each kind, over every triple the vocabulary can spell", () => {
    for (const [kind, from, to] of everyTriple) {
      const expected = allowed[kind].some(([f, t]) => f === from && t === to)
      assert.equal(movementShape(kind, from, to), expected, `${kind}: ${from} → ${to}`)
    }
    assert.equal(everyTriple.length, 150, "six kinds over five places twice")
  })

  test("the table as data says the same as the function, kind by kind", () => {
    for (const kind of STOCK_MOVEMENT_KINDS) {
      const pairs = MOVEMENT_SHAPES[kind].from.flatMap((from) => MOVEMENT_SHAPES[kind].to.map((to) => [from, to]))
      assert.deepEqual(pairs, allowed[kind], kind)
    }
  })

  test("nothing but an issue arrives in service, and nothing but a return or a decommission leaves it; a supplier is never arrived at", () => {
    for (const [kind, from, to] of everyTriple) {
      if (!movementShape(kind, from, to)) continue
      if (to === "service") assert.equal(kind, "issue", `${kind} into service`)
      if (from === "service") assert.ok(kind === "return" || kind === "decommission", `${kind} out of service`)
      assert.notEqual(to, "supplier", `${kind} to a supplier`)
    }
    assert.deepEqual([...STOCK_PLACES], ["warehouse", "maintenance"])
    assert.deepEqual([...ADJUSTMENT_TARGETS], ["warehouse", "maintenance", "scrap"])
  })
})
