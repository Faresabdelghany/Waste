// `instantOnDay` (O8 of #290): a time of a project's day as an instant, in
// the offset in force at that time of that day — winter, summer and the two
// days the clocks change in Copenhagen — and a project east of it. No
// database.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { instantOnDay } from "../commands/days"

const HOUR = 3600

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
