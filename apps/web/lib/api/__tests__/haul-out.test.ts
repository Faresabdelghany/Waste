// A transfer station's haul-out on the adapter (M17 of #293): a station is a
// transfer station by the form's switch and says so among its facts; its
// actions send the bodies the API's contracts accept — a count's adjustment,
// a load sent on with its weights, plate and costs, the receipt and the three
// reasons — held here against the contracts' own zod schemas; and the lines
// the details read the stock and the loads by.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { MaterialAdjustmentCreate, OutboundLoadCreate, OutboundLoadReason, OutboundLoadReceive, OutboundLoadReconcile, type OutboundLoad } from "@waste/contracts/haul-out"
import type { UnloadingStation } from "@waste/contracts/places"

import { FIXTURE_COMPANY_ID, type BusinessRecord } from "../../data/business-modules"
import { NOTHING_RESOLVED, type CommandInput, type MappingContext } from "../records/adapter"
import { ADJUST_STOCK, adjustStockBody, CANCEL_LOAD, GIVE_A_DELTA, HAUL_OUT_ACTIONS, loadLine, NAME_THE_CARRIER, RECEIVE_LOAD, RECONCILE_LOAD, SAY_WHY, SEND_LOAD, sendLoadBody, stockLine } from "../records/haul-out"
import { unloadingStationAdapter } from "../records/places"

const NOW = new Date("2026-10-29T09:00:00Z")
const STAMPS = { createdAt: "2026-10-20T09:00:00.000Z", updatedAt: "2026-10-21T09:30:00.000Z" }
const SERVER = { project: "01a0d2a4-a280-7002-8000-000000000001", fraction: "01a0d2a4-a280-7003-8000-000000000001", plant: "01a0d2a4-a280-7012-8000-000000000002", vehicle: "01a0d2a4-a280-7020-8000-000000000001" }
const WEB = { project: "project-copenhagen", fraction: "waste-fraction-residual", plant: "station-plant", vehicle: "vehicle-wh24" }
const ids = new Map<string, string>([
  [WEB.project, SERVER.project],
  [WEB.fraction, SERVER.fraction],
  [WEB.plant, SERVER.plant],
  [WEB.vehicle, SERVER.vehicle],
])
const context: MappingContext = { fixtures: [], resolve: { ...NOTHING_RESOLVED, serverIdOf: (webId) => ids.get(webId) }, companyRecordId: FIXTURE_COMPANY_ID, now: NOW }

const omlast: UnloadingStation = {
  id: "01a0d2a4-a280-7012-8000-000000000001",
  ...STAMPS,
  code: "KYST-OMLAST",
  name: "Kystbyen omlastestation",
  address: "Havnevej 2",
  location: { type: "Point", coordinates: [12.6, 55.7] },
  ownership: "company",
  serviceProviderId: null,
  opensAt: null,
  closesAt: null,
  weighbridge: true,
  transfer: true,
  status: "active",
  notes: null,
  wasteFractionIds: [],
}
const station = (): BusinessRecord => unloadingStationAdapter.toRecord(omlast, context)

const send = (input: CommandInput) => sendLoadBody(input, station(), context)
const load = { projectId: WEB.project, toStationId: WEB.plant, wasteFractionId: WEB.fraction, vehicleRegistration: "AB 12 345", departedAt: "2026-10-29T08:30", timezone: "Europe/Copenhagen", netKg: "18400", currency: "DKK" }

describe("a transfer station on the adapter", () => {
  test("says so among its facts and in its form, and writes the switch the form holds", () => {
    const record = station()
    assert.equal(record.facts["Transfer station"], "Yes")
    assert.equal(record.submittedValues?.transferStation, true)
    assert.equal(unloadingStationAdapter.toRecord({ ...omlast, transfer: false }, context).facts["Transfer station"], undefined)
    assert.ok(unloadingStationAdapter.actions?.[SEND_LOAD] !== undefined && unloadingStationAdapter.actions[ADJUST_STOCK] !== undefined)
  })
})

describe("the station's actions", () => {
  test("an adjustment is signed kilograms of a fraction for a project, never zero, with the count's words", () => {
    const body = adjustStockBody({ projectId: WEB.project, wasteFractionId: WEB.fraction, deltaKg: "-1500", note: "Counted after the haul" }, station(), context)
    assert.deepEqual(body, { projectId: SERVER.project, wasteFractionId: SERVER.fraction, deltaKg: -1500, note: "Counted after the haul" })
    assert.equal(MaterialAdjustmentCreate.safeParse(body).success, true)
    assert.deepEqual(adjustStockBody({ projectId: WEB.project, wasteFractionId: WEB.fraction, deltaKg: "0", note: "x" }, station(), context), { path: "deltaKg", message: GIVE_A_DELTA })
  })

  test("a load sent on goes out with its stations, plate, instant on the project's clock, weights and costs in minor units, the station it leaves the row's", async () => {
    const body = send({ ...load, grossKg: "32400", tareKg: "14000", haulCost: "1850", disposalCost: "9200.50", outboundTicket: "WB-4410" })
    assert.deepEqual(body, {
      projectId: SERVER.project,
      toStationId: SERVER.plant,
      wasteFractionId: SERVER.fraction,
      vehicleRegistration: "AB 12 345",
      departedAt: "2026-10-29T07:30:00.000Z",
      netKg: 18400,
      grossKg: 32400,
      tareKg: 14000,
      outboundTicket: "WB-4410",
      haulCostMinor: 185000,
      disposalCostMinor: 920050,
    })
    let posted: unknown
    const client = { fetch: async (_url: string, init?: RequestInit) => ((posted = JSON.parse(String(init?.body))), new Response(JSON.stringify({}), { status: 201 })) }
    await HAUL_OUT_ACTIONS[SEND_LOAD]!.run(client as never, omlast.id, body)
    assert.equal((posted as { fromStationId: string }).fromStationId, omlast.id)
    assert.equal(OutboundLoadCreate.safeParse(posted).success, true)
  })

  test("a load names our vehicle or a plate, and its gross and tare come together and add up", () => {
    const withoutPlate: CommandInput = { ...load, vehicleRegistration: "" }
    assert.deepEqual(send(withoutPlate), { path: "vehicleRegistration", message: NAME_THE_CARRIER })
    const ours = send({ ...withoutPlate, vehicleId: WEB.vehicle }) as Record<string, unknown>
    assert.equal(ours.vehicleId, SERVER.vehicle)
    assert.equal(ours.vehicleRegistration, undefined, "our vehicle's plate is the API's to read off it")
    assert.deepEqual(send({ ...load, grossKg: "32400" }), { path: "tareKg", message: "Give the gross and the tare together, or neither" })
    assert.deepEqual(send({ ...load, grossKg: "32400", tareKg: "10000" }), { path: "netKg", message: "The net is the gross less the tare" })
    assert.deepEqual(send({ ...load, toStationId: station().id }), { path: "toStationId", message: "Pick the station the load goes to" })
  })

  test("the receipt, the reconciliation and the two reasons send what the API takes, the load in the input", () => {
    const receive = HAUL_OUT_ACTIONS[RECEIVE_LOAD]!.toBody!({ loadId: "load-1", receivingTicket: "ARC-88123", receivedNetKg: "19200", receivedAt: "2026-10-29T10:45", timezone: "Europe/Copenhagen" }, station(), context) as { loadId: string; body: unknown }
    assert.deepEqual(receive, { loadId: "load-1", body: { receivingTicket: "ARC-88123", receivedNetKg: 19200, receivedAt: "2026-10-29T09:45:00.000Z" } })
    assert.equal(OutboundLoadReceive.safeParse(receive.body).success, true)
    const reconcile = HAUL_OUT_ACTIONS[RECONCILE_LOAD]!.toBody!({ loadId: "load-1", note: "" }, station(), context) as { body: unknown }
    assert.deepEqual(reconcile.body, {})
    assert.equal(OutboundLoadReconcile.safeParse(reconcile.body).success, true)
    assert.deepEqual(HAUL_OUT_ACTIONS[CANCEL_LOAD]!.toBody!({ loadId: "load-1", note: "" }, station(), context), { path: "note", message: SAY_WHY })
    const cancel = HAUL_OUT_ACTIONS[CANCEL_LOAD]!.toBody!({ loadId: "load-1", note: "Never left" }, station(), context) as { body: unknown }
    assert.equal(OutboundLoadReason.safeParse(cancel.body).success, true)
  })
})

describe("the lines", () => {
  test("a stock row reads what is on hand first, and the rejected weight beside where there is one", () => {
    assert.equal(stockLine({ inKg: 27_500, outKg: 20_000, adjustedKg: -1_500, onHandKg: 6_000, rejectedKg: 0 }), "6,000 kg on hand · in 27,500 kg · out 20,000 kg · adjusted -1,500 kg")
    assert.equal(stockLine({ inKg: 10_000, outKg: 0, adjustedKg: 0, onHandKg: 10_000, rejectedKg: 4_000 }), "10,000 kg on hand · in 10,000 kg · out 0 kg · 4,000 kg under a rejected weight")
  })

  test("a load reads its plate, its net, its status and the receiving site's ticket against ours", () => {
    const sent: Pick<OutboundLoad, "vehicleRegistration" | "netKg" | "status" | "receipt"> = { vehicleRegistration: "AB 12 345", netKg: 20_000, status: "departed", receipt: null }
    assert.equal(loadLine(sent), "AB 12 345 · 20,000 kg · departed")
    assert.equal(
      loadLine({ ...sent, status: "received", receipt: { ticket: "ARC-88123", netKg: 22_000, receivedAt: STAMPS.createdAt, differenceKg: 2_000, deviationPercent: 10, withinTolerance: false } }),
      "AB 12 345 · 20,000 kg · received · ARC-88123: 22,000 kg (+10%, beyond the tolerance)",
    )
  })
})
