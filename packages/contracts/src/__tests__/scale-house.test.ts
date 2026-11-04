import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { PARTY_SHAPE, ScaleTicket, ScaleTicketAmountDue, ScaleTicketComplete, ScaleTicketCreate, ScaleTicketListQuery, ScaleTicketPatch, ScaleTicketVoid, VehicleTare, VehicleTareCreate, VehicleTarePatch } from "../scale-house"
import { refusal, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const STAMPS = { id: ID, createdAt: "2026-10-29T08:00:00.000Z", updatedAt: "2026-10-29T08:00:00.000Z" }

describe("a registered tare (M16a of #293)", () => {
  const create = { projectId: ID, plate: "CN 42 018", tareKg: 8_120, weighedOn: "2026-10-01" }

  test("is a plate, optionally a trailer's and a container, weighed empty on a day", () => {
    assert.deepEqual(VehicleTareCreate.parse(create), create)
    assert.equal(VehicleTareCreate.parse({ ...create, trailerPlate: "TR 11 002", containerRef: "SK-7" }).containerRef, "SK-7")
    refusesWhatTheServerOwns(VehicleTareCreate, create)
    assert.equal(VehicleTareCreate.safeParse({ ...create, tareKg: 0 }).success, false)
  })

  test("is re-weighed, owned, labelled or retired, and its plates are what it is", () => {
    assert.equal(VehicleTarePatch.parse({ tareKg: 8_200 }).tareKg, 8_200)
    assert.equal(VehicleTarePatch.safeParse({}).success, false)
    assert.equal(VehicleTarePatch.safeParse({ plate: "XY 1" }).success, false)
  })

  test("reads with its keys as stored", () => {
    const tare = { ...STAMPS, projectId: ID, plate: "CN42018", trailerPlate: null, containerRef: null, tareKg: 8_120, weighedOn: "2026-10-01", customerId: null, label: null, status: "active" }
    assert.deepEqual(VehicleTare.parse(tare), tare)
  })
})

describe("a scale ticket (M16a of #293)", () => {
  const account = { projectId: ID, unloadingStationId: ID, vehiclePlate: "CN 42 018", party: "account", customerId: ID, agreementId: OTHER, grossKg: 12_340 }
  const cash = { projectId: ID, unloadingStationId: ID, vehiclePlate: "AB 12 345", party: "cash", visitorName: "Lars", grossKg: 2_340 }

  test("is weighed in at its gross, for an account customer under an agreement or a walk-in", () => {
    assert.deepEqual(ScaleTicketCreate.parse(account), account)
    assert.deepEqual(ScaleTicketCreate.parse(cash), cash)
    refusesWhatTheServerOwns(ScaleTicketCreate, account)
  })

  test("names its customer and agreement exactly when it is an account's", () => {
    assert.deepEqual(refusal(ScaleTicketCreate.safeParse({ ...account, agreementId: undefined })).map((issue) => [issue.path, issue.message]), [["customerId", PARTY_SHAPE]])
    assert.deepEqual(refusal(ScaleTicketCreate.safeParse({ ...cash, customerId: ID })).map((issue) => [issue.path, issue.message]), [["customerId", PARTY_SHAPE]])
  })

  test("changes only its walk-in name and its note while open", () => {
    assert.equal(ScaleTicketPatch.parse({ note: "Paid by card" }).note, "Paid by card")
    assert.equal(ScaleTicketPatch.safeParse({}).success, false)
    assert.equal(ScaleTicketPatch.safeParse({ grossKg: 1 }).success, false)
  })

  test("is completed at a second pass or on the registered tare, with its load split into lines", () => {
    const weighed = { tare: { source: "weighed", tareKg: 8_120 }, lines: [{ wasteFractionId: ID, originMunicipality: "0101", netKg: 3_000 }, { wasteFractionId: ID, originMunicipality: "0147", netKg: 1_220 }] }
    assert.deepEqual(ScaleTicketComplete.parse(weighed), weighed)
    assert.equal(ScaleTicketComplete.parse({ tare: { source: "registered" }, lines: [{ wasteFractionId: ID, netKg: 4_220 }] }).tare.source, "registered")
    assert.equal(ScaleTicketComplete.safeParse({ tare: { source: "registered", tareKg: 1 }, lines: weighed.lines }).success, false, "a registered tare carries no weight of its own")
    assert.equal(ScaleTicketComplete.safeParse({ ...weighed, lines: [] }).success, false)
    assert.equal(ScaleTicketComplete.safeParse({ ...weighed, lines: Array.from({ length: 21 }, (_, index) => ({ wasteFractionId: ID, originMunicipality: String(index).padStart(4, "0"), netKg: 1 })) }).success, false)
    assert.equal(ScaleTicketComplete.safeParse({ ...weighed, lines: [{ wasteFractionId: ID, originMunicipality: "101", netKg: 4_220 }] }).success, false, "a kommunekode is four digits")
  })

  test("names each fraction and origin once", () => {
    const twice = { tare: { source: "weighed", tareKg: 8_120 }, lines: [{ wasteFractionId: ID, originMunicipality: "0101", netKg: 2_000 }, { wasteFractionId: ID, originMunicipality: "0101", netKg: 2_220 }] }
    assert.deepEqual(refusal(ScaleTicketComplete.safeParse(twice)).map((issue) => issue.path), ["lines"])
  })

  test("is voided with a reason, and another reason says why in the note", () => {
    assert.equal(ScaleTicketVoid.parse({ reason: "duplicate" }).reason, "duplicate")
    assert.deepEqual(refusal(ScaleTicketVoid.safeParse({ reason: "other" })).map((issue) => issue.path), ["note"])
    assert.equal(ScaleTicketVoid.parse({ reason: "other", note: "Scale fault" }).note, "Scale fault")
  })

  test("reads with its lines, its match and its void", () => {
    const ticket = {
      ...STAMPS,
      projectId: ID,
      number: 1000,
      unloadingStationId: ID,
      vehiclePlate: "CN 42 018",
      trailerPlate: null,
      containerRef: null,
      vehicleId: null,
      party: "cash",
      customerId: null,
      agreementId: null,
      visitorName: null,
      grossKg: 12_340,
      weighedInAt: "2026-10-29T08:00:00.000Z",
      tareKg: 8_120,
      tareSource: "weighed",
      vehicleTareId: null,
      weighedOutAt: "2026-10-29T08:20:00.000Z",
      netKg: 4_220,
      status: "completed",
      lines: [{ id: OTHER, position: 1, wasteFractionId: ID, originMunicipality: null, netKg: 4_220, productId: null, volumeLitres: null }],
      routeId: null,
      unloadId: null,
      unmatchedReason: null,
      voidReason: null,
      voidNote: null,
      voidedAt: null,
      note: null,
      recordedBy: ID,
    }
    assert.deepEqual(ScaleTicket.parse(ticket), ticket)
  })

  test("is listed by project, site, standing, party and customer", () => {
    assert.equal(ScaleTicketListQuery.parse({ status: "open", party: "cash" }).party, "cash")
    assert.equal(ScaleTicketListQuery.safeParse({ status: "weighed" }).success, false)
  })
})

describe("the window's prices (M16b of #293)", () => {
  test("a line names the product it is sold by, and a volume for one sold by the cubic metre", () => {
    const line = { wasteFractionId: ID, netKg: 900, productId: OTHER, volumeLitres: 1_500 }
    assert.deepEqual(ScaleTicketComplete.parse({ tare: { source: "registered" }, lines: [line] }).lines, [line])
    assert.equal(ScaleTicketComplete.safeParse({ tare: { source: "registered" }, lines: [{ ...line, volumeLitres: 0 }] }).success, false)
  })

  test("what is due reads each line priced or blocked, and the totals", () => {
    const due = {
      ticketId: ID,
      currency: "DKK",
      lines: [
        { lineId: OTHER, productId: ID, quantity: 0.9, unitPriceMinor: 54_000, netMinor: 54_000, vatMinor: 13_500, blockReason: null },
        { lineId: ID, productId: null, quantity: null, unitPriceMinor: null, netMinor: null, vatMinor: null, blockReason: "no-product" },
      ],
      netMinor: 54_000,
      vatMinor: 13_500,
      totalMinor: 67_500,
      complete: false,
    }
    assert.deepEqual(ScaleTicketAmountDue.parse(due), due)
  })
})
