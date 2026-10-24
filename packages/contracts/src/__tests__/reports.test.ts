// The reports' queries and answers (#292, C26 and O12): a strict window of
// days, at most a year, its interval defaulted, refused by name for a filter
// it does not read; and the four answers, a rate null where there was nothing
// to divide by.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { DAY_WINDOW_ORDERED } from "../queries"
import {
  REPORT_DAY_TOO_EARLY,
  REPORT_FIRST_DAY,
  REPORT_WINDOW_MAX_DAYS,
  REPORT_WINDOW_TOO_LONG,
  reportWindowFits,
  RevenueReport,
  RevenueReportQuery,
  ServiceReport,
  ServiceReportQuery,
  TicketReport,
  TicketReportQuery,
  TonnageReport,
  TonnageReportQuery,
} from "../reports"
import { refusal } from "./expect"

const PROJECT = "01a0d3a5-e5e0-7000-8000-000000000001"
const FRACTION = "01a0d3a5-e5e0-7000-8000-000000000002"
const STATION = "01a0d3a5-e5e0-7000-8000-000000000003"
const SCHEME = "01a0d3a5-e5e0-7000-8000-000000000004"
const PRODUCT = "01a0d3a5-e5e0-7000-8000-000000000005"

const QUERIES = { ServiceReportQuery, TicketReportQuery, RevenueReportQuery, TonnageReportQuery }

describe("the report queries", () => {
  test("take a window of two days, both inclusive, the interval `day` when absent and the project optional", () => {
    for (const [name, query] of Object.entries(QUERIES)) {
      assert.deepEqual(query.parse({ from: "2026-10-01", to: "2026-10-31" }), { from: "2026-10-01", to: "2026-10-31", interval: "day" }, name)
      assert.deepEqual(query.parse({ projectId: PROJECT, from: "2026-10-05", to: "2026-10-05", interval: "month" }), { projectId: PROJECT, from: "2026-10-05", to: "2026-10-05", interval: "month" }, `${name}: one day is a window`)
    }
  })

  test("require both days, refuse a backwards window at `to`, and a window longer than a year", () => {
    for (const [name, query] of Object.entries(QUERIES)) {
      assert.deepEqual(refusal(query.safeParse({ from: "2026-10-01" })).map((issue) => issue.path), ["to"], name)
      assert.deepEqual(refusal(query.safeParse({ from: "2026-10-02", to: "2026-10-01" })), [{ path: "to", message: DAY_WINDOW_ORDERED }], name)
      assert.deepEqual(refusal(query.safeParse({ from: "2026-01-01", to: "2027-01-02" })), [{ path: "to", message: REPORT_WINDOW_TOO_LONG }], `${name}: 367 days`)
      assert.equal(query.safeParse({ from: "2028-01-01", to: "2028-12-31" }).success, true, `${name}: a leap year is ${REPORT_WINDOW_MAX_DAYS} days`)
      assert.deepEqual(refusal(query.safeParse({ from: "2026-10-01", to: "2026-10-31", interval: "quarter" })).map((issue) => issue.path), ["interval"], name)
    }
    assert.equal(reportWindowFits({ from: "2026-01-01", to: "2026-12-31" }), true)
    assert.equal(reportWindowFits({ from: "2026-01-01", to: "2027-01-01" }), true, "366 days")
    assert.equal(reportWindowFits({ from: "2026-01-01", to: "2027-01-02" }), false)
  })

  test("tell a day that is not one its own sentence and no second one, and refuse a day before the first a report reads", () => {
    for (const [name, query] of Object.entries(QUERIES)) {
      assert.deepEqual(refusal(query.safeParse({ from: "2026-10-05", to: "nope" })).map((issue) => issue.path), ["to"], `${name}: one issue, the day's, not also the window's length`)
      assert.deepEqual(refusal(query.safeParse({ from: "0000-01-01", to: "0000-01-31" })), [
        { path: "from", message: REPORT_DAY_TOO_EARLY },
        { path: "to", message: REPORT_DAY_TOO_EARLY },
      ], `${name}: Postgres has no year 0`)
      assert.equal(query.safeParse({ from: REPORT_FIRST_DAY, to: REPORT_FIRST_DAY }).success, true, name)
    }
    assert.equal(reportWindowFits({ from: "2026-10-05", to: "nope" }), true, "a window it cannot measure is the day's to refuse")
  })

  test("are strict: a parameter the report does not read is refused by name, never ignored", () => {
    assert.deepEqual(refusal(TicketReportQuery.safeParse({ from: "2026-10-01", to: "2026-10-31", wasteFractionId: FRACTION })).map((issue) => issue.path), [""])
    assert.deepEqual(refusal(ServiceReportQuery.safeParse({ from: "2026-10-01", to: "2026-10-31", unloadingStationId: STATION })).map((issue) => issue.path), [""])
    assert.deepEqual(refusal(RevenueReportQuery.safeParse({ from: "2026-10-01", to: "2026-10-31", limit: "50" })).map((issue) => issue.path), [""])
    assert.deepEqual(ServiceReportQuery.parse({ from: "2026-10-01", to: "2026-10-31", wasteFractionId: FRACTION, routeSchemeId: SCHEME }).routeSchemeId, SCHEME)
    assert.deepEqual(TonnageReportQuery.parse({ from: "2026-10-01", to: "2026-10-31", wasteFractionId: FRACTION, unloadingStationId: STATION }).unloadingStationId, STATION)
  })
})

const window = { projectId: null, from: "2026-10-01", to: "2026-10-31", interval: "week" }
const routes = { total: 4, planned: 1, ready: 0, active: 0, completed: 2, cancelled: 1, started: 2, onTime: 1, late: 1, unjudged: 0 }
const pickups = { due: 9, completed: 5, missed: 3, skipped: 2, failed: 1, open: 1, withdrawn: 1 }

describe("the report answers", () => {
  test("the service report: the window as read, the counts, the rates, the missed pickups by reason, the series and the schemes", () => {
    const report = {
      window,
      routes,
      pickups,
      rates: { collection: 5 / 8, missed: 3 / 8, onTime: 0.5 },
      missedByReason: [{ reason: "not-presented", skipped: 0, failed: 1 }],
      intervals: [{ from: "2026-10-01", to: "2026-10-04", routes, pickups }],
      schemes: [
        { routeSchemeId: SCHEME, name: "Centrum Mondays", projectId: PROJECT, routes, pickups, rates: { collection: null, missed: null, onTime: null } },
        // The office's ad-hoc routes (#111): no scheme, so no name.
        { routeSchemeId: null, name: null, projectId: PROJECT, routes, pickups, rates: { collection: null, missed: null, onTime: null } },
      ],
    }
    assert.deepEqual(ServiceReport.parse(report), report)
    assert.deepEqual(refusal(ServiceReport.safeParse({ ...report, rates: { ...report.rates, collection: 1.2 } })).map((issue) => issue.path), ["rates.collection"])
    assert.deepEqual(refusal(ServiceReport.safeParse({ ...report, pickups: { ...pickups, open: -1 } })).map((issue) => issue.path), ["pickups.open"])
  })

  test("the ticket report: when it was read, the window's counts, the open ones now and their kinds", () => {
    const report = {
      window,
      asOf: "2026-10-24T08:00:00.000Z",
      opened: 3,
      closed: 2,
      completed: 1,
      rejected: 1,
      closedWithDue: 1,
      closedWithinDue: 1,
      open: 2,
      overdue: 1,
      openOnRoutes: 1,
      rates: { closedWithinDue: 1 },
      byKind: [{ kind: "missed-collection", opened: 2, closed: 1, open: 1 }],
      intervals: [{ from: "2026-10-01", to: "2026-10-04", opened: 1, closed: 0 }],
    }
    assert.deepEqual(TicketReport.parse(report), report)
    assert.deepEqual(refusal(TicketReport.safeParse({ ...report, byKind: [{ kind: "complaint-ish", opened: 0, closed: 0, open: 0 }] })).map((issue) => issue.path), ["byKind.0.kind"])
  })

  test("the revenue report: by currency, a credit note's amounts negative, per interval and per product", () => {
    const totals = { currency: "DKK", invoices: 2, creditNotes: 1, netMinor: 150_000, vatMinor: 37_500, grossMinor: 187_500 }
    const report = {
      window,
      currencies: [totals],
      intervals: [{ from: "2026-10-01", to: "2026-10-04", ...totals }],
      products: [{ productId: PRODUCT, name: "Emptying 240 L", currency: "DKK", quantity: -1, netMinor: -12_500 }],
    }
    assert.deepEqual(RevenueReport.parse(report), report)
    assert.deepEqual(refusal(RevenueReport.safeParse({ ...report, currencies: [{ ...totals, currency: "dkk" }] })).map((issue) => issue.path), ["currencies.0.currency"])
  })

  test("the tonnage report: the totals, the unloads by project, fraction, station and interval, and the pickup weights", () => {
    const weighed = { netKg: 4_200, approvedKg: 3_000, capturedKg: 1_200, unloads: 2, rejectedKg: 800, rejectedUnloads: 1 }
    const report = {
      window,
      totals: { ...weighed, pickupWeightKg: 96, weighedPickups: 2 },
      unloads: [{ from: "2026-10-05", to: "2026-10-11", projectId: PROJECT, wasteFractionId: FRACTION, wasteFractionName: "Residual waste", unloadingStationId: STATION, unloadingStationName: "Amager Bakke", ...weighed }],
      pickupWeights: [{ from: "2026-10-05", to: "2026-10-11", projectId: PROJECT, wasteFractionId: FRACTION, wasteFractionName: "Residual waste", weightKg: 96, pickups: 2 }],
    }
    assert.deepEqual(TonnageReport.parse(report), report)
    assert.deepEqual(refusal(TonnageReport.safeParse({ ...report, totals: { ...report.totals, netKg: 1.5 } })).map((issue) => issue.path), ["totals.netKg"])
  })
})
