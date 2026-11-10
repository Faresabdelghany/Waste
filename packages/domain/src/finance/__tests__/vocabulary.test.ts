// The Finance vocabulary, held to the shape every vocabulary module keeps
// (src/__tests__/vocabulary.ts), and to the rules of its own: the prototype's
// "In progress", "Needs review", "Under review" and "Reopened" are no
// statuses; the open settlement statuses are a value of the status list; the
// block reasons never name a missing payer; and the office cancels with its
// own reasons, never a consumer's.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("Finance", vocabulary, vocabulary.FINANCE_VOCABULARIES, { OPEN_SETTLEMENT_STATUSES: "SETTLEMENT_STATUSES", OFFICE_CANCEL_REASONS: "CANCEL_REASONS" })

describe("the Finance vocabulary's own rules", () => {
  test("a billable event is made of four kinds, stands in five readings and is blocked for one of six actionable reasons — never a missing payer", () => {
    assert.equal((vocabulary.BILLABLE_EVENT_STATUSES as readonly string[]).includes("in-progress"), false, "the deferred recurring event's")
    assert.equal((vocabulary.BLOCK_REASONS as readonly string[]).includes("missing-payer"), false, "a payer is NOT NULL on the agreement")
    assert.deepEqual([...vocabulary.OFFICE_CANCEL_REASONS], ["duplicate", "not-delivered", "other"], "the office cancels with its own three")
  })

  test("a settlement stands in three statuses, the open two a value of the list, and its history has three kinds", () => {
    for (const status of vocabulary.SETTLEMENT_STATUSES) {
      assert.equal(vocabulary.isOpenSettlementStatus(status), status !== "closed", status)
    }
    for (const notAStatus of ["under-review", "reopened"]) assert.equal((vocabulary.SETTLEMENT_STATUSES as readonly string[]).includes(notAStatus), false, `${notAStatus} is a reading`)
  })

  test("a weight is judged by three decisions and read in four statuses, captured being no decision yet; an indexation multiplies the bid or the current fee", () => {
    assert.deepEqual([...vocabulary.WEIGHT_REVIEW_STATUSES], ["captured", ...vocabulary.WEIGHT_REVIEW_DECISIONS])
    assert.equal((vocabulary.WEIGHT_REVIEW_STATUSES as readonly string[]).includes("needs-review"), false, "the prototype's Needs review is captured")
  })
})
