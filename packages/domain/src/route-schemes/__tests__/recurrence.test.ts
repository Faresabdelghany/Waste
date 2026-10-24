import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  RECURRENCE_WEEKLY_RATES,
  SERVICE_DAYS,
  addDays,
  isoWeek,
  matchesRecurrence,
  mondayOf,
  occurrencesPerWeek,
  recurrenceCadenceLabel,
  recurrenceFromValues,
  serviceDayOf,
  serviceDaysRangeLabel,
  weeksFromEffectiveFrom,
  type RecurrenceFrequency,
  type ServiceDay,
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

describe("daily and every-3-weeks", () => {
  test("daily matches every date in the window regardless of service days", () => {
    const recurrence = {
      frequency: "daily" as const,
      serviceDays: ["monday" as const],
      effectiveFrom: "2026-09-14",
      effectiveTo: "2026-09-20",
    }
    for (const iso of ["2026-09-14", "2026-09-16", "2026-09-19", "2026-09-20"]) {
      assert.equal(matchesRecurrence(recurrence, iso), true, iso)
    }
    assert.equal(matchesRecurrence(recurrence, "2026-09-21"), false)
    assert.equal(RECURRENCE_WEEKLY_RATES.daily, 7)
    assert.equal(recurrenceCadenceLabel({ frequency: "daily" }), "Daily")
  })

  test("recurrenceFromValues widens a daily scheme to the full week", () => {
    const recurrence = recurrenceFromValues({
      frequency: "daily",
      serviceDays: "monday, tuesday",
      effectiveFrom: "2026-09-14",
      effectiveTo: "",
    })
    assert.equal(recurrence?.serviceDays.length, 7)
  })

  test("every 3 weeks anchors on the effective-from week", () => {
    const recurrence = {
      frequency: "every-3-weeks" as const,
      serviceDays: ["tuesday" as const],
      effectiveFrom: "2026-09-16",
      effectiveTo: "",
    }
    assert.equal(matchesRecurrence(recurrence, "2026-09-22"), false)
    assert.equal(matchesRecurrence(recurrence, "2026-10-06"), true)
    assert.equal(matchesRecurrence(recurrence, "2026-10-13"), false)
    assert.equal(matchesRecurrence(recurrence, "2026-10-27"), true)
    assert.equal(RECURRENCE_WEEKLY_RATES["every-3-weeks"], 1 / 3)
  })
})

describe("isoWeek", () => {
  test("known weeks", () => {
    assert.equal(isoWeek("2026-09-14"), 38)
    assert.equal(isoWeek("2026-12-28"), 53)
    assert.equal(isoWeek("2027-01-04"), 1)
  })
})

describe("occurrencesPerWeek", () => {
  // What a recurrence in force from `from` serves on the days over its first `days` dates, per week.
  const walked = (frequency: RecurrenceFrequency, serviceDays: ServiceDay[], from: string, days: number) => {
    const recurrence = { frequency, serviceDays, weekRotation: "odd" as const, effectiveFrom: from, effectiveTo: "" }
    let served = 0
    for (let offset = 0; offset < days; offset += 1) {
      const date = addDays(from, offset)
      if (matchesRecurrence(recurrence, date) && serviceDays.includes(serviceDayOf(date))) served += 1
    }
    return served / (days / 7)
  }
  const near = (actual: number, expected: number, message: string) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} is not ${expected}`)

  test("weekly serves each of its days once a week", () => {
    assert.equal(occurrencesPerWeek("weekly", ["monday", "thursday"]), 2)
  })

  test("every 2 weeks serves its days once a fortnight: Mon and Thu are one route a week, not two", () => {
    assert.equal(occurrencesPerWeek("every-2-weeks", ["monday", "thursday"]), 1)
    assert.equal(occurrencesPerWeek("every-2-weeks", ["wednesday"]), 0.5)
  })

  test("daily serves each day it is given once a week", () => {
    assert.equal(occurrencesPerWeek("daily", [...SERVICE_DAYS]), 7)
    assert.equal(occurrencesPerWeek("daily", ["monday", "tuesday"]), 2)
  })

  test("is the recurrence's average over one full cycle of its rotation", () => {
    // 4 Jan 2027 is the Monday of ISO week 1, odd: the cycle starts in a served week.
    const cycleWeeks = { daily: 1, weekly: 1, "every-2-weeks": 2, "every-3-weeks": 3, "every-4-weeks": 4 } as const
    for (const [frequency, weeks] of Object.entries(cycleWeeks) as [RecurrenceFrequency, number][]) {
      for (const days of [["monday"], ["monday", "thursday"], ["tuesday", "wednesday", "saturday"]] as ServiceDay[][]) {
        near(occurrencesPerWeek(frequency, days), walked(frequency, days, "2027-01-04", weeks * 7), `${frequency} on ${days.join(", ")}`)
      }
    }
  })

  test("monthly serves each day's first of the month: the calendar year's twelve over the weekly rates' 52 weeks", () => {
    for (const days of [["monday"], ["tuesday", "friday"]] as ServiceDay[][]) {
      const servedIn2027 = walked("monthly", days, "2027-01-01", 365) * (365 / 7)
      near(servedIn2027, 12 * days.length, `monthly on ${days.join(", ")} in 2027`)
      near(occurrencesPerWeek("monthly", days), servedIn2027 / 52, `monthly on ${days.join(", ")}`)
    }
  })

  test("counts a day once, and no day as nothing", () => {
    assert.equal(occurrencesPerWeek("weekly", ["monday", "monday"]), 1)
    assert.equal(occurrencesPerWeek("every-3-weeks", []), 0)
  })
})
