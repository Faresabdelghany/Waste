// The due-from-last cadence of a tank installation (M11 of #293): an emptying
// falls due a number of months after the last one, not on a calendar's day,
// and generation plans it once, on the first service date on or after that.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { addMonths, tankDueOn, tankWaits } from "../due-from-last"

describe("addMonths", () => {
  test("moves by calendar months, and a day the month lacks lands on its last day", () => {
    assert.equal(addMonths("2026-03-15", 12), "2027-03-15")
    assert.equal(addMonths("2026-11-30", 3), "2027-02-28", "30 February is not a day: its month's last is")
    assert.equal(addMonths("2027-11-30", 3), "2028-02-29", "a leap year's February has a 29th")
    assert.equal(addMonths("2026-01-31", 1), "2026-02-28")
    assert.equal(addMonths("2026-12-31", 24), "2028-12-31")
  })
})

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
