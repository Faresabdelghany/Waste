import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { danishHolidayName } from "../holiday-names"
import { holidayListFromDates } from "../holidays"
import { NO_HOLIDAYS, generateOccurrences, occurrencePreview } from "../occurrences"
import type { ServiceDay } from "../recurrence"
import {
  DEFAULT_SIMULATION_COUNT,
  SIMULATION_COUNTS,
  simulateOccurrences,
} from "../simulation"
import { DANISH_WEEKEND, REGRESSION_HOLIDAY_DATES, calendarOf, weekdays } from "./holiday-fixture"

const holidays = holidayListFromDates(REGRESSION_HOLIDAY_DATES, danishHolidayName)
const calendar = calendarOf(holidays, DANISH_WEEKEND)

// Mon–Fri weekly from Mon 21 Dec 2026 — Christmas Eve and Christmas Day fall
// inside the first ten collections, so every holiday policy shows its hand.
const december = { ...weekdays, effectiveFrom: "2026-12-21" }

describe("simulateOccurrences — the horizon", () => {
  test("offers 5, 10, 20, 50 and defaults to 10", () => {
    assert.deepEqual([...SIMULATION_COUNTS], [5, 10, 20, 50])
    assert.equal(DEFAULT_SIMULATION_COUNT, 10)
  })

  test("spans the current draft's Nth collection, counted the way the preview counts", () => {
    const current = { recurrence: december, holidayPolicy: "skip" as const, calendar }
    const simulation = simulateOccurrences({ current, candidate: current, count: 10 })
    // Skip drops 24, 25, 31 Dec and 1 Jan, so the 10th collection is Thu 7 Jan 2027.
    const tenth = occurrencePreview(current).rows.filter((row) => row.n === 10)[0]
    assert.equal(tenth.plannedDate, "2027-01-07")
    assert.deepEqual(simulation.window, { from: "2026-12-21", to: "2027-01-07" })
    assert.equal(simulation.before, 10)
    assert.equal(simulation.after, 10)
    // The four skipped dates stay in the list — the preview shows them too.
    assert.equal(simulation.rows.length, 14)
    assert.ok(simulation.rows.every((row) => row.change === "unchanged"))
  })

  test("a draft with fewer than N collections spans them all", () => {
    const current = {
      recurrence: { ...december, effectiveTo: "2026-12-23" },
      holidayPolicy: "skip" as const,
      calendar,
    }
    const simulation = simulateOccurrences({ current, candidate: current, count: 50 })
    assert.deepEqual(simulation.window, { from: "2026-12-21", to: "2026-12-23" })
    assert.equal(simulation.before, 3)
  })

  test("a draft without a recurrence measures against the candidate's collections", () => {
    const candidate = { recurrence: december, holidayPolicy: "collect" as const, calendar }
    const simulation = simulateOccurrences({ current: null, candidate, count: 5 })
    assert.deepEqual(simulation.window, { from: "2026-12-21", to: "2026-12-25" })
    assert.equal(simulation.before, 0)
    assert.equal(simulation.after, 5)
    assert.equal(simulation.added, 5)
  })

  test("nothing on either side yields the empty simulation", () => {
    const empty = simulateOccurrences({ current: null, candidate: null, count: 10 })
    assert.equal(empty.window, null)
    assert.deepEqual(empty.rows, [])
    const noDays = simulateOccurrences({
      current: { recurrence: { ...december, serviceDays: [] }, holidayPolicy: "skip", calendar },
      candidate: null,
      count: 10,
    })
    assert.equal(noDays.window, null)
  })

  test("a count below one is read as one", () => {
    const current = { recurrence: december, holidayPolicy: "collect" as const, calendar }
    const simulation = simulateOccurrences({ current, candidate: current, count: 0 })
    assert.deepEqual(simulation.window, { from: "2026-12-21", to: "2026-12-21" })
  })
})

describe("simulateOccurrences — the delta", () => {
  test("skip → shift-next moves the four winter holidays onto working days", () => {
    const current = { recurrence: december, holidayPolicy: "skip" as const, calendar }
    const candidate = { ...current, holidayPolicy: "shift-next" as const }
    const simulation = simulateOccurrences({ current, candidate, count: 10 })
    const changed = simulation.rows.filter((row) => row.change !== "unchanged")
    // Christmas Eve and Day both land on Mon 28 Dec; New Year's Eve and Day on Mon 4 Jan.
    assert.deepEqual(
      changed.map((row) => [row.plannedDate, row.change, row.current?.status, row.candidate?.date]),
      [
        ["2026-12-24", "added", "skipped", "2026-12-28"],
        ["2026-12-25", "added", "skipped", "2026-12-28"],
        ["2026-12-31", "added", "skipped", "2027-01-04"],
        ["2027-01-01", "added", "skipped", "2027-01-04"],
      ],
    )
    assert.equal(simulation.before, 10)
    assert.equal(simulation.after, 14)
    assert.equal(simulation.added, 4)
    assert.equal(simulation.removed, 0)
    assert.equal(simulation.moved, 0)
  })

  test("shift-next → shift-prev moves a collection the other way", () => {
    const current = { recurrence: december, holidayPolicy: "shift-next" as const, calendar }
    const candidate = { ...current, holidayPolicy: "shift-prev" as const }
    const simulation = simulateOccurrences({ current, candidate, count: 10 })
    const eve = simulation.rows.find((row) => row.plannedDate === "2026-12-24")
    assert.ok(eve)
    assert.equal(eve.change, "moved")
    assert.equal(eve.current?.date, "2026-12-28")
    assert.equal(eve.candidate?.date, "2026-12-23")
    // Ten shift-next collections end on Fri 1 Jan: all four holidays inside move.
    assert.equal(simulation.moved, 4)
    assert.equal(simulation.before, simulation.after)
  })

  test("dropping a service day removes its collections and adding one adds them", () => {
    const current = { recurrence: december, holidayPolicy: "collect" as const, calendar }
    const candidate = {
      ...current,
      recurrence: {
        ...december,
        serviceDays: ["monday", "tuesday", "wednesday", "thursday", "saturday"] as ServiceDay[],
      },
    }
    const simulation = simulateOccurrences({ current, candidate, count: 10 })
    // Ten Mon–Fri collections reach Fri 1 Jan 2027: two Fridays leave, two Saturdays arrive.
    assert.deepEqual(simulation.window, { from: "2026-12-21", to: "2027-01-01" })
    assert.deepEqual(
      simulation.rows.filter((row) => row.change === "removed").map((row) => row.plannedDate),
      ["2026-12-25", "2027-01-01"],
    )
    assert.deepEqual(
      simulation.rows.filter((row) => row.change === "added").map((row) => row.plannedDate),
      ["2026-12-26"],
    )
    assert.equal(simulation.removed, 2)
    assert.equal(simulation.added, 1)
    assert.equal(simulation.after, 9)
  })

  test("a later effective-from widens the window to the earlier start and removes the head", () => {
    const current = { recurrence: december, holidayPolicy: "collect" as const, calendar }
    const candidate = { ...current, recurrence: { ...december, effectiveFrom: "2026-12-23" } }
    const simulation = simulateOccurrences({ current, candidate, count: 5 })
    assert.deepEqual(simulation.window, { from: "2026-12-21", to: "2026-12-25" })
    assert.deepEqual(
      simulation.rows.map((row) => row.change),
      ["removed", "removed", "unchanged", "unchanged", "unchanged"],
    )
  })

  test("both sides are the rows generateOccurrences yields for the window", () => {
    const current = { recurrence: december, holidayPolicy: "skip" as const, calendar }
    const candidate = { recurrence: december, holidayPolicy: "shift-next" as const, calendar: calendarOf(NO_HOLIDAYS, DANISH_WEEKEND) }
    const simulation = simulateOccurrences({ current, candidate, count: 10 })
    assert.ok(simulation.window)
    assert.deepEqual(
      simulation.rows.map((row) => row.current).filter(Boolean),
      generateOccurrences({ ...current, window: simulation.window }),
    )
    assert.deepEqual(
      simulation.rows.map((row) => row.candidate).filter(Boolean),
      generateOccurrences({ ...candidate, window: simulation.window }),
    )
  })
})
