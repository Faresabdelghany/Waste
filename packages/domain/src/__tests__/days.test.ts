// Calendar days (days.ts): the arithmetic every context reads, the two ways
// of moving by months, and the labels, spelled from tables so a runtime's ICU
// cannot change them.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { addDays, addMonthsClamped, addMonthsRolling, daysBetween, daysInclusive, dayWindowFits, formatDayMonth, formatShortDay, isIsoDate, isoWeek, mondayOf, serviceDayOf } from "../days"

describe("isIsoDate", () => {
  test("is a day that exists, spelled YYYY-MM-DD", () => {
    assert.equal(isIsoDate("2026-02-28"), true)
    assert.equal(isIsoDate("2028-02-29"), true, "a leap day")
    assert.equal(isIsoDate("2026-02-29"), false, "not a leap year")
    assert.equal(isIsoDate("2026-02-30"), false, "would roll over to March")
    assert.equal(isIsoDate("9999-99-99"), false)
    assert.equal(isIsoDate("2026-9-1"), false)
    assert.equal(isIsoDate("2026-09-01T00:00:00Z"), false, "an instant is not a day")
  })
})

describe("addDays", () => {
  test("moves by calendar days across months, years and the clock changes", () => {
    assert.equal(addDays("2026-12-31", 1), "2027-01-01")
    assert.equal(addDays("2028-03-01", -1), "2028-02-29")
    assert.equal(addDays("2026-03-28", 2), "2026-03-30", "a day is a day on a calendar, whatever a clock does")
  })
})

describe("daysBetween and daysInclusive", () => {
  test("daysBetween counts the half-open span, negative where it runs backwards", () => {
    assert.equal(daysBetween("2026-10-01", "2026-11-01"), 31)
    assert.equal(daysBetween("2026-10-05", "2026-10-05"), 0)
    assert.equal(daysBetween("2026-10-05", "2026-10-01"), -4)
    assert.equal(daysBetween("2026-03-28", "2026-03-30"), 2, "across the clock change")
  })

  test("daysInclusive counts both ends", () => {
    assert.equal(daysInclusive("2026-10-05", "2026-10-05"), 1)
    assert.equal(daysInclusive("2026-01-01", "2026-12-31"), 365)
  })
})

describe("dayWindowFits", () => {
  test("holds a window of days, both ends in, to at most so many days", () => {
    assert.equal(dayWindowFits({ from: "2026-03-01", to: "2026-05-31" }, 92), true, "92 days")
    assert.equal(dayWindowFits({ from: "2026-03-01", to: "2026-06-01" }, 92), false, "93 days")
    assert.equal(dayWindowFits({ from: "2026-10-05", to: "2026-10-05" }, 1), true, "one day is a window")
  })

  test("passes what is not its to refuse: a backward window, and one it cannot measure", () => {
    assert.equal(dayWindowFits({ from: "2027-01-01", to: "2026-01-01" }, 1), true)
    assert.equal(dayWindowFits({ from: "2026-10-05", to: "nope" }, 1), true)
  })
})

describe("weekdays and ISO weeks", () => {
  test("serviceDayOf names the weekday, and mondayOf the Monday of its ISO week", () => {
    assert.equal(serviceDayOf("2026-12-24"), "thursday")
    assert.equal(serviceDayOf("2026-12-27"), "sunday")
    assert.equal(mondayOf("2026-12-27"), "2026-12-21", "a Sunday is the last day of its week")
    assert.equal(mondayOf("2026-12-21"), "2026-12-21")
  })

  test("isoWeek: known weeks", () => {
    assert.equal(isoWeek("2026-09-14"), 38)
    assert.equal(isoWeek("2026-12-28"), 53)
    assert.equal(isoWeek("2027-01-04"), 1)
  })
})

describe("moving by months", () => {
  test("addMonthsRolling rolls over like Date#setMonth", () => {
    assert.equal(addMonthsRolling("2026-09-13", 12), "2027-09-13")
    assert.equal(addMonthsRolling("2026-01-31", 1), "2026-03-03")
  })

  test("addMonthsClamped moves by calendar months, and a day the month lacks lands on its last day", () => {
    assert.equal(addMonthsClamped("2026-03-15", 12), "2027-03-15")
    assert.equal(addMonthsClamped("2026-11-30", 3), "2027-02-28", "30 February is not a day: its month's last is")
    assert.equal(addMonthsClamped("2027-11-30", 3), "2028-02-29", "a leap year's February has a 29th")
    assert.equal(addMonthsClamped("2026-01-31", 1), "2026-02-28")
    assert.equal(addMonthsClamped("2026-12-31", 24), "2028-12-31")
  })
})

describe("labels", () => {
  test("a short day names its weekday, its day and its month", () => {
    assert.equal(formatShortDay("2026-12-24"), "Thu 24 Dec")
    assert.equal(formatDayMonth("2026-10-05"), "5 Oct")
  })

  test("September is Sep on every runtime: ICU 72 and later would say Sept", () => {
    assert.equal(formatShortDay("2026-09-28"), "Mon 28 Sep")
    assert.equal(formatDayMonth("2026-09-16"), "16 Sep")
  })
})
