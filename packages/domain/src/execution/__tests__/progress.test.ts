import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { countPickups, progressOf } from "../progress"

describe("progressOf", () => {
  test("fills every status, sums the total, and reads the fraction as the pickups with an outcome over all of them", () => {
    assert.deepEqual(progressOf({ planned: 28, completed: 10, skipped: 1, failed: 1 }), { planned: 28, completed: 10, skipped: 1, failed: 1, total: 40, fraction: 0.3 })
    assert.deepEqual(progressOf({ completed: 3 }), { planned: 0, completed: 3, skipped: 0, failed: 0, total: 3, fraction: 1 })
    assert.deepEqual(progressOf({ planned: 5 }), { planned: 5, completed: 0, skipped: 0, failed: 0, total: 5, fraction: 0 })
  })

  test("a route without pickups is done at zero, not divided by zero", () => {
    assert.deepEqual(progressOf({}), { planned: 0, completed: 0, skipped: 0, failed: 0, total: 0, fraction: 0 })
  })

  test("a route whose driver ended the day with stops left reads as finished, the skipped stops counted", () => {
    assert.equal(progressOf({ completed: 30, skipped: 10 }).fraction, 1)
  })

  test("countPickups is the fold's other half: a list of rows into the counts", () => {
    assert.deepEqual(countPickups([{ status: "planned" }, { status: "completed" }, { status: "completed" }, { status: "failed" }]), { planned: 1, completed: 2, skipped: 0, failed: 1 })
    assert.deepEqual(progressOf(countPickups([])), progressOf({}))
  })
})
