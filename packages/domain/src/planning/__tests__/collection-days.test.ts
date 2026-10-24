import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { SchemeCalendar } from "../../route-schemes/occurrences"
import type { SchemeRecurrence } from "../../route-schemes/recurrence"
import { collectionDaysOf, type ServingGroup, type ServingScheme } from "../collection-days"
import type { ExistingRoute } from "../generation"

/** Mondays and Thursdays, from October 2026, open-ended. */
const weekly: SchemeRecurrence = { frequency: "weekly", serviceDays: ["monday", "thursday"], effectiveFrom: "2026-10-01", effectiveTo: "" }
const restingWeekend: SchemeCalendar = { holidays: new Map(), weekend: ["saturday", "sunday"] }
/** Thursday 2026-10-08 is a holiday. */
const withHoliday: SchemeCalendar = { holidays: new Map([["2026-10-08", "Test Day"]]), weekend: ["saturday", "sunday"] }
const week = { from: "2026-10-05", to: "2026-10-11" }

const always = (fraction: string) => ({ fraction, validFrom: "2026-01-01", validTo: null })
const residual: ServingGroup = { id: "g-residual", position: 1, days: ["monday", "thursday"], stopSource: "rule", containers: [always("Residual")] }
const glass: ServingGroup = { id: "g-glass", position: 2, days: ["thursday"], stopSource: "manual", containers: [always("Metal"), always("Glass")] }

const scheme = (values: Partial<ServingScheme> = {}): ServingScheme => ({ recurrence: weekly, holidayPolicy: "skip", groups: [residual, glass], existingRoutes: [], ...values })
const route = (values: Partial<ExistingRoute> & Pick<ExistingRoute, "id" | "serviceDate">): ExistingRoute => ({
  collectionGroupId: residual.id,
  status: "planned",
  cancelledByGeneration: false,
  held: false,
  officeStops: false,
  operatingDate: values.serviceDate,
  ...values,
})
const summary = (input: Parameters<typeof collectionDaysOf>[0]) => collectionDaysOf(input).map((day) => [day.date, day.fractions.join("+"), day.status, day.note])

describe("collectionDaysOf", () => {
  test("each serving group's days inside the window, by date and then fraction, keyed by the route's identity", () => {
    const days = collectionDaysOf({ window: week, calendar: restingWeekend, schemes: [scheme()] })
    assert.deepEqual(
      days.map((day) => [day.date, day.fractions.join("+"), day.key]),
      [
        ["2026-10-05", "Residual", "g-residual|2026-10-05"],
        ["2026-10-08", "Glass+Metal", "g-glass|2026-10-08"],
        ["2026-10-08", "Residual", "g-residual|2026-10-08"],
      ],
    )
    assert.ok(days.every((day) => day.status === "collected" && day.note === null && day.serviceDate === day.date))
  })

  test("a holiday the policy skips is a skipped day; one it shifts moves the date and keeps the service date", () => {
    assert.deepEqual(summary({ window: week, calendar: withHoliday, schemes: [scheme()] }), [
      ["2026-10-05", "Residual", "collected", null],
      ["2026-10-08", "Glass+Metal", "skipped", "Skipped · Test Day"],
      ["2026-10-08", "Residual", "skipped", "Skipped · Test Day"],
    ])
    const shifted = collectionDaysOf({ window: week, calendar: withHoliday, schemes: [scheme({ holidayPolicy: "shift-next" })] }).filter((day) => day.serviceDate === "2026-10-08")
    assert.deepEqual(shifted.map((day) => [day.date, day.status]), [["2026-10-09", "collected"], ["2026-10-09", "collected"]])
    assert.ok(shifted.every((day) => day.note?.startsWith("Shifted")))
  })

  test("a route standing keeps its own day where generation would: held by the office, or already under way; one a person cancelled is no collection", () => {
    const days = collectionDaysOf({
      window: week,
      calendar: restingWeekend,
      schemes: [
        scheme({
          existingRoutes: [
            route({ id: "r-mon", serviceDate: "2026-10-05", operatingDate: "2026-10-06", held: true }),
            route({ id: "r-thu", serviceDate: "2026-10-08", status: "cancelled" }),
            route({ id: "r-glass", serviceDate: "2026-10-08", collectionGroupId: glass.id, status: "active", operatingDate: "2026-10-08" }),
          ],
        }),
      ],
    })
    assert.deepEqual(days.map((day) => [day.date, day.fractions.join("+"), day.note]), [
      ["2026-10-06", "Residual", "Moved to Tue 6 Oct"],
      ["2026-10-08", "Glass+Metal", null],
    ])
  })

  test("a collection a holiday or the office moved into the window from a service date before it is still found", () => {
    const friday = { from: "2026-10-09", to: "2026-10-11" }
    const shifted = collectionDaysOf({ window: friday, calendar: withHoliday, schemes: [scheme({ holidayPolicy: "shift-next" })] })
    assert.deepEqual(shifted.map((day) => [day.date, day.serviceDate, day.fractions.join("+")]), [
      ["2026-10-09", "2026-10-08", "Glass+Metal"],
      ["2026-10-09", "2026-10-08", "Residual"],
    ])
    const tuesday = { from: "2026-10-06", to: "2026-10-06" }
    const held = collectionDaysOf({ window: tuesday, calendar: restingWeekend, schemes: [scheme({ existingRoutes: [route({ id: "r", serviceDate: "2026-10-05", operatingDate: "2026-10-06", held: true })] })] })
    assert.deepEqual(held.map((day) => [day.date, day.serviceDate]), [["2026-10-06", "2026-10-05"]])
  })

  test("a skipped holiday says so whether or not a route stands on it: still planned, cancelled by the run, or none", () => {
    const standing = [
      route({ id: "r-planned", serviceDate: "2026-10-08" }),
      route({ id: "r-cancelled", serviceDate: "2026-10-08", collectionGroupId: glass.id, status: "cancelled", cancelledByGeneration: true }),
    ]
    const days = collectionDaysOf({ window: week, calendar: withHoliday, schemes: [scheme({ existingRoutes: standing })] }).filter((day) => day.serviceDate === "2026-10-08")
    assert.deepEqual(days.map((day) => [day.fractions.join("+"), day.status, day.note]), [
      ["Glass+Metal", "skipped", "Skipped · Test Day"],
      ["Residual", "skipped", "Skipped · Test Day"],
    ])
  })

  test("a container counts only while its placement is in force on the day's service date", () => {
    const comesThursday = { ...glass, containers: [{ fraction: "Glass", validFrom: "2026-10-08", validTo: null }] }
    const goesThursday = { ...residual, containers: [{ fraction: "Residual", validFrom: "2026-01-01", validTo: "2026-10-08" }] }
    const days = collectionDaysOf({ window: week, calendar: restingWeekend, schemes: [scheme({ groups: [goesThursday, comesThursday] })] })
    assert.deepEqual(days.map((day) => [day.date, day.fractions.join("+")]), [
      ["2026-10-05", "Residual"],
      ["2026-10-08", "Glass"],
    ])
  })

  test("a parked group (no days), a scheme with no serving group, and a day moved outside the window give nothing", () => {
    assert.deepEqual(collectionDaysOf({ window: week, calendar: restingWeekend, schemes: [scheme({ groups: [{ ...residual, days: [] }] }), scheme({ groups: [] })] }), [])
    const moved = collectionDaysOf({ window: { from: "2026-10-05", to: "2026-10-05" }, calendar: restingWeekend, schemes: [scheme({ existingRoutes: [route({ id: "r", serviceDate: "2026-10-05", operatingDate: "2026-10-07", held: true })] })] })
    assert.deepEqual(moved, [], "held off the window's only day")
  })
})
