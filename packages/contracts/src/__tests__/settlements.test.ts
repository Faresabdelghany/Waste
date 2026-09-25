import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { SETTLEMENT_STATUSES } from "@waste/domain/finance/vocabulary"

import { A_PERIOD_ENDS, PRICED_TOGETHER, pricedWhole, Settlement, SettlementCalculate, SettlementClose, SettlementCreate, SettlementDetail, SettlementEvent, SettlementEventListQuery, SettlementLine, SettlementListQuery, SettlementReopen } from "../settlements"
import { ENDS_AFTER_IT_STARTS } from "../validity"
import { refusal, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const STAMPS = { createdAt: "2026-11-01T06:00:00.000Z", updatedAt: "2026-11-01T06:00:00.000Z" }
const WHEN = "2026-11-02T09:00:00.000Z"
const BACKWARDS = { path: "validTo", message: ENDS_AFTER_IT_STARTS }

const settlement = {
  id: ID,
  projectId: OTHER,
  serviceAreaAssignmentId: THIRD,
  status: "calculated",
  currency: "DKK",
  calculatedAt: WHEN,
  closedAt: null,
  closedBy: null,
  lineCount: 218,
  netMinor: 1_744_000,
  validFrom: "2026-10-01",
  validTo: "2026-11-01",
  ...STAMPS,
}

const line = { id: OTHER, settlementId: ID, billableEventId: THIRD, serviceProviderPriceId: OTHER, quantity: 1, unitPriceMinor: 8_000, netMinor: 8_000, ...STAMPS }

const event = { id: THIRD, recordedAt: WHEN, settlementId: ID, kind: "calculated", status: "calculated", lineCount: 218, netMinor: 1_744_000, reason: null, recordedBy: OTHER }

describe("Settlement", () => {
  test("is the record on the wire: an assignment's, over a period with both ends, its status and stamps, the project's currency, and the calculation's totals", () => {
    assert.deepEqual(Settlement.parse(settlement), settlement)
    const open = { ...settlement, status: "open", calculatedAt: null, lineCount: 0, netMinor: 0 }
    assert.deepEqual(Settlement.parse(open), open)
    const closed = { ...settlement, status: "closed", closedAt: WHEN, closedBy: OTHER }
    assert.deepEqual(Settlement.parse(closed), closed)
    for (const status of SETTLEMENT_STATUSES) assert.equal(Settlement.safeParse({ ...settlement, status }).success, true, status)
  })

  test("is the one effective-dated resource whose end is required: without validTo it does not parse, and it is told why", () => {
    const { validTo: _end, ...unended } = settlement
    assert.deepEqual(refusal(Settlement.safeParse(unended)), [{ path: "validTo", message: A_PERIOD_ENDS }])
    assert.deepEqual(refusal(Settlement.safeParse({ ...settlement, validTo: null })), [{ path: "validTo", message: A_PERIOD_ENDS }])
    assert.deepEqual(refusal(Settlement.safeParse({ ...settlement, validTo: "November" })).map((issue) => issue.path), ["validTo"], "a malformed day is refused as a day, in zod's words")
    assert.notEqual(refusal(Settlement.safeParse({ ...settlement, validTo: "November" }))[0].message, A_PERIOD_ENDS)
    assert.deepEqual(refusal(Settlement.safeParse({ ...settlement, validTo: "2026-10-01" })), [BACKWARDS])
    assert.deepEqual(refusal(Settlement.safeParse({ ...settlement, status: "under-review" })).map((issue) => issue.path), ["status"])
    assert.deepEqual(refusal(Settlement.safeParse({ ...settlement, lineCount: -1 })).map((issue) => issue.path), ["lineCount"])
  })
})

describe("SettlementLine, SettlementEvent and SettlementDetail", () => {
  test("a line is one event priced with the provider price valid on its day, or unpriced with the three null together", () => {
    assert.deepEqual(SettlementLine.parse(line), line)
    const unpriced = { ...line, serviceProviderPriceId: null, unitPriceMinor: null, netMinor: null }
    assert.deepEqual(SettlementLine.parse(unpriced), unpriced)
    const reversal = { ...line, netMinor: -8_000 }
    assert.deepEqual(SettlementLine.parse(reversal), reversal, "a reversal's line is negative")
    assert.deepEqual(refusal(SettlementLine.safeParse({ ...line, serviceProviderPriceId: null })), [{ path: "serviceProviderPriceId", message: PRICED_TOGETHER }])
    assert.deepEqual(refusal(SettlementLine.safeParse({ ...line, netMinor: null })), [{ path: "serviceProviderPriceId", message: PRICED_TOGETHER }])
    assert.equal(pricedWhole({ serviceProviderPriceId: null, unitPriceMinor: null, netMinor: null }), true)
    assert.equal(pricedWhole({ serviceProviderPriceId: OTHER, unitPriceMinor: 1, netMinor: 1 }), true)
    assert.equal(pricedWhole({ serviceProviderPriceId: OTHER, unitPriceMinor: null, netMinor: 1 }), false)
    assert.deepEqual(refusal(SettlementLine.safeParse({ ...line, quantity: 0 })).map((issue) => issue.path), ["quantity"])
    assert.deepEqual(refusal(SettlementLine.safeParse({ ...line, unitPriceMinor: -1 })).map((issue) => issue.path), ["unitPriceMinor"])
  })

  test("an event is a ledger row of the history with the snapshot after it and, on a reopening, its reason", () => {
    assert.deepEqual(SettlementEvent.parse(event), event)
    const reopened = { ...event, kind: "reopened", status: "open", reason: "A correction landed in October" }
    assert.deepEqual(SettlementEvent.parse(reopened), reopened)
    assert.equal("updatedAt" in SettlementEvent.shape, false)
    assert.deepEqual(refusal(SettlementEvent.safeParse({ ...event, kind: "recalculated" })).map((issue) => issue.path), ["kind"])
  })

  test("the detail is the settlement with its lines, and holds the end and the period like the settlement", () => {
    const detail = { ...settlement, lines: [line, { ...line, id: THIRD, billableEventId: OTHER }] }
    assert.deepEqual(SettlementDetail.parse(detail), detail)
    assert.deepEqual(SettlementDetail.parse({ ...detail, lines: [] }), { ...detail, lines: [] })
    assert.deepEqual(refusal(SettlementDetail.safeParse({ ...detail, validTo: null })), [{ path: "validTo", message: A_PERIOD_ENDS }])
    assert.deepEqual(refusal(SettlementDetail.safeParse({ ...detail, validTo: "2026-09-01" })), [BACKWARDS])
  })
})

describe("SettlementCreate and the three commands", () => {
  const body = { serviceAreaAssignmentId: THIRD, validFrom: "2026-10-01", validTo: "2026-11-01" }

  test("the create takes the assignment and both days, and neither the project nor the currency nor the status", () => {
    assert.deepEqual(SettlementCreate.parse(body), body)
    for (const key of ["serviceAreaAssignmentId", "validFrom"]) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(SettlementCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
    assert.deepEqual(refusal(SettlementCreate.safeParse({ serviceAreaAssignmentId: THIRD, validFrom: "2026-10-01" })), [{ path: "validTo", message: A_PERIOD_ENDS }])
    assert.deepEqual(refusal(SettlementCreate.safeParse({ ...body, validTo: null })), [{ path: "validTo", message: A_PERIOD_ENDS }])
    assert.deepEqual(refusal(SettlementCreate.safeParse({ ...body, validTo: "2026-10-01" })), [BACKWARDS])
    refusesWhatTheServerOwns(SettlementCreate, body)
    for (const key of ["projectId", "currency", "status", "lineCount", "netMinor", "calculatedAt"]) assert.match(refusal(SettlementCreate.safeParse({ ...body, [key]: "x" }))[0].message, new RegExp(key), key)
  })

  test("calculate and close say nothing, and reopen says why", () => {
    assert.deepEqual(SettlementCalculate.parse({}), {})
    assert.deepEqual(SettlementClose.parse({}), {})
    assert.deepEqual(refusal(SettlementCalculate.safeParse({ force: true })).map((issue) => issue.path), [""])
    assert.deepEqual(refusal(SettlementClose.safeParse({ note: "x" })).map((issue) => issue.path), [""])
    assert.deepEqual(SettlementReopen.parse({ reason: "A correction landed in October" }), { reason: "A correction landed in October" })
    assert.deepEqual(refusal(SettlementReopen.safeParse({})).map((issue) => issue.path), ["reason"])
    assert.deepEqual(refusal(SettlementReopen.safeParse({ reason: "  " })).map((issue) => issue.path), ["reason"])
  })
})

describe("the list queries", () => {
  test("SettlementListQuery pages by project, assignment, provider, status and day", () => {
    assert.deepEqual(SettlementListQuery.parse({}), { limit: 50 })
    assert.deepEqual(SettlementListQuery.parse({ projectId: OTHER, serviceAreaAssignmentId: THIRD, serviceProviderId: ID, status: "closed", validOn: "2026-10-15" }), { limit: 50, projectId: OTHER, serviceAreaAssignmentId: THIRD, serviceProviderId: ID, status: "closed", validOn: "2026-10-15" })
    assert.deepEqual(refusal(SettlementListQuery.safeParse({ status: "reopened" })).map((issue) => issue.path), ["status"])
  })

  test("SettlementEventListQuery pages one settlement's history by kind: the path says the settlement", () => {
    assert.deepEqual(SettlementEventListQuery.parse({}), { limit: 50 })
    assert.deepEqual(SettlementEventListQuery.parse({ kind: "reopened", limit: "5" }), { limit: 5, kind: "reopened" })
    assert.equal("projectId" in SettlementEventListQuery.shape, false)
  })
})
