import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { BOTH_GROSS_AND_TARE, NET_IS_GROSS_LESS_TARE } from "../unloads"
import { WeighbridgeIngest, WeighbridgeTicket, WeighbridgeTicketBatch, WeighbridgeTicketDismiss, WeighbridgeTicketIn, WeighbridgeTicketListQuery, WeighbridgeTicketMatch } from "../weighbridge"
import { refusal, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const ticket = { stationCode: "ARC-AMAGER", ticketNumber: "WB-2026-3901", vehicleRegistration: "CN 42 018", weighedAt: "2026-10-05T10:40:00.000Z", netKg: 8540, grossKg: 18_540, tareKg: 10_000, fractionKey: "residual" }

describe("a weighbridge ticket as the ingest takes it (O27 of #290)", () => {
  test("is the station's code and number, the plate, the instant, the weights and the product, by key or by waste code", () => {
    assert.deepEqual(WeighbridgeTicketIn.parse(ticket), ticket)
    assert.equal(WeighbridgeTicketIn.parse({ ...ticket, fractionKey: undefined, wasteCode: "200133*" }).wasteCode, "200133*")
    refusesWhatTheServerOwns(WeighbridgeTicketIn, ticket)
  })

  test("holds the weights to an Unload's rule, each at its field", () => {
    assert.deepEqual(refusal(WeighbridgeTicketIn.safeParse({ ...ticket, tareKg: undefined })).map((issue) => [issue.path, issue.message]), [["tareKg", BOTH_GROSS_AND_TARE]])
    assert.deepEqual(refusal(WeighbridgeTicketIn.safeParse({ ...ticket, netKg: 8000 })).map((issue) => [issue.path, issue.message]), [["netKg", NET_IS_GROSS_LESS_TARE]])
    assert.equal(WeighbridgeTicketIn.safeParse({ ...ticket, wasteCode: "20 03 01" }).success, false, "a code on the wire is compact")
    assert.equal(WeighbridgeTicketIn.safeParse({ ...ticket, netKg: 0 }).success, false)
  })

  test("comes in a batch of one to five hundred", () => {
    assert.equal(WeighbridgeTicketBatch.parse({ tickets: [ticket] }).tickets.length, 1)
    assert.equal(WeighbridgeTicketBatch.safeParse({ tickets: [] }).success, false)
    assert.equal(WeighbridgeTicketBatch.safeParse({ tickets: Array.from({ length: 501 }, () => ticket) }).success, false)
    assert.equal(WeighbridgeTicketBatch.parse({ tickets: Array.from({ length: 500 }, () => ticket) }).tickets.length, 500)
  })
})

describe("the ingest's answer", () => {
  test("is one outcome per ticket: matched with its Unload, unmatched with the reason, replayed, or refused", () => {
    const named = { stationCode: "ARC-AMAGER", ticketNumber: "WB-1" }
    const answer = {
      outcomes: [
        { ...named, outcome: "matched", ticketId: ID, unloadId: ID },
        { ...named, outcome: "unmatched", ticketId: ID, reason: "unknown-vehicle" },
        { ...named, outcome: "replayed", ticketId: ID },
        { ...named, outcome: "refused", reason: "unknown-station" },
      ],
    }
    assert.deepEqual(WeighbridgeIngest.parse(answer), answer)
    assert.equal(WeighbridgeIngest.safeParse({ outcomes: [{ ...named, outcome: "refused", reason: "no-route" }] }).success, false, "a refusal is not an unmatched reason")
  })
})

describe("a weighbridge ticket as the office reads and moves it", () => {
  test("carries its status, its reason, and its route and Unload once matched", () => {
    const read = { id: ID, createdAt: "2026-10-05T10:41:00.000Z", updatedAt: "2026-10-05T10:41:00.000Z", projectId: null, unloadingStationId: ID, ticketNumber: "WB-1", vehicleRegistration: "XX 99 999", vehicleId: null, weighedAt: "2026-10-05T10:40:00.000Z", grossKg: null, tareKg: null, netKg: 640, fractionKey: null, wasteCode: "200301", status: "unmatched", unmatchedReason: "unknown-vehicle", routeId: null, unloadId: null, dismissedNote: null, receivedBy: ID }
    assert.deepEqual(WeighbridgeTicket.parse(read), read)
    assert.equal(WeighbridgeTicketListQuery.parse({ status: "unmatched" }).status, "unmatched")
    assert.equal(WeighbridgeTicketListQuery.safeParse({ status: "open" }).success, false)
  })

  test("is matched by a route and a fraction, and dismissed with a note", () => {
    assert.deepEqual(WeighbridgeTicketMatch.parse({ routeId: ID, wasteFractionId: ID }), { routeId: ID, wasteFractionId: ID })
    refusesWhatTheServerOwns(WeighbridgeTicketMatch, { routeId: ID, wasteFractionId: ID })
    assert.equal(WeighbridgeTicketDismiss.parse({ note: "A visitor's trailer" }).note, "A visitor's trailer")
    assert.equal(WeighbridgeTicketDismiss.safeParse({}).success, false)
  })
})
