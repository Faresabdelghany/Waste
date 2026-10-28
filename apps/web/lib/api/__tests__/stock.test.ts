// A warehouse's stock on the adapter (O30 of #290, row 9.8): the minimums'
// editor drafts as the contracts' StockMinimumsSet, refused here before the
// API where the wire would refuse them, sent as the warehouse's action over a
// scripted `fetch`; and a balance as its line reads.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { StockMinimumsSet } from "@waste/contracts/stock"

import { FIXTURE_COMPANY_ID, type BusinessRecord } from "../../data/business-modules"
import { NOTHING_RESOLVED, type MappingContext } from "../records/adapter"
import { warehouseAdapter, warehousesModule } from "../records/places"
import { actOnRecord, loaded, resolverOver, type ServerRecordsState } from "../records/server-records"
import { SET_STOCK_MINIMUMS, stockLine, stockMinimumsBody } from "../records/stock"
import { bodyOf, clientOver, json, scripted } from "./scripted-fetch"

const NOW = new Date("2026-10-01T10:00:00Z")
const WAREHOUSE_ID = "01a0d2a4-a280-7090-8000-000000000001"
const BIN_ID = "01a0d2a4-a280-700c-8000-000000000001"
const STAMPS = { createdAt: "2026-10-01T08:00:00.000Z", updatedAt: "2026-10-01T08:00:00.000Z" }

const bin: BusinessRecord = { id: `container-type-${BIN_ID}`, name: "240 L bin", status: "Active", recordKind: "Container type", facts: {}, submittedValues: {} } as BusinessRecord
const record = warehouseAdapter.toRecord(
  { id: WAREHOUSE_ID, ...STAMPS, projectId: "01a0d2a4-a280-7002-8000-000000000001", code: "WH-WEST", name: "Warehouse West", address: "Sundkrogsgade 1", location: null, depotId: null, status: "active", notes: null },
  { fixtures: [], resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW },
)
const state: ServerRecordsState = new Map([
  ["configure.master", loaded({ records: [bin], serverIds: new Map([[bin.id, BIN_ID]]) }, 1)],
  ["resources.warehouses", loaded({ records: [record], serverIds: new Map([[record.id, WAREHOUSE_ID]]) }, 1)],
])
const context: MappingContext = { fixtures: [], resolve: resolverOver(state), companyRecordId: FIXTURE_COMPANY_ID, now: NOW }

describe("a warehouse's stock minimums (O30 of #290, row 9.8)", () => {
  test("are the drafts with a count, each type by its server id: a blank is no minimum and is left out", () => {
    const body = stockMinimumsBody({ minimums: [{ containerTypeId: bin.id, minimum: " 12 " }, { containerTypeId: "container-type-other", minimum: "" }] }, record, context)
    assert.deepEqual(body, { minimums: [{ containerTypeId: BIN_ID, minimum: 12 }] })
    assert.ok(StockMinimumsSet.safeParse(body).success)
    assert.deepEqual(stockMinimumsBody({ minimums: [] }, record, context), { minimums: [] }, "nothing typed clears them")
  })

  test("are refused here where the API would refuse them: a zero, a fraction of one, a type the API does not hold", () => {
    assert.deepEqual(stockMinimumsBody({ minimums: [{ containerTypeId: bin.id, minimum: "0" }] }, record, context), { path: "minimums", message: "A minimum is a whole number of at least one; leave it blank for none" })
    assert.deepEqual(stockMinimumsBody({ minimums: [{ containerTypeId: bin.id, minimum: "2.5" }] }, record, context), { path: "minimums", message: "A minimum is a whole number of at least one; leave it blank for none" })
    assert.deepEqual(stockMinimumsBody({ minimums: [{ containerTypeId: "container-type-nobody", minimum: "3" }] }, record, context), { path: "minimums", message: "Pick a container type the API holds" })
  })

  test("go out as the warehouse's action, PUT whole, and the row stays as it is", async () => {
    const answer = { warehouseId: WAREHOUSE_ID, minimums: [{ containerTypeId: BIN_ID, minimum: 12 }] }
    const { fetch, calls } = scripted([() => json(answer)])
    const current = state.get("resources.warehouses")
    assert.ok(current !== undefined)
    const outcome = await actOnRecord(clientOver(fetch), warehousesModule, current, record, SET_STOCK_MINIMUMS, { minimums: [{ containerTypeId: bin.id, minimum: "12" }] }, { fixtures: [], state, now: NOW })
    assert.equal(outcome.kind, "done")
    assert.deepEqual(calls.map((call) => `${call.init.method} ${call.url.replace("http://api.test", "")}`), [`PUT /warehouses/${WAREHOUSE_ID}/stock-minimums`])
    assert.deepEqual(bodyOf(calls[0]), { minimums: [{ containerTypeId: BIN_ID, minimum: 12 }] })
  })

  test("a balance reads its counts and its minimum; maintenance only where something is in it", () => {
    assert.equal(stockLine({ inWarehouse: 12, inMaintenance: 2, minimum: 15 }), "12 in stock · 2 in maintenance · minimum 15")
    assert.equal(stockLine({ inWarehouse: 4, inMaintenance: 0, minimum: null }), "4 in stock")
  })
})
