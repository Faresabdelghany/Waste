// Indexation as the office types and reads it (#291 C8).
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { INDEX_SKIP_REASONS } from "@waste/domain/finance/vocabulary"

import { basisPointsOf, indexSummary, percentLabel, SKIP_SENTENCES } from "../indexation"

const line = (skipped: (typeof INDEX_SKIP_REASONS)[number] | null) => ({ id: "a", productId: "p", fromMinor: 100, toMinor: skipped === null ? 103 : null, indexedId: null, skipped })

describe("indexation as typed and read", () => {
  test("a percent becomes basis points by its digits, and back", () => {
    assert.deepEqual(["3.2", "3,2", "-1.25", "0.05", "10"].map(basisPointsOf), [320, 320, -125, 5, 1_000])
    for (const text of ["", "3%", "1.234", "+3", "x"]) assert.ok(Number.isNaN(basisPointsOf(text)), text)
    assert.deepEqual([320, -125, 1_000, 0].map(percentLabel), ["+3.2%", "-1.25%", "+10%", "+0%"])
  })

  test("every reason a row stays has its sentence", () => {
    assert.deepEqual(Object.keys(SKIP_SENTENCES).sort(), [...INDEX_SKIP_REASONS].sort())
  })

  test("a plan in a sentence: what moves and what stays", () => {
    assert.equal(indexSummary({ lines: [] }), "No price is in force on that day or after it.")
    assert.equal(indexSummary({ lines: [line(null)] }), "1 price moves.")
    assert.equal(indexSummary({ lines: [line(null), line(null), line("scheduled")] }), "2 prices move; 1 price stays as it is.")
    assert.equal(indexSummary({ lines: [line("scheduled"), line("starts-on-index-day")] }), "0 prices move; 2 prices stay as they are.")
  })
})
