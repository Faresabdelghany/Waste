// How the Dashboard reads the reports on the Pilot (#292): the period
// picker's windows and the period before each, a change told in points for
// a rate and in percent for a count with whether it is good news, a rate of
// nothing as a dash, the throughput series beside the period before, and
// the Route Schemes' rows.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { PickupStandings, RouteCounts, ServiceInterval } from "@waste/contracts/reports"
import { intervalsOver, windowDays } from "@waste/domain/insight/intervals"

import { countChange, DASHBOARD_RANGES, intervalLabel, percentOf, previousWindow, AD_HOC_ROUTES, rangeOf, rateChange, schemeKeyOf, schemeNameOf, schemeRowOf, schemesByAttention, throughputOf, windowEnding } from "../dashboard"
import { countedOf } from "@/lib/format/counts"

describe("the period picker", () => {
  test("offers a week and a month by the day and a quarter by the week", () => {
    assert.deepEqual(
      DASHBOARD_RANGES.map((range) => [range.id, range.days, range.interval]),
      [
        ["7d", 7, "day"],
        ["30d", 30, "day"],
        ["90d", 90, "week"],
      ],
    )
    assert.equal(rangeOf("90d").label, "Last 90 days")
  })

  test("a window ends today and holds its days; the period before is as long and ends the day before it starts", () => {
    assert.deepEqual(windowEnding("2026-10-24", 7), { from: "2026-10-18", to: "2026-10-24" })
    assert.deepEqual(windowEnding("2026-03-01", 30), { from: "2026-01-31", to: "2026-03-01" })
    assert.deepEqual(previousWindow({ from: "2026-10-18", to: "2026-10-24" }), { from: "2026-10-11", to: "2026-10-17" })
    assert.deepEqual(previousWindow({ from: "2026-10-24", to: "2026-10-24" }), { from: "2026-10-23", to: "2026-10-23" })
  })

  test("a series by the week is told against the period whole weeks before, so both are cut into weeks on the same weekdays", () => {
    const window = windowEnding("2026-10-24", 90)
    const before = previousWindow(window, "week")
    assert.deepEqual(before, { from: "2026-04-27", to: "2026-07-25" }, "13 weeks back: as long, a day short of touching the window")
    const shape = (span: { from: string; to: string }) => intervalsOver(span, "week").map((week) => windowDays(week))
    assert.deepEqual(shape(before), shape(window), "each week beside a week of as many days")
  })
})

describe("a change against the period before", () => {
  test("a count changes in percent, good news by the direction the measure wants", () => {
    assert.deepEqual(countChange(110, 100, true), { text: "10%", direction: "up", tone: "positive" })
    assert.deepEqual(countChange(110, 100, false), { text: "10%", direction: "up", tone: "negative" }, "more missed pickups is bad news")
    assert.deepEqual(countChange(90, 100, false), { text: "10%", direction: "down", tone: "positive" })
    assert.deepEqual(countChange(5, 5, true), { text: "0%", direction: "flat", tone: "neutral" })
  })

  test("from nothing a count rises from 0, a change under a percent is told as one, and without the period before there is no change", () => {
    assert.deepEqual(countChange(4, 0, false), { text: "from 0", direction: "up", tone: "negative" }, "missed pickups appearing is bad news, not nothing to compare")
    assert.deepEqual(countChange(0, 0, true), { text: "0%", direction: "flat", tone: "neutral" })
    assert.deepEqual(countChange(10_040, 10_000, false), { text: "<1%", direction: "up", tone: "negative" }, "a change the rounding hides is still a change")
    assert.equal(countChange(4, undefined, true), null)
  })

  test("a rate changes in points, and a rate of nothing on either side has no change", () => {
    assert.deepEqual(rateChange(0.86, 0.8, true), { text: "6 pp", direction: "up", tone: "positive" })
    assert.deepEqual(rateChange(0.5, 0.75, true), { text: "25 pp", direction: "down", tone: "negative" })
    assert.equal(rateChange(null, 0.8, true), null)
    assert.equal(rateChange(0.8, null, true), null)
    assert.equal(rateChange(0.8, undefined, true), null)
    assert.deepEqual(rateChange(0.804, 0.8, true), { text: "<1 pp", direction: "up", tone: "positive" })
    assert.deepEqual(rateChange(0.8, 0.8, true), { text: "0 pp", direction: "flat", tone: "neutral" })
  })
})

describe("what a number reads as", () => {
  test("a rate a whole percent, a rate of nothing a dash", () => {
    assert.equal(percentOf(2 / 3), "67%")
    assert.equal(percentOf(0), "0%")
    assert.equal(percentOf(null), "—")
  })

  test("a count with its noun, plural but for one", () => {
    assert.equal(countedOf(1, "unload"), "1 unload")
    assert.equal(countedOf(0, "unload"), "0 unloads")
    assert.equal(countedOf(1_204, "pickup"), "1,204 pickups")
  })

  test("an interval its day, or its first and last", () => {
    assert.equal(intervalLabel({ from: "2026-10-05", to: "2026-10-05" }), "Oct 5")
    assert.equal(intervalLabel({ from: "2026-10-05", to: "2026-10-11" }), "Oct 5 – Oct 11")
  })
})

const routes: RouteCounts = { total: 0, planned: 0, ready: 0, active: 0, completed: 0, cancelled: 0, started: 0, onTime: 0, late: 0, unjudged: 0 }
const pickups = (completed: number, missed = 0): PickupStandings => ({ due: completed + missed, completed, missed, skipped: missed, failed: 0, open: 0, withdrawn: 0 })
const span = (day: string, completed: number, missed = 0): ServiceInterval => ({ from: day, to: day, routes, pickups: pickups(completed, missed) })

describe("throughputOf", () => {
  test("sets each interval beside the one in the same place of the period before, and none where that period has fewer", () => {
    const current = [span("2026-10-18", 12, 1), span("2026-10-19", 9)]
    assert.deepEqual(throughputOf(current, [span("2026-10-11", 10)]), [
      { key: "2026-10-18", label: "Oct 18", completed: 12, missed: 1, previous: 10 },
      { key: "2026-10-19", label: "Oct 19", completed: 9, missed: 0, previous: null },
    ])
    assert.equal(throughputOf(current, undefined)[0].previous, null, "the period before not read yet")
  })
})

describe("the scheme rows", () => {
  const rates = { collection: 0.5, missed: 0.5, onTime: null }
  const scheme = (name: string | null, routeSchemeId: string | null, missed: number) => ({
    routeSchemeId,
    name,
    projectId: "01a0d3a5-e5e0-7000-8000-000000000001",
    routes,
    pickups: { ...pickups(1, missed) },
    rates,
  })

  test("a project's ad-hoc routes are a row named for them, keyed by their project; the most missed first, then by name", () => {
    const adHoc = scheme(null, null, 3)
    const centrum = scheme("Centrum Mondays", "01a0d3a5-e5e0-7000-8000-0000000000c1", 3)
    const havnen = scheme("Havnen Mondays", "01a0d3a5-e5e0-7000-8000-0000000000c2", 5)
    assert.equal(schemeNameOf(adHoc), AD_HOC_ROUTES)
    assert.equal(schemeKeyOf(adHoc), "ad-hoc|01a0d3a5-e5e0-7000-8000-000000000001")
    assert.equal(schemeKeyOf(centrum), centrum.routeSchemeId)
    const window = { projectId: null, from: "2026-10-05", to: "2026-10-11", interval: "day" as const }
    const empty = { total: 0, planned: 0, ready: 0, active: 0, completed: 0, cancelled: 0, started: 0, onTime: 0, late: 0, unjudged: 0 }
    const report = { window, routes: empty, pickups: pickups(0), rates, missedByReason: [], intervals: [], schemes: [centrum, adHoc, havnen] }
    assert.deepEqual(schemesByAttention(report).map(schemeNameOf), ["Havnen Mondays", AD_HOC_ROUTES, "Centrum Mondays"])
    assert.equal(schemeRowOf(adHoc, () => "Copenhagen Central")[0], AD_HOC_ROUTES)
  })
})
