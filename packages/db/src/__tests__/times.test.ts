// How the wire spells a row's time (Issue #97): a `time` column's value, the
// stamps and a nullable instant. No database.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { IsoTime } from "@waste/contracts/dates"

import { instantOf, stampsOf, timeOf } from "../shapes/times"

describe("timeOf", () => {
  test("drops the seconds Postgres spells a time with, so the value is the contracts' IsoTime", () => {
    assert.equal(timeOf("06:30:00"), "06:30")
    assert.equal(timeOf("23:59:59"), "23:59")
    assert.equal(timeOf("06:30:00.5"), "06:30", "fractional seconds go too")
    for (const value of ["06:30:00", "00:00:00"]) assert.ok(IsoTime.safeParse(timeOf(value)).success, value)
  })

  test("passes a time already spelled HH:MM through", () => {
    assert.equal(timeOf("06:30"), "06:30")
  })

  test("throws on anything that is not a time of day, since that is a statement's bug and not a client's", () => {
    for (const value of ["", "6:30:00", "06:30:00+02:00", "2026-09-25T06:30:00", "morning"]) {
      assert.throws(() => timeOf(value), /timeOf: .* is not a time of day as Postgres spells one \(HH:MM:SS\)/, value)
    }
  })
})

describe("stampsOf", () => {
  test("spells the two instants as RFC 3339 in UTC", () => {
    const at = new Date("2026-09-25T06:30:00.000+02:00")
    assert.deepEqual(stampsOf({ createdAt: at, updatedAt: at }), { createdAt: "2026-09-25T04:30:00.000Z", updatedAt: "2026-09-25T04:30:00.000Z" })
  })
})

describe("instantOf", () => {
  test("spells a nullable instant as RFC 3339 in UTC, and null as null", () => {
    assert.equal(instantOf(new Date("2026-09-25T06:30:00.000+02:00")), "2026-09-25T04:30:00.000Z")
    assert.equal(instantOf(null), null)
  })
})
