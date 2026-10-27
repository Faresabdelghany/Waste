// The month a scheduled run bills: the calendar month before the day it
// fires on, first day to last, both inclusive — across a year's end, in a
// leap year, and refused for a day that is not one.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { BILLING_CATCH_UP_MONTHS, catchUpFrom, monthBefore } from "../periods"

describe("monthBefore", () => {
  test("answers the calendar month before the day's, first day to last, both inclusive", () => {
    assert.deepEqual(monthBefore("2026-10-01"), { periodFrom: "2026-09-01", periodTo: "2026-09-30" })
    assert.deepEqual(monthBefore("2026-10-17"), { periodFrom: "2026-09-01", periodTo: "2026-09-30" }, "any day of the month asks for the month before it")
    assert.deepEqual(monthBefore("2026-03-01"), { periodFrom: "2026-02-01", periodTo: "2026-02-28" })
    assert.deepEqual(monthBefore("2028-03-01"), { periodFrom: "2028-02-01", periodTo: "2028-02-29" }, "a leap year's February")
    assert.deepEqual(monthBefore("2026-01-01"), { periodFrom: "2025-12-01", periodTo: "2025-12-31" }, "across the year's end")
  })

  test("refuses a day that is not one", () => {
    for (const bad of ["2026-13-01", "2026-02-30", "October", "2026-10-01T00:00:00Z", ""]) {
      assert.throws(() => monthBefore(bad), /is not a YYYY-MM-DD day/, bad)
    }
  })
})

describe("catchUpFrom", () => {
  test("answers the day twelve months before the period's first, the reach of a run's catch-up (#447)", () => {
    assert.equal(BILLING_CATCH_UP_MONTHS, 12)
    assert.equal(catchUpFrom("2026-10-01"), "2025-10-01")
    assert.equal(catchUpFrom("2026-01-15"), "2025-01-15", "a narrower period reaches back from its own first day")
    assert.equal(catchUpFrom("2028-02-29"), "2027-03-01", "a leap day rolls over as a month's arithmetic does")
  })

  test("refuses a day that is not one", () => {
    assert.throws(() => catchUpFrom("2026-02-30"), /is not a YYYY-MM-DD day/)
  })
})
