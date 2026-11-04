// A transfer station's haul-out on the wire (M17 of #293): a load from one
// station to another with its out-weighing, its receipt and its costs; the
// commands' bodies; a station's stock; and an adjustment.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { SAME_STATION } from "@waste/domain/execution/haul-out"

import { MaterialAdjustmentCreate, MaterialStock, NAME_THE_CARRIER, OutboundLoad, OutboundLoadCreate, OutboundLoadPatch, OutboundLoadReason, OutboundLoadReceive, OutboundLoadReconcile } from "../haul-out"
import { UnloadingStation, UnloadingStationCreate } from "../places"
import { BOTH_GROSS_AND_TARE, NET_IS_GROSS_LESS_TARE } from "../unloads"
import { refusal, refusesAnEmptyPatch, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const STAMP = "2026-10-29T09:00:00.000Z"

const create = { projectId: ID, fromStationId: ID, toStationId: OTHER, wasteFractionId: ID, vehicleRegistration: "CN 42 018", departedAt: STAMP, netKg: 18_400 }

describe("OutboundLoad", () => {
  test("is a project's, from a transfer station to another, with its out-weighing, the receipt read against it and its costs", () => {
    const load = {
      id: ID,
      ...create,
      vehicleId: null,
      serviceProviderId: OTHER,
      grossKg: 32_400,
      tareKg: 14_000,
      outboundTicket: "WB-2026-4410",
      receipt: { ticket: "ARC-88123", netKg: 18_100, receivedAt: STAMP, differenceKg: -300, deviationPercent: -1.6, withinTolerance: true },
      haulCostMinor: 185_000,
      disposalCostMinor: 920_000,
      status: "received",
      note: null,
      createdAt: STAMP,
      updatedAt: STAMP,
    }
    assert.deepEqual(OutboundLoad.parse(load), load)
    assert.equal(OutboundLoad.safeParse({ ...load, status: "tipped" }).success, false)
    assert.deepEqual(refusal(OutboundLoad.safeParse({ ...load, tareKg: null })), [{ path: "tareKg", message: BOTH_GROSS_AND_TARE }])
  })
})

describe("OutboundLoadCreate", () => {
  test("departs from a station to another, our vehicle named or a plate given, the weights an Unload's", () => {
    assert.equal(OutboundLoadCreate.safeParse(create).success, true)
    const { vehicleRegistration: _plate, ...withoutPlate } = create
    assert.equal(OutboundLoadCreate.safeParse({ ...withoutPlate, vehicleId: OTHER }).success, true, "our vehicle's plate is read off it")
    assert.deepEqual(refusal(OutboundLoadCreate.safeParse(withoutPlate)), [{ path: "vehicleRegistration", message: NAME_THE_CARRIER }])
    assert.deepEqual(refusal(OutboundLoadCreate.safeParse({ ...create, toStationId: ID })), [{ path: "toStationId", message: SAME_STATION }])
    assert.deepEqual(refusal(OutboundLoadCreate.safeParse({ ...create, grossKg: 30_000, tareKg: 14_000 })), [{ path: "netKg", message: NET_IS_GROSS_LESS_TARE }])
    assert.equal(OutboundLoadCreate.safeParse({ ...create, haulCostMinor: -1 }).success, false)
    refusesWhatTheServerOwns(OutboundLoadCreate, create)
    assert.match(refusal(OutboundLoadCreate.safeParse({ ...create, status: "received" }))[0]!.message, /status/)
  })
})

describe("the load's commands", () => {
  test("a patch records the costs, our ticket or the note, and nothing of the trip", () => {
    assert.equal(OutboundLoadPatch.safeParse({ haulCostMinor: 185_000, disposalCostMinor: null }).success, true)
    assert.equal(OutboundLoadPatch.safeParse({ netKg: 18_000 }).success, false)
    refusesAnEmptyPatch(OutboundLoadPatch)
  })

  test("a receipt is the site's ticket, its net and when; a dispute and a cancellation say why; a reconciliation may", () => {
    assert.equal(OutboundLoadReceive.safeParse({ receivingTicket: "ARC-88123", receivedNetKg: 18_100, receivedAt: STAMP }).success, true)
    assert.equal(OutboundLoadReceive.safeParse({ receivingTicket: "ARC-88123", receivedNetKg: 0, receivedAt: STAMP }).success, false)
    assert.equal(OutboundLoadReason.safeParse({}).success, false)
    assert.equal(OutboundLoadReason.safeParse({ note: "The plant weighed 900 kg less" }).success, true)
    assert.equal(OutboundLoadReconcile.safeParse({}).success, true)
  })
})

describe("a station's stock and its adjustments", () => {
  test("is read by project and fraction, and may read below zero", () => {
    const stock = { unloadingStationId: ID, rows: [{ projectId: ID, wasteFractionId: OTHER, inKg: 10_000, rejectedKg: 0, outKg: 12_000, adjustedKg: 0, onHandKg: -2_000 }] }
    assert.deepEqual(MaterialStock.parse(stock), stock)
  })

  test("an adjustment moves the stock by signed kilograms, never zero, with the count's words", () => {
    assert.equal(MaterialAdjustmentCreate.safeParse({ projectId: ID, wasteFractionId: OTHER, deltaKg: -1_500, note: "Counted after the haul" }).success, true)
    assert.deepEqual(refusal(MaterialAdjustmentCreate.safeParse({ projectId: ID, wasteFractionId: OTHER, deltaKg: 0, note: "Nothing" })), [
      { path: "deltaKg", message: "An adjustment moves the stock: give a number of kilograms other than zero" },
    ])
    assert.equal(MaterialAdjustmentCreate.safeParse({ projectId: ID, wasteFractionId: OTHER, deltaKg: 100 }).success, false, "the count's words are required")
  })
})

describe("an Unloading Station", () => {
  test("may be a transfer station, off when a create does not say and on a row from before it", () => {
    const body = UnloadingStationCreate.parse({ code: "KYST-OMLAST", name: "Kystbyen omlastestation", address: "Havnevej 2", location: { type: "Point", coordinates: [12.6, 55.7] }, ownership: "company" })
    assert.equal(body.transfer, false)
    assert.equal(UnloadingStationCreate.parse({ ...body, transfer: true }).transfer, true)
    const station = { id: ID, ...body, serviceProviderId: null, opensAt: null, closesAt: null, notes: null, createdAt: STAMP, updatedAt: STAMP }
    const { transfer: _transfer, ...before } = station
    assert.equal(UnloadingStation.parse(before).transfer, false)
  })
})
