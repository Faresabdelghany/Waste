import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { ADJUSTMENT_TARGETS, STOCK_PLACES } from "@waste/domain/resources/vocabulary"

import { Adjust, AdjustmentTarget, AssetState, Decommission, OCCURRED_WINDOW_ORDERED, Receive, Return, StockMovement, StockMovementListQuery, StockPlace, Transfer, WAREHOUSE_WITH_A_STOCK_PLACE } from "../stock"
import { refusal } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const WHEN = "2026-09-24T13:41:00.000Z"
const LATER = "2026-09-25T06:00:00+02:00"

const movement = {
  id: ID,
  recordedAt: WHEN,
  projectId: OTHER,
  containerId: THIRD,
  kind: "issue",
  fromKind: "warehouse",
  fromWarehouseId: OTHER,
  toKind: "service",
  toWarehouseId: null,
  placementId: THIRD,
  occurredAt: WHEN,
  recordedBy: ID,
  reason: null,
  reference: "DN-2048",
  correctsMovementId: null,
}

/** Every command body refuses what the route or the ledger owns. */
const owned = ["containerId", "projectId", "kind", "fromKind", "fromWarehouseId", "id", "recordedAt", "recordedBy"]

describe("the two place lists", () => {
  test("are the vocabulary's values, so a command may ask for exactly the places the ledger's shape allows", () => {
    assert.deepEqual(StockPlace.options, [...STOCK_PLACES])
    assert.deepEqual(AdjustmentTarget.options, [...ADJUSTMENT_TARGETS])
    assert.equal(StockPlace.safeParse("service").success, false, "only an issue arrives in service")
    assert.equal(AdjustmentTarget.safeParse("service").success, false, "an adjustment never touches a placement")
  })
})

describe("AssetState and StockMovement", () => {
  test("the state is where the latest movement left the container, and which movement that was", () => {
    const inStock = { status: "in-warehouse", warehouseId: OTHER, placementId: null, since: WHEN, movementId: ID }
    assert.deepEqual(AssetState.parse(inStock), inStock)
    const retired = { status: "retired", warehouseId: null, placementId: null, since: WHEN, movementId: ID }
    assert.deepEqual(AssetState.parse(retired), retired)
    assert.equal(AssetState.safeParse({ ...inStock, status: "in-transit" }).success, false)
  })

  test("a movement is a ledger row: an id and the instant it was appended, never an updatedAt", () => {
    assert.deepEqual(StockMovement.parse(movement), movement)
    assert.equal(Object.keys(StockMovement.shape).includes("updatedAt"), false)
    assert.equal(Object.keys(StockMovement.shape).includes("createdAt"), false)
    const receipt = { ...movement, kind: "receipt", fromKind: "supplier", fromWarehouseId: null, toKind: "warehouse", toWarehouseId: OTHER, placementId: null, reason: "Delivered by Sulo" }
    assert.deepEqual(StockMovement.parse(receipt), receipt)
    assert.equal(StockMovement.safeParse({ ...movement, occurredAt: "2026-09-24" }).success, false, "an instant, not a day")
  })
})

describe("the command bodies", () => {
  test("receive names the warehouse, optionally when and a reference, and nothing the ledger owns", () => {
    assert.deepEqual(Receive.parse({ warehouseId: OTHER }), { warehouseId: OTHER })
    assert.deepEqual(Receive.parse({ warehouseId: OTHER, occurredAt: LATER, reference: "DN-2048" }), { warehouseId: OTHER, occurredAt: LATER, reference: "DN-2048" })
    assert.deepEqual(refusal(Receive.safeParse({})).map((issue) => issue.path), ["warehouseId"])
    for (const key of owned) assert.match(refusal(Receive.safeParse({ warehouseId: OTHER, [key]: THIRD }))[0].message, new RegExp(key), key)
  })

  test("return ends the placement on validTo and arrives in stock, in the warehouse unless maintenance is said", () => {
    assert.deepEqual(Return.parse({ warehouseId: OTHER, validTo: "2026-10-01" }), { warehouseId: OTHER, toKind: "warehouse", validTo: "2026-10-01" })
    assert.match(Return.shape.toKind.description ?? "", /maintenance/)
    assert.deepEqual(Return.parse({ warehouseId: OTHER, toKind: "maintenance", validTo: "2026-10-01", reason: "Lid broken" }).toKind, "maintenance")
    assert.deepEqual(refusal(Return.safeParse({ warehouseId: OTHER })).map((issue) => issue.path), ["validTo"])
    assert.equal(Return.safeParse({ warehouseId: OTHER, toKind: "scrap", validTo: "2026-10-01" }).success, false, "scrap is a decommission")
    for (const key of owned) assert.match(refusal(Return.safeParse({ warehouseId: OTHER, validTo: "2026-10-01", [key]: THIRD }))[0].message, new RegExp(key), key)
  })

  test("transfer arrives at a warehouse or in maintenance at one; decommission needs a reason and takes validTo for the route to judge", () => {
    assert.deepEqual(Transfer.parse({ warehouseId: OTHER }), { warehouseId: OTHER, toKind: "warehouse" })
    assert.equal(Transfer.safeParse({ warehouseId: OTHER, toKind: "service" }).success, false)
    assert.deepEqual(Decommission.parse({ reason: "Crushed" }), { reason: "Crushed" })
    assert.deepEqual(Decommission.parse({ reason: "Crushed", validTo: "2026-10-01" }), { reason: "Crushed", validTo: "2026-10-01" })
    assert.deepEqual(refusal(Decommission.safeParse({})).map((issue) => issue.path), ["reason"])
    assert.match(refusal(Decommission.safeParse({ reason: "Crushed", warehouseId: OTHER }))[0].message, /warehouseId/, "scrap has no warehouse")
    for (const key of owned) assert.match(refusal(Transfer.safeParse({ warehouseId: OTHER, [key]: THIRD }))[0].message, new RegExp(key), key)
  })

  test("adjust is the correction door: a reason, a target in stock or scrap, the warehouse exactly with a stock target, and never service", () => {
    const shelf = { toKind: "warehouse", warehouseId: OTHER, reason: "Booked to the wrong shelf", correctsMovementId: THIRD }
    assert.deepEqual(Adjust.parse(shelf), shelf)
    assert.deepEqual(Adjust.parse({ toKind: "scrap", reason: "Never came back from the workshop" }), { toKind: "scrap", reason: "Never came back from the workshop" })
    const warehouseIssue = { path: "warehouseId", message: WAREHOUSE_WITH_A_STOCK_PLACE }
    assert.deepEqual(refusal(Adjust.safeParse({ toKind: "scrap", warehouseId: OTHER, reason: "x" })), [warehouseIssue])
    assert.deepEqual(refusal(Adjust.safeParse({ toKind: "maintenance", reason: "x" })), [warehouseIssue])
    assert.equal(Adjust.safeParse({ toKind: "service", warehouseId: OTHER, reason: "x" }).success, false, "refused at the schema, before any route")
    assert.deepEqual(refusal(Adjust.safeParse({ toKind: "warehouse", warehouseId: OTHER })).map((issue) => issue.path), ["reason"])
    for (const key of owned) assert.match(refusal(Adjust.safeParse({ ...shelf, [key]: THIRD }))[0].message, new RegExp(key), key)
  })
})

describe("StockMovementListQuery", () => {
  test("pages by project, container, warehouse on either side, kind and a window over occurredAt, ordered", () => {
    assert.deepEqual(StockMovementListQuery.parse({}), { limit: 50 })
    assert.deepEqual(StockMovementListQuery.parse({ projectId: OTHER, containerId: THIRD, warehouseId: ID, kind: "transfer", from: WHEN, to: LATER }), {
      projectId: OTHER,
      containerId: THIRD,
      warehouseId: ID,
      kind: "transfer",
      from: WHEN,
      to: LATER,
      limit: 50,
    })
    assert.deepEqual(refusal(StockMovementListQuery.safeParse({ from: LATER, to: WHEN })), [{ path: "to", message: OCCURRED_WINDOW_ORDERED }])
    assert.equal(StockMovementListQuery.safeParse({ from: WHEN, to: WHEN }).success, true, "one instant is a window")
    assert.equal(StockMovementListQuery.safeParse({ kind: "borrow" }).success, false)
  })
})
