import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { IsoDate, IsoDateTime } from "../dates"

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
