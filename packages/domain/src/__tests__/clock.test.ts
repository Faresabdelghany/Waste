// The project's clock (clock.ts): the day an instant falls on, which the
// licence rule is handed instead of the instant, since a licence expiring on
// the 5th still holds at 23:30 on the 5th in Copenhagen and no longer at
// 00:30 on the 6th, which is the same instant an hour apart in offset; the
// time it reads; and a time of a project's day back as an instant, in the
// offset in force at that time of that day — winter, summer and the two days
// the clocks change in Copenhagen — and a project east of it.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { dayInTimezone, instantOnDay, lastDayInside, timeInTimezone, wallClockIn } from "../clock"

const HOUR = 3600

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

describe("timeInTimezone", () => {
  test("is the time of day on the project's clock, to the minute, on a 24-hour clock", () => {
    assert.equal(timeInTimezone(new Date("2026-07-01T04:00:00Z"), "Europe/Copenhagen"), "06:00")
    assert.equal(timeInTimezone(new Date("2026-12-01T05:00:00Z"), "Europe/Copenhagen"), "06:00", "winter is an hour nearer UTC")
    assert.equal(timeInTimezone(new Date("2026-07-01T22:05:59Z"), "Europe/Copenhagen"), "00:05", "midnight is 00, never 24, and the seconds are dropped")
    assert.equal(timeInTimezone(new Date("2026-07-01T14:32:00Z"), "UTC"), "14:32")
  })

  test("reads the wall clock's every part", () => {
    assert.deepEqual(wallClockIn(new Date("2026-03-29T01:30:45Z"), "Europe/Copenhagen"), { year: 2026, month: 3, day: 29, hour: 3, minute: 30, second: 45 })
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

describe("instantOnDay", () => {
  test("is the time of the day on the project's clock, in winter and in summer", () => {
    assert.equal(instantOnDay("2026-12-01", 7 * HOUR, "Europe/Copenhagen").toISOString(), "2026-12-01T06:00:00.000Z")
    assert.equal(instantOnDay("2026-07-01", 7 * HOUR, "Europe/Copenhagen").toISOString(), "2026-07-01T05:00:00.000Z")
    assert.equal(instantOnDay("2026-07-01", 7 * HOUR + 30 * 60, "Africa/Cairo").toISOString(), "2026-07-01T04:30:00.000Z")
    assert.equal(instantOnDay("2026-07-01", 0, "UTC").toISOString(), "2026-07-01T00:00:00.000Z")
  })

  test("on the days the clocks change, a morning is read in the offset of that morning, not of midnight", () => {
    // Summer time begins at 02:00 on the last Sunday of March: midnight is winter, seven o'clock summer.
    assert.equal(instantOnDay("2026-03-29", 0, "Europe/Copenhagen").toISOString(), "2026-03-28T23:00:00.000Z")
    assert.equal(instantOnDay("2026-03-29", 7 * HOUR, "Europe/Copenhagen").toISOString(), "2026-03-29T05:00:00.000Z")
    // And ends at 03:00 on the last Sunday of October.
    assert.equal(instantOnDay("2026-10-25", 0, "Europe/Copenhagen").toISOString(), "2026-10-24T22:00:00.000Z")
    assert.equal(instantOnDay("2026-10-25", 7 * HOUR, "Europe/Copenhagen").toISOString(), "2026-10-25T06:00:00.000Z")
  })
})
