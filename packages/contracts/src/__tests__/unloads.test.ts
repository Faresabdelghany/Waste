import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { OCCURRED_WINDOW_ORDERED } from "../stock"
import { BOTH_GROSS_AND_TARE, NET_IS_GROSS_LESS_TARE, Unload, UnloadCreate, UnloadListQuery, unloadWeights, weightsAddUp, weightsPaired } from "../unloads"
import { refusal, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const WHEN = "2026-10-05T11:00:00.000Z"
const LATER = "2026-10-05T14:00:00+02:00"
const POINT = { type: "Point", coordinates: [12.6193, 55.6602] }
const pair = { path: "tareKg", message: BOTH_GROSS_AND_TARE }
const sum = { path: "netKg", message: NET_IS_GROSS_LESS_TARE }

const unload = {
  id: ID,
  recordedAt: WHEN,
  projectId: OTHER,
  routeId: THIRD,
  sessionId: ID,
  unloadingStationId: OTHER,
  wasteFractionId: THIRD,
  source: "driver-app",
  occurredAt: WHEN,
  recordedBy: ID,
  deviceId: "device-7",
  location: POINT,
  grossKg: 12_400,
  tareKg: 8_200,
  netKg: 4_200,
  weighbridgeTicket: "WB-2026-3901",
  objectKey: `${OTHER}/${THIRD}/${ID}.jpg`,
  note: null,
}

describe("the weights rule", () => {
  test("gross and tare come together or not at all, and where both are given net is gross less tare", () => {
    assert.equal(weightsPaired({ netKg: 4_200, grossKg: 12_400, tareKg: 8_200 }), true)
    assert.equal(weightsPaired({ netKg: 4_200 }), true)
    assert.equal(weightsPaired({ netKg: 4_200, grossKg: null, tareKg: null }), true, "a row's nulls")
    assert.equal(weightsPaired({ netKg: 4_200, grossKg: 12_400 }), false)
    assert.equal(weightsPaired({ netKg: 4_200, tareKg: 8_200 }), false)
    assert.equal(weightsAddUp({ netKg: 4_200, grossKg: 12_400, tareKg: 8_200 }), true)
    assert.equal(weightsAddUp({ netKg: 4_000, grossKg: 12_400, tareKg: 8_200 }), false)
    assert.equal(weightsAddUp({ netKg: 4_000, grossKg: 12_400 }), true, "a half-given pair is the pairing rule's to refuse")
    assert.equal(unloadWeights({ netKg: 4_200, grossKg: 12_400, tareKg: 8_200 }), true)
    assert.equal(unloadWeights({ netKg: 4_000, grossKg: 12_400, tareKg: 8_200 }), false)
    assert.equal(unloadWeights({ netKg: 4_000, grossKg: 12_400 }), false)
  })
})

describe("Unload", () => {
  test("is a ledger row at a station with its weights: an id and recordedAt, never updatedAt", () => {
    assert.deepEqual(Unload.parse(unload), unload)
    const office = { ...unload, sessionId: null, source: "dispatch", deviceId: null, location: null, grossKg: null, tareKg: null, objectKey: null, note: "Ticket read off the paper" }
    assert.deepEqual(Unload.parse(office), office)
    assert.equal(Object.keys(Unload.shape).includes("updatedAt"), false)
    assert.deepEqual(refusal(Unload.safeParse({ ...unload, tareKg: null })), [pair])
    assert.deepEqual(refusal(Unload.safeParse({ ...unload, netKg: 4_000 })), [sum])
    // Zero is refused as a count and, beside gross and tare, as the sum: both at netKg.
    assert.deepEqual(new Set(refusal(Unload.safeParse({ ...unload, netKg: 0 })).map((issue) => issue.path)), new Set(["netKg"]), "nothing tipped is not an unload")
  })
})

describe("UnloadCreate", () => {
  const body = { unloadingStationId: OTHER, wasteFractionId: THIRD, netKg: 4_200, occurredAt: WHEN }

  test("is the office's capture: the station, the fraction, the weights, the ticket, when and a note; nothing the server owns", () => {
    assert.deepEqual(UnloadCreate.parse(body), body)
    const full = { ...body, grossKg: 12_400, tareKg: 8_200, weighbridgeTicket: "WB-2026-3901", note: "Second tip" }
    assert.deepEqual(UnloadCreate.parse(full), full)
    refusesWhatTheServerOwns(UnloadCreate, body)
    for (const key of ["recordedAt", "recordedBy", "source", "sessionId", "routeId", "projectId", "deviceId", "objectKey"]) {
      assert.match(refusal(UnloadCreate.safeParse({ ...body, [key]: ID }))[0].message, new RegExp(key), key)
    }
    for (const key of Object.keys(body)) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(UnloadCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
  })

  test("holds the weights to the two rules, each at its field", () => {
    assert.deepEqual(refusal(UnloadCreate.safeParse({ ...body, grossKg: 12_400 })), [pair])
    assert.deepEqual(refusal(UnloadCreate.safeParse({ ...body, tareKg: 8_200 })), [pair])
    assert.deepEqual(refusal(UnloadCreate.safeParse({ ...body, grossKg: 12_400, tareKg: 8_200, netKg: 4_000 })), [sum])
    assert.deepEqual(refusal(UnloadCreate.safeParse({ ...body, grossKg: 8_000, tareKg: 8_200, netKg: 200 })), [sum], "gross below tare cannot add up to a positive net")
    assert.equal(UnloadCreate.safeParse({ ...body, netKg: 0 }).success, false)
  })
})

describe("UnloadListQuery", () => {
  test("pages by project, route, station and fraction, and by a window over occurredAt, ordered", () => {
    assert.deepEqual(UnloadListQuery.parse({}), { limit: 50 })
    assert.deepEqual(UnloadListQuery.parse({ routeId: THIRD, unloadingStationId: OTHER, wasteFractionId: ID, from: WHEN, to: LATER }), { routeId: THIRD, unloadingStationId: OTHER, wasteFractionId: ID, from: WHEN, to: LATER, limit: 50 })
    assert.deepEqual(refusal(UnloadListQuery.safeParse({ from: LATER, to: WHEN })), [{ path: "to", message: OCCURRED_WINDOW_ORDERED }])
    assert.equal(UnloadListQuery.safeParse({ from: WHEN, to: WHEN }).success, true, "one instant is a window")
  })
})
