// The due-from-last cadence of a tank installation (M11 of #293): an emptying
// falls due a number of months after the last one, not on a calendar's day,
// and generation plans it once, on the first service date on or after that.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { tankDueOn, tankWaits } from "../due-from-last"

describe("tankDueOn", () => {
  test("is the last emptying plus the installation's interval", () => {
    assert.equal(tankDueOn({ lastEmptiedOn: "2026-05-04", intervalMonths: 12 }), "2027-05-04")
    assert.equal(tankDueOn({ lastEmptiedOn: "2026-05-04", intervalMonths: 24 }), "2028-05-04", "a holiday home's longer interval")
  })

  test("is null for a tank never emptied: it is due now", () => {
    assert.equal(tankDueOn({ lastEmptiedOn: null, intervalMonths: 12 }), null)
  })
})

describe("tankWaits", () => {
  const tank = { lastEmptiedOn: "2026-05-04", intervalMonths: 12 }
  const none: ReadonlySet<string> = new Set()

  test("a container that is no tank never waits", () => {
    assert.equal(tankWaits({ containerId: "c1", tank: null }, { day: "2026-06-01", held: none }), false)
  })

  test("a tank waits before its due date, and is wanted from it on", () => {
    assert.equal(tankWaits({ containerId: "c1", tank }, { day: "2027-05-03", held: none }), true)
    assert.equal(tankWaits({ containerId: "c1", tank }, { day: "2027-05-04", held: none }), false)
    assert.equal(tankWaits({ containerId: "c1", tank }, { day: "2027-09-01", held: none }), false, "overdue is wanted")
    assert.equal(tankWaits({ containerId: "c1", tank: { lastEmptiedOn: null, intervalMonths: 12 } }, { day: "2026-06-01", held: none }), false, "never emptied is due now")
  })

  test("a due tank with a stop held on an earlier date waits: one emptying is planned once", () => {
    assert.equal(tankWaits({ containerId: "c1", tank }, { day: "2027-06-01", held: new Set(["c1"]) }), true)
    assert.equal(tankWaits({ containerId: "c2", tank }, { day: "2027-06-01", held: new Set(["c1"]) }), false)
  })
})
