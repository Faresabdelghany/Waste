// The half-open period of ADR-0005 (periods.ts): `validTo` is the first day
// out, so a period ending on the 1st was last in force on the 31st.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { firstDayOut, inForceOn, lastDayIn, periodOn } from "../periods"

const october = { validFrom: "2026-10-01", validTo: "2026-11-01" }

describe("periodOn", () => {
  test("reads a period against a day: not begun before its first day, ended from its first day out", () => {
    assert.equal(periodOn(october, "2026-09-30"), "upcoming")
    assert.equal(periodOn(october, "2026-10-01"), "in-force")
    assert.equal(periodOn(october, "2026-10-31"), "in-force")
    assert.equal(periodOn(october, "2026-11-01"), "ended")
    assert.equal(periodOn({ validFrom: "2026-10-01", validTo: null }, "2099-01-01"), "in-force", "an open-ended period never ends")
  })

  test("inForceOn is the in-force reading", () => {
    for (const day of ["2026-09-30", "2026-10-01", "2026-10-31", "2026-11-01"]) assert.equal(inForceOn(october, day), periodOn(october, day) === "in-force", day)
  })
})

describe("lastDayIn and firstDayOut", () => {
  test("convert between the wire's first day out and the last day a person reads", () => {
    assert.equal(lastDayIn("2026-11-01"), "2026-10-31")
    assert.equal(firstDayOut("2026-10-31"), "2026-11-01")
    assert.equal(lastDayIn("2028-03-01"), "2028-02-29")
  })
})
