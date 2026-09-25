import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { WEIGHT_REVIEW_DECISIONS } from "@waste/domain/finance/vocabulary"

import { BOTH_GROSS_AND_TARE, NET_IS_GROSS_LESS_TARE, UnloadCreate } from "../unloads"
import { CORRECTION_NAMES_ITS_UNLOAD, correctionShape, WeightApprove, WeightCorrect, WeightReject, WeightReview, WeightReviewListQuery, WeightReviewState } from "../weight-control"
import { refusal } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const WHEN = "2026-10-05T14:00:00.000Z"

const review = { id: ID, recordedAt: WHEN, projectId: OTHER, unloadId: THIRD, decision: "approved", note: null, correctionUnloadId: null, reviewedBy: OTHER }

describe("WeightReview", () => {
  test("is a ledger row per decision — an id and recordedAt, never updatedAt — approved, rejected with a note, or corrected naming the new unload", () => {
    assert.deepEqual(WeightReview.parse(review), review)
    const rejected = { ...review, decision: "rejected", note: "The ticket photo is unreadable" }
    assert.deepEqual(WeightReview.parse(rejected), rejected)
    const corrected = { ...review, decision: "corrected", correctionUnloadId: ID, note: "Tare read off the wrong truck" }
    assert.deepEqual(WeightReview.parse(corrected), corrected)
    assert.equal("updatedAt" in WeightReview.shape, false)
    for (const decision of WEIGHT_REVIEW_DECISIONS) assert.equal(WeightReview.safeParse({ ...review, decision, correctionUnloadId: decision === "corrected" ? ID : null }).success, true, decision)
  })

  test("holds a correction to naming the new unload and never the reviewed one, and the other two to naming none", () => {
    assert.deepEqual(refusal(WeightReview.safeParse({ ...review, decision: "corrected" })), [{ path: "correctionUnloadId", message: CORRECTION_NAMES_ITS_UNLOAD }], "a correction without its unload")
    assert.deepEqual(refusal(WeightReview.safeParse({ ...review, correctionUnloadId: ID })), [{ path: "correctionUnloadId", message: CORRECTION_NAMES_ITS_UNLOAD }], "an approval naming one")
    assert.deepEqual(refusal(WeightReview.safeParse({ ...review, decision: "corrected", correctionUnloadId: THIRD })), [{ path: "correctionUnloadId", message: CORRECTION_NAMES_ITS_UNLOAD }], "the reviewed unload itself")
    assert.equal(correctionShape({ decision: "corrected", unloadId: THIRD, correctionUnloadId: ID }), true)
    assert.equal(correctionShape({ decision: "approved", unloadId: THIRD, correctionUnloadId: null }), true)
    assert.equal(correctionShape({ decision: "corrected", unloadId: THIRD, correctionUnloadId: null }), false)
    assert.equal(correctionShape({ decision: "rejected", unloadId: THIRD, correctionUnloadId: ID }), false)
    assert.equal(correctionShape({ decision: "corrected", unloadId: THIRD, correctionUnloadId: THIRD }), false)
    assert.deepEqual(refusal(WeightReview.safeParse({ ...review, decision: "needs-review" })).map((issue) => issue.path), ["decision"])
  })

  test("the state beside an unload is re-exported here and read as finance.ts spells it", () => {
    assert.deepEqual(WeightReviewState.parse({ status: "captured", latestReviewId: null, correctionUnloadId: null }), { status: "captured", latestReviewId: null, correctionUnloadId: null })
  })
})

describe("the three commands", () => {
  test("approve takes a note if any, reject the note that says why", () => {
    assert.deepEqual(WeightApprove.parse({}), {})
    assert.deepEqual(WeightApprove.parse({ note: "Matches the ticket" }), { note: "Matches the ticket" })
    assert.deepEqual(refusal(WeightApprove.safeParse({ decision: "approved" })).map((issue) => issue.path), [""])
    assert.deepEqual(WeightReject.parse({ note: "The ticket photo is unreadable" }), { note: "The ticket photo is unreadable" })
    assert.deepEqual(refusal(WeightReject.safeParse({})).map((issue) => issue.path), ["note"])
    assert.deepEqual(refusal(WeightReject.safeParse({ note: "  " })).map((issue) => issue.path), ["note"])
  })

  test("correct takes the new unload's weights under the rule the office's capture carries, the station's ticket, and the note that says what was wrong", () => {
    const body = { netKg: 4_200, grossKg: 12_400, tareKg: 8_200, weighbridgeTicket: "WB-2026-3902", note: "Tare read off the wrong truck" }
    assert.deepEqual(WeightCorrect.parse(body), body)
    assert.deepEqual(WeightCorrect.parse({ netKg: 4_200, note: "Net only" }), { netKg: 4_200, note: "Net only" })
    assert.deepEqual(refusal(WeightCorrect.safeParse({ netKg: 4_200 })).map((issue) => issue.path), ["note"], "a correction says what was wrong")
    assert.deepEqual(refusal(WeightCorrect.safeParse({ ...body, tareKg: undefined })), [{ path: "tareKg", message: BOTH_GROSS_AND_TARE }])
    assert.deepEqual(refusal(WeightCorrect.safeParse({ ...body, netKg: 4_000 })), [{ path: "netKg", message: NET_IS_GROSS_LESS_TARE }])
    assert.deepEqual(refusal(WeightCorrect.safeParse({ ...body, netKg: 0 })).map((issue) => issue.path), ["netKg", "netKg"], "zero is refused as a count and as the sum")
    for (const key of ["unloadingStationId", "wasteFractionId", "occurredAt", "routeId", "source", "decision"]) {
      assert.match(refusal(WeightCorrect.safeParse({ ...body, [key]: ID }))[0].message, new RegExp(key), `${key}: the same route, station, fraction and instant, so none is given`)
    }
  })

  test("the weights refine agrees with UnloadCreate's, case for case", () => {
    const capture = { unloadingStationId: OTHER, wasteFractionId: THIRD, occurredAt: WHEN }
    for (const weights of [
      { netKg: 4_200, grossKg: 12_400, tareKg: 8_200 },
      { netKg: 4_200 },
      { netKg: 4_200, grossKg: 12_400 },
      { netKg: 4_200, tareKg: 8_200 },
      { netKg: 4_000, grossKg: 12_400, tareKg: 8_200 },
      { netKg: 200, grossKg: 8_000, tareKg: 8_200 },
      { netKg: 0 },
    ]) {
      const corrected = WeightCorrect.safeParse({ ...weights, note: "x" })
      const captured = UnloadCreate.safeParse({ ...weights, ...capture })
      assert.equal(corrected.success, captured.success, JSON.stringify(weights))
      if (!corrected.success && !captured.success) assert.deepEqual(refusal(corrected), refusal(captured), JSON.stringify(weights))
    }
  })
})

describe("WeightReviewListQuery", () => {
  test("pages one unload's reviews: the path says the unload, so the page is the only parameter", () => {
    assert.deepEqual(WeightReviewListQuery.parse({}), { limit: 50 })
    assert.deepEqual(WeightReviewListQuery.parse({ limit: "10" }), { limit: 10 })
    assert.equal("projectId" in WeightReviewListQuery.shape, false)
  })
})
