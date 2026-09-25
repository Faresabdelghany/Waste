// The day an instant falls on, on a project's clock (routes/days.ts): what the
// licence rule is handed instead of the instant, since a licence expiring on
// the 5th still holds at 23:30 on the 5th in Copenhagen and no longer at
// 00:30 on the 6th, which is the same instant an hour apart in offset.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { dayInTimezone, lastDayInside } from "../routes/days"

describe("dayInTimezone", () => {
  test("renders the instant as the calendar day of the timezone, so the same instant is one day in London and the next in Copenhagen", () => {
    const lateOnTheFifth = new Date("2026-09-05T22:30:00Z")
    assert.equal(dayInTimezone(lateOnTheFifth, "UTC"), "2026-09-05")
    assert.equal(dayInTimezone(lateOnTheFifth, "Europe/London"), "2026-09-05")
    assert.equal(dayInTimezone(lateOnTheFifth, "Europe/Copenhagen"), "2026-09-06", "CEST is UTC+2: 00:30 on the 6th")
    assert.equal(dayInTimezone(new Date("2026-09-05T21:59:59Z"), "Europe/Copenhagen"), "2026-09-05", "23:59:59 on the 5th, still the 5th")
    assert.equal(dayInTimezone(new Date("2026-09-05T15:30:00Z"), "Asia/Tokyo"), "2026-09-06", "UTC+9, no daylight saving")
    assert.equal(dayInTimezone(new Date("2026-09-06T06:30:00Z"), "America/Los_Angeles"), "2026-09-05", "PDT is UTC-7: still the evening of the 5th")
  })

  test("always spells YYYY-MM-DD, zero-padded, whatever Intl's locale would", () => {
    assert.equal(dayInTimezone(new Date("2026-01-02T12:00:00Z"), "UTC"), "2026-01-02")
    assert.match(dayInTimezone(new Date(), "Europe/Copenhagen"), /^\d{4}-\d{2}-\d{2}$/)
  })

  test("a timezone that is not one is a bug in the row, not a client's, and is thrown", () => {
    assert.throws(() => dayInTimezone(new Date(), "Europe/Nowhere"), RangeError)
  })
})

describe("lastDayInside", () => {
  test("renders the last instant inside a half-open window, so a window ending at midnight ends on the day before and one a millisecond past it reaches the day after", () => {
    // 22:00Z is midnight in Copenhagen (CEST, +02:00): the first instant of the 6th, and the first instant out of a window ending then.
    const midnight = new Date("2026-09-05T22:00:00Z")
    assert.equal(dayInTimezone(midnight, "Europe/Copenhagen"), "2026-09-06", "the end itself falls on the 6th")
    assert.equal(lastDayInside(midnight, "Europe/Copenhagen"), "2026-09-05", "the window's last instant is 23:59:59.999 on the 5th")
    assert.equal(lastDayInside(new Date("2026-09-05T22:00:00.001Z"), "Europe/Copenhagen"), "2026-09-06", "a millisecond later the window reaches into the 6th")
    assert.equal(lastDayInside(new Date("2026-09-05T21:30:00Z"), "Europe/Copenhagen"), "2026-09-05", "an end inside a day is on that day either way")
    assert.equal(lastDayInside(new Date("2026-09-06T00:00:00Z"), "UTC"), "2026-09-05")
    assert.equal(lastDayInside(new Date("2026-09-06T07:00:00Z"), "America/Los_Angeles"), "2026-09-05", "midnight PDT, on the 5th there")
  })
})
