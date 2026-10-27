// Apply index over many prices (#291 C8): which rows move, at what price,
// and why the rest stay.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { indexedOf, planIndexation, type IndexableRow } from "../indexation"
import { MINOR_MAX } from "../money"

const row = (id: string, validFrom: string, validTo: string | null, unitPriceMinor: number, more: Partial<IndexableRow> = {}): IndexableRow => ({
  id,
  validFrom,
  validTo,
  baseMinor: unitPriceMinor,
  unitPriceMinor,
  productActive: true,
  ...more,
})

describe("planIndexation", () => {
  test("a row in force on the day is indexed at indexedFee over its base, half away from zero", () => {
    const plan = planIndexation([row("a", "2026-01-01", null, 10_050), row("b", "2026-01-01", "2028-01-01", 333)], "2027-01-01", 320)
    assert.deepEqual(plan.verdicts, [
      { id: "a", outcome: "indexed", fromMinor: 10_050, toMinor: 10_372 },
      { id: "b", outcome: "indexed", fromMinor: 333, toMinor: 344 },
    ])
    assert.equal(plan.outOfRange, undefined)
  })

  test("the base is what is multiplied, the price is what the line reads before", () => {
    const plan = planIndexation([row("a", "2026-01-01", null, 12_000, { baseMinor: 10_000 })], "2027-01-01", 500)
    assert.deepEqual(plan.verdicts, [{ id: "a", outcome: "indexed", fromMinor: 12_000, toMinor: 10_500 }])
  })

  test("a row that ended on or before the day is not in the plan; one ending after it is", () => {
    const plan = planIndexation([row("over", "2026-01-01", "2027-01-01", 100), row("tail", "2026-01-01", "2027-01-02", 100)], "2027-01-01", 1_000)
    assert.deepEqual(
      plan.verdicts.map((verdict) => verdict.id),
      ["tail"],
    )
  })

  test("a row starting on the day, starting later, or of a product no longer active is skipped with its reason", () => {
    const plan = planIndexation(
      [row("today", "2027-01-01", null, 100), row("later", "2027-03-01", null, 100), row("retired", "2026-01-01", null, 100, { productActive: false })],
      "2027-01-01",
      500,
    )
    assert.deepEqual(plan.verdicts, [
      { id: "today", outcome: "skipped", fromMinor: 100, reason: "starts-on-index-day" },
      { id: "later", outcome: "skipped", fromMinor: 100, reason: "scheduled" },
      { id: "retired", outcome: "skipped", fromMinor: 100, reason: "product-not-active" },
    ])
    assert.deepEqual(indexedOf(plan), [])
  })

  test("a deflator rounds half away from zero, and -100 % is a free price", () => {
    assert.deepEqual(indexedOf(planIndexation([row("a", "2026-01-01", null, 15)], "2027-01-01", -1_000)), [{ id: "a", outcome: "indexed", fromMinor: 15, toMinor: 14 }])
    assert.deepEqual(indexedOf(planIndexation([row("a", "2026-01-01", null, 15)], "2027-01-01", -10_000)), [{ id: "a", outcome: "indexed", fromMinor: 15, toMinor: 0 }])
  })

  test("a price below zero or past the column names the first row that would not do", () => {
    assert.deepEqual(planIndexation([row("a", "2026-01-01", null, 0), row("b", "2026-01-01", null, 100)], "2027-01-01", -20_000).outOfRange, { id: "b", problem: "below-zero", toMinor: -100 })
    assert.deepEqual(planIndexation([row("a", "2026-01-01", null, MINOR_MAX)], "2027-01-01", 1).outOfRange, { id: "a", problem: "too-large", toMinor: 2_147_698_395 })
  })

  test("a skipped row's price is never judged out of range", () => {
    assert.equal(planIndexation([row("a", "2027-01-01", null, MINOR_MAX)], "2027-01-01", 10_000).outOfRange, undefined)
  })
})
