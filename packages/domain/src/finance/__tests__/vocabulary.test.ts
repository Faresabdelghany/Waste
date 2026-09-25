// The Finance vocabulary, held to the shape every vocabulary module keeps
// (src/__tests__/vocabulary.ts), and to four things of its own: the two
// statuses that are readings are spelled as the spec spells them, with the
// prototype's "In progress" and "Needs review" folded into the deferred
// recurring event and into `captured`; the open settlement statuses are a
// value of the status list; the block reasons are the six actionable ones and
// never a missing payer; and the cancel reasons put the consumer's first.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("Finance", vocabulary, vocabulary.FINANCE_VOCABULARIES, 13, ["OPEN_SETTLEMENT_STATUSES"])

describe("the Finance vocabulary's own rules", () => {
  test("a billable event is made of four kinds, stands in five readings and is blocked for one of six actionable reasons — never a missing payer", () => {
    assert.deepEqual([...vocabulary.BILLABLE_EVENT_KINDS], ["pickup", "ticket", "manual", "reversal"])
    assert.deepEqual([...vocabulary.BILLABLE_EVENT_STATUSES], ["blocked", "ready", "invoiced", "cancelled", "reversed"])
    assert.equal((vocabulary.BILLABLE_EVENT_STATUSES as readonly string[]).includes("in-progress"), false, "the deferred recurring event's")
    assert.deepEqual([...vocabulary.BLOCK_REASONS], ["no-subscription", "agreement-draft", "no-price-list", "no-price-row", "no-product", "no-vat-rate"])
    assert.equal((vocabulary.BLOCK_REASONS as readonly string[]).includes("missing-payer"), false, "a payer is NOT NULL on the agreement")
    assert.deepEqual([...vocabulary.CANCEL_REASONS], ["pickup-corrected", "duplicate", "not-delivered", "other"])
    assert.equal(vocabulary.CANCEL_REASONS[0], "pickup-corrected", "the consumer's reason comes first; the office's three follow")
  })

  test("a run stands in three statuses and excludes a payer for one reason; a document is an invoice or a credit note, credited for one of the prototype's five reasons", () => {
    assert.deepEqual([...vocabulary.BILLING_RUN_STATUSES], ["requested", "completed", "failed"])
    assert.deepEqual([...vocabulary.EXCLUSION_REASONS], ["all-events-blocked"])
    assert.deepEqual([...vocabulary.INVOICE_KINDS], ["invoice", "credit-note"])
    assert.deepEqual([...vocabulary.CREDIT_REASONS], ["service-not-delivered", "quantity-correction", "price-correction", "duplicate", "other"])
  })

  test("a settlement stands in three statuses, the open two a value of the list, and its history has three kinds", () => {
    assert.deepEqual([...vocabulary.SETTLEMENT_STATUSES], ["open", "calculated", "closed"])
    assert.deepEqual([...vocabulary.OPEN_SETTLEMENT_STATUSES], ["open", "calculated"])
    for (const status of vocabulary.SETTLEMENT_STATUSES) {
      assert.equal(vocabulary.isOpenSettlementStatus(status), status !== "closed", status)
    }
    for (const notAStatus of ["under-review", "reopened"]) assert.equal((vocabulary.SETTLEMENT_STATUSES as readonly string[]).includes(notAStatus), false, `${notAStatus} is a reading`)
    assert.deepEqual([...vocabulary.SETTLEMENT_EVENT_KINDS], ["calculated", "closed", "reopened"])
  })

  test("a weight is judged by three decisions and read in four statuses, captured being no decision yet; an indexation multiplies the bid or the current fee", () => {
    assert.deepEqual([...vocabulary.WEIGHT_REVIEW_DECISIONS], ["approved", "rejected", "corrected"])
    assert.deepEqual([...vocabulary.WEIGHT_REVIEW_STATUSES], ["captured", ...vocabulary.WEIGHT_REVIEW_DECISIONS])
    assert.equal((vocabulary.WEIGHT_REVIEW_STATUSES as readonly string[]).includes("needs-review"), false, "the prototype's Needs review is captured")
    assert.deepEqual([...vocabulary.INDEX_BASES], ["bid", "current-fee"])
  })
})
