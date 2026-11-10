import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { BillableEventStatus, BlockReason, IndexBase, SettlementStatus, WeightReviewState, WeightReviewStatus } from "../finance"
import { Minor, NonNegativeInt, NonNegativeMinor } from "../resource"
import { refusal } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"

describe("the Finance enums", () => {
  test("refuse the prototype's display strings and the readings that are never stored", () => {
    assert.equal(BillableEventStatus.safeParse("In progress").success, false, "the deferred recurring event's")
    assert.equal(BillableEventStatus.safeParse("in-progress").success, false)
    assert.equal(BlockReason.safeParse("missing-payer").success, false, "a payer is NOT NULL on the agreement")
    assert.equal(SettlementStatus.safeParse("under-review").success, false, "a reading of disputes")
    assert.equal(SettlementStatus.safeParse("reopened").success, false, "an open settlement whose history has a reopened row")
    assert.equal(WeightReviewStatus.safeParse("needs-review").success, false, "the prototype's Needs review is captured")
    assert.equal(WeightReviewStatus.safeParse("captured").success, true)
    assert.equal(IndexBase.safeParse("current fee").success, false, "the prototype's spelling; the token is current-fee")
    assert.equal(IndexBase.safeParse("current-fee").success, true)
  })
})

describe("WeightReviewState", () => {
  test("is the reading an unload carries: captured with two nulls where nobody has looked, the decision with the review and the correction it wrote", () => {
    assert.deepEqual(WeightReviewState.parse({ status: "captured", latestReviewId: null, correctionUnloadId: null }), { status: "captured", latestReviewId: null, correctionUnloadId: null })
    assert.deepEqual(WeightReviewState.parse({ status: "corrected", latestReviewId: ID, correctionUnloadId: OTHER }), { status: "corrected", latestReviewId: ID, correctionUnloadId: OTHER })
    assert.deepEqual(refusal(WeightReviewState.safeParse({ status: "needs-review", latestReviewId: null, correctionUnloadId: null })).map((issue) => issue.path), ["status"])
    assert.deepEqual(refusal(WeightReviewState.safeParse({ status: "approved" })).map((issue) => issue.path).sort(), ["correctionUnloadId", "latestReviewId"], "never null itself, and its two ids are given, null or not")
  })
})

describe("Minor, NonNegativeMinor and NonNegativeInt", () => {
  test("money is a whole number of minor units: Minor takes either sign, NonNegativeMinor zero or more, neither a decimal; a count is NonNegativeInt, the one spelling a price shares", () => {
    for (const value of [0, 1, 12_345, -1, -12_345]) assert.equal(Minor.parse(value), value, String(value))
    for (const value of [0, 1, 12_345]) assert.equal(NonNegativeMinor.parse(value), value, String(value))
    for (const value of [-1, -12_345]) assert.equal(NonNegativeMinor.safeParse(value).success, false, `${value} is not a price`)
    assert.equal(NonNegativeMinor, NonNegativeInt, "a price is the non-negative integer under the name it reads by")
    for (const value of [0, 7]) assert.equal(NonNegativeInt.parse(value), value, String(value))
    for (const value of [-1, 1.5]) assert.equal(NonNegativeInt.safeParse(value).success, false, `${value} is not a count`)
    for (const value of [1.5, -0.5, "100", Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(Minor.safeParse(value).success, false, String(value))
      assert.equal(NonNegativeMinor.safeParse(value).success, false, String(value))
    }
  })
})
