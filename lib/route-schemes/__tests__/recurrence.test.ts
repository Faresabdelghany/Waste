import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  RECURRENCE_WEEKLY_RATES,
  isoWeek,
  matchesRecurrence,
  mondayOf,
  recurrenceCadenceLabel,
  recurrenceFromValues,
  serviceDaysRangeLabel,
  weeksFromEffectiveFrom,
} from "../recurrence"

describe("serviceDaysRangeLabel", () => {
  test("three or more consecutive days collapse to a range", () => {
    assert.equal(
      serviceDaysRangeLabel(["monday", "tuesday", "wednesday", "thursday", "friday"]),
      "Mon–Fri",
    )
    assert.equal(serviceDaysRangeLabel(["tuesday", "wednesday", "thursday"]), "Tue–Thu")
  })

  test("non-consecutive or short selections list the days", () => {
    assert.equal(serviceDaysRangeLabel(["monday", "wednesday"]), "Mon, Wed")
    assert.equal(serviceDaysRangeLabel(["monday", "tuesday"]), "Mon, Tue")
    assert.equal(serviceDaysRangeLabel(["friday", "monday"]), "Mon, Fri")
    assert.equal(serviceDaysRangeLabel([]), "")
  })
})

describe("every-4-weeks", () => {
  test("mondayOf and weeksFromEffectiveFrom", () => {
    assert.equal(mondayOf("2026-09-16"), "2026-09-14")
    assert.equal(mondayOf("2026-09-14"), "2026-09-14")
    assert.equal(mondayOf("2026-09-20"), "2026-09-14")
    assert.equal(weeksFromEffectiveFrom({ effectiveFrom: "2026-09-16" }, "2026-10-13"), 4)
    assert.equal(weeksFromEffectiveFrom({ effectiveFrom: "2026-09-16" }, "2026-09-10"), -1)
  })

  test("matches the anchor week and every fourth week after it", () => {
    const recurrence = {
      frequency: "every-4-weeks" as const,
      serviceDays: ["tuesday" as const],
      effectiveFrom: "2026-09-16",
      effectiveTo: "",
    }
    // 16 Sep is a Wednesday; the anchor week's Tuesday (15 Sep) is before From.
    assert.equal(matchesRecurrence(recurrence, "2026-09-15"), false)
    assert.equal(matchesRecurrence(recurrence, "2026-09-22"), false)
    assert.equal(matchesRecurrence(recurrence, "2026-10-13"), true)
    assert.equal(matchesRecurrence(recurrence, "2026-10-20"), false)
    assert.equal(matchesRecurrence(recurrence, "2026-11-10"), true)
  })

  test("label, rate, and value parsing", () => {
    assert.equal(recurrenceCadenceLabel({ frequency: "every-4-weeks" }), "Every 4 weeks")
    assert.equal(RECURRENCE_WEEKLY_RATES["every-4-weeks"], 0.25)
    const recurrence = recurrenceFromValues({
      frequency: "every-4-weeks",
      serviceDays: "monday",
      effectiveFrom: "2026-09-14",
      effectiveTo: "",
    })
    assert.equal(recurrence?.frequency, "every-4-weeks")
  })
})

describe("isoWeek", () => {
  test("known weeks", () => {
    assert.equal(isoWeek("2026-09-14"), 38)
    assert.equal(isoWeek("2026-12-28"), 53)
    assert.equal(isoWeek("2027-01-04"), 1)
  })
})
