// Counting rules (#547 of #544): the period a day lies in, the names a
// person reads a period by, a simulation's window widened to whole periods
// and cut into them, and the words of the ticket a rule opens.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { countedWhat, countingTicketText, periodName, periodOf, periodsOver, SIMULATION_DAYS_MAX, simulationWindowIssue, wholePeriods } from "../counting-rules"

describe("the period a day lies in", () => {
  test("a month runs from its first day to the next month's", () => {
    assert.deepEqual(periodOf("2026-03-17", "month"), { from: "2026-03-01", to: "2026-04-01" })
    assert.deepEqual(periodOf("2026-12-31", "month"), { from: "2026-12-01", to: "2027-01-01" })
    assert.deepEqual(periodOf("2028-02-29", "month"), { from: "2028-02-01", to: "2028-03-01" })
  })

  test("a quarter starts in January, April, July or October", () => {
    assert.deepEqual(periodOf("2026-01-01", "quarter"), { from: "2026-01-01", to: "2026-04-01" })
    assert.deepEqual(periodOf("2026-06-30", "quarter"), { from: "2026-04-01", to: "2026-07-01" })
    assert.deepEqual(periodOf("2026-11-05", "quarter"), { from: "2026-10-01", to: "2027-01-01" })
  })

  test("a year is the calendar's", () => {
    assert.deepEqual(periodOf("2026-07-04", "year"), { from: "2026-01-01", to: "2027-01-01" })
  })

  test("a day that is not one is refused", () => {
    assert.throws(() => periodOf("2026-13-01", "month"))
  })
})

describe("a period's name", () => {
  test("is its month, its quarter or its year", () => {
    assert.equal(periodName("2026-03-01", "month"), "March 2026")
    assert.equal(periodName("2026-10-01", "quarter"), "Q4 2026")
    assert.equal(periodName("2026-01-01", "year"), "2026")
  })
})

describe("a simulation's window", () => {
  test("is widened to whole periods, its last day's period included", () => {
    assert.deepEqual(wholePeriods({ from: "2025-11-06", to: "2026-11-07" }, "month"), { from: "2025-11-01", to: "2026-12-01" })
    assert.deepEqual(wholePeriods({ from: "2026-01-01", to: "2026-04-01" }, "quarter"), { from: "2026-01-01", to: "2026-04-01" })
    assert.deepEqual(wholePeriods({ from: "2025-11-06", to: "2026-11-07" }, "year"), { from: "2025-01-01", to: "2027-01-01" })
  })

  test("is cut into its periods in order", () => {
    assert.deepEqual(periodsOver({ from: "2025-11-01", to: "2026-02-01" }, "month"), [
      { from: "2025-11-01", to: "2025-12-01" },
      { from: "2025-12-01", to: "2026-01-01" },
      { from: "2026-01-01", to: "2026-02-01" },
    ])
    assert.equal(periodsOver({ from: "2024-01-01", to: "2027-01-01" }, "quarter").length, 12)
  })

  test("runs forwards and looks back at most three years", () => {
    assert.equal(simulationWindowIssue({ from: "2026-01-01", to: "2026-01-01" }), "The window ends before it starts; `to` is the first day not counted")
    assert.equal(simulationWindowIssue({ from: "2023-11-01", to: "2026-11-01" }), undefined)
    assert.equal(simulationWindowIssue({ from: "2023-01-01", to: "2026-11-01" }), `A simulation looks back at most ${SIMULATION_DAYS_MAX} days`)
  })
})

describe("the ticket a rule opens", () => {
  test("is headed by the rule's name and says what was counted, when and against what", () => {
    const text = countingTicketText({ name: "Emptied too often", limit: 12, period: "quarter" }, { count: 12, periodFrom: "2026-04-01" }, { wasteFraction: "Residual waste", containerType: null })
    assert.equal(text.subject, "Emptied too often")
    assert.equal(text.description, '12 completed emptyings of Residual waste at this property in Q2 2026 reached the counting rule "Emptied too often", whose limit is 12 a quarter.')
  })

  test("names one emptying in the singular", () => {
    assert.equal(countedWhat({ wasteFraction: null, containerType: "240 L" }, 1), "completed emptying in 240 L containers")
    assert.equal(countedWhat({ wasteFraction: null, containerType: null }), "completed emptyings")
  })
})
