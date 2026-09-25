import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { BillingRun, BillingRunCreate, BillingRunDetail, BillingRunExclusion, BillingRunListQuery, BillingRunPreview, PERIOD_ORDERED, periodOrdered } from "../billing"
import { DAY_WINDOW_ORDERED } from "../queries"
import { refusal, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const STAMPS = { createdAt: "2026-11-01T06:00:00.000Z", updatedAt: "2026-11-01T06:00:00.000Z" }
const WHEN = "2026-11-01T06:00:12.000Z"

const run = {
  id: ID,
  projectId: OTHER,
  periodFrom: "2026-10-01",
  periodTo: "2026-10-31",
  status: "completed",
  requestedBy: THIRD,
  completedAt: WHEN,
  eventCount: 1_842,
  invoiceCount: 214,
  excludedCustomerCount: 3,
  netMinor: 184_200_000,
  vatMinor: 46_050_000,
  note: null,
  ...STAMPS,
}

const exclusion = { id: OTHER, recordedAt: WHEN, billingRunId: ID, customerId: THIRD, reason: "all-events-blocked", eventCount: 12 }

describe("BillingRun", () => {
  test("is the record of one batch: the period, the status, who asked and when it completed, the counts and the totals as completed", () => {
    assert.deepEqual(BillingRun.parse(run), run)
    const scheduled = { ...run, status: "requested", requestedBy: null, completedAt: null, eventCount: 0, invoiceCount: 0, excludedCustomerCount: 0, netMinor: 0, vatMinor: 0, note: "The worker's" }
    assert.deepEqual(BillingRun.parse(scheduled), scheduled)
    assert.equal(BillingRun.parse({ ...run, periodTo: "2026-10-01" }).periodTo, "2026-10-01", "one day is a period")
  })

  test("holds the period to running forwards, the counts to zero or more, and the status to its vocabulary", () => {
    assert.deepEqual(refusal(BillingRun.safeParse({ ...run, periodTo: "2026-09-30" })), [{ path: "periodTo", message: PERIOD_ORDERED }])
    assert.deepEqual(refusal(BillingRun.safeParse({ ...run, eventCount: -1 })).map((issue) => issue.path), ["eventCount"])
    assert.deepEqual(refusal(BillingRun.safeParse({ ...run, status: "running" })).map((issue) => issue.path), ["status"])
    assert.equal(periodOrdered({ periodFrom: "2026-10-01", periodTo: "2026-10-01" }), true)
    assert.equal(periodOrdered({ periodFrom: "2026-10-02", periodTo: "2026-10-01" }), false)
  })

  test("an exclusion is a ledger row per payer with the reason and how many events; the detail carries them and the invoices' ids", () => {
    assert.deepEqual(BillingRunExclusion.parse(exclusion), exclusion)
    assert.equal("updatedAt" in BillingRunExclusion.shape, false)
    assert.deepEqual(refusal(BillingRunExclusion.safeParse({ ...exclusion, eventCount: 0 })).map((issue) => issue.path), ["eventCount"], "a payer excluded for no event is not excluded")
    const detail = { ...run, exclusions: [exclusion], invoiceIds: [OTHER, THIRD] }
    assert.deepEqual(BillingRunDetail.parse(detail), detail)
    assert.deepEqual(BillingRunDetail.parse({ ...detail, exclusions: [], invoiceIds: [] }), { ...detail, exclusions: [], invoiceIds: [] })
    assert.deepEqual(refusal(BillingRunDetail.safeParse({ ...detail, periodTo: "2026-09-30" })), [{ path: "periodTo", message: PERIOD_ORDERED }], "the rule travels with the fields")
  })
})

describe("BillingRunCreate and BillingRunPreview", () => {
  const body = { projectId: OTHER, periodFrom: "2026-10-01", periodTo: "2026-10-31" }

  test("the create takes the project and the period, a note if any, and nothing the run finds", () => {
    assert.deepEqual(BillingRunCreate.parse(body), body)
    assert.deepEqual(BillingRunCreate.parse({ ...body, note: "October" }), { ...body, note: "October" })
    for (const key of Object.keys(body)) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(BillingRunCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
    refusesWhatTheServerOwns(BillingRunCreate, body)
    for (const [key, value] of [
      ["status", "completed"],
      ["eventCount", 1],
      ["netMinor", 1],
      ["requestedBy", THIRD],
      ["completedAt", WHEN],
    ] as const) {
      assert.match(refusal(BillingRunCreate.safeParse({ ...body, [key]: value }))[0].message, new RegExp(key), key)
    }
    assert.deepEqual(refusal(BillingRunCreate.safeParse({ ...body, periodTo: "2026-09-30" })), [{ path: "periodTo", message: PERIOD_ORDERED }])
    assert.equal(BillingRunCreate.safeParse({ ...body, periodTo: "2026-10-01" }).success, true)
  })

  test("the preview answers the counts, the totals per currency and the exclusions, writing nothing", () => {
    const preview = { eventCount: 3, invoiceCount: 2, totals: [{ currency: "DKK", netMinor: 24_690, vatMinor: 6_172 }, { currency: "EUR", netMinor: 900, vatMinor: 225 }], exclusions: [{ customerId: THIRD, reason: "all-events-blocked", eventCount: 1 }] }
    assert.deepEqual(BillingRunPreview.parse(preview), preview)
    assert.deepEqual(BillingRunPreview.parse({ eventCount: 0, invoiceCount: 0, totals: [], exclusions: [] }), { eventCount: 0, invoiceCount: 0, totals: [], exclusions: [] })
    assert.deepEqual(refusal(BillingRunPreview.safeParse({ ...preview, totals: [{ currency: "kr", netMinor: 1, vatMinor: 0 }] })).map((issue) => issue.path), ["totals.0.currency"])
  })
})

describe("BillingRunListQuery", () => {
  test("pages by project and status, and over a window of periodFrom", () => {
    assert.deepEqual(BillingRunListQuery.parse({}), { limit: 50 })
    assert.deepEqual(BillingRunListQuery.parse({ projectId: OTHER, status: "completed", from: "2026-01-01", to: "2026-12-31" }), { limit: 50, projectId: OTHER, status: "completed", from: "2026-01-01", to: "2026-12-31" })
    assert.deepEqual(refusal(BillingRunListQuery.safeParse({ from: "2026-12-31", to: "2026-01-01" })), [{ path: "to", message: DAY_WINDOW_ORDERED }])
  })
})
