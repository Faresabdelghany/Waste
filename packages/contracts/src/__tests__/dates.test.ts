import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { IsoDate, IsoDateTime, IsoTime } from "../dates"

describe("IsoDate", () => {
  test("accepts a calendar day as YYYY-MM-DD", () => {
    assert.equal(IsoDate.parse("2026-09-17"), "2026-09-17")
    assert.ok(IsoDate.safeParse("2024-02-29").success, "leap day")
  })

  test("rejects times, unpadded parts, impossible days and non-strings", () => {
    assert.equal(IsoDate.safeParse("2026-09-17T00:00:00Z").success, false)
    assert.equal(IsoDate.safeParse("2026-9-17").success, false)
    assert.equal(IsoDate.safeParse("2026-02-30").success, false)
    assert.equal(IsoDate.safeParse("17/09/2026").success, false)
    assert.equal(IsoDate.safeParse(new Date()).success, false)
  })
})

describe("IsoDateTime", () => {
  test("accepts an instant with its UTC offset, with or without fractional seconds", () => {
    assert.equal(IsoDateTime.parse("2026-09-17T12:00:00+02:00"), "2026-09-17T12:00:00+02:00")
    assert.ok(IsoDateTime.safeParse("2026-09-17T10:00:00Z").success)
    assert.ok(IsoDateTime.safeParse("2026-09-17T10:00:00.123Z").success)
  })

  test("rejects a wall-clock time without an offset, a bare date and non-strings", () => {
    assert.equal(IsoDateTime.safeParse("2026-09-17T12:00:00").success, false, "no offset")
    assert.equal(IsoDateTime.safeParse("2026-09-17").success, false)
    assert.equal(IsoDateTime.safeParse("2026-09-17 12:00:00Z").success, false, "space separator")
    assert.equal(IsoDateTime.safeParse(1_789_000_000_000).success, false, "epoch millis")
  })
})

describe("IsoTime", () => {
  test("accepts a time of day as HH:MM on the project's clock (#97)", () => {
    assert.equal(IsoTime.parse("06:30"), "06:30")
    assert.ok(IsoTime.safeParse("00:00").success)
    assert.ok(IsoTime.safeParse("23:59").success)
  })

  test("rejects seconds, an offset, an unpadded hour, an impossible time and non-strings", () => {
    assert.equal(IsoTime.safeParse("06:30:00").success, false, "seconds")
    assert.equal(IsoTime.safeParse("06:30:00.000").success, false, "fractional seconds")
    assert.equal(IsoTime.safeParse("06:30Z").success, false, "an offset says something the scheme does not know")
    assert.equal(IsoTime.safeParse("06:30+02:00").success, false, "an offset")
    assert.equal(IsoTime.safeParse("6:30").success, false, "unpadded")
    assert.equal(IsoTime.safeParse("24:00").success, false)
    assert.equal(IsoTime.safeParse("06:60").success, false)
    assert.equal(IsoTime.safeParse("2026-09-17T06:30").success, false, "a date-time")
    assert.equal(IsoTime.safeParse(630).success, false)
  })
})
