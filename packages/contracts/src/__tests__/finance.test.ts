import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  BILLABLE_EVENT_KINDS,
  BILLABLE_EVENT_STATUSES,
  BILLING_RUN_STATUSES,
  BLOCK_REASONS,
  CANCEL_REASONS,
  CREDIT_REASONS,
  EXCLUSION_REASONS,
  INDEX_BASES,
  INVOICE_KINDS,
  SETTLEMENT_EVENT_KINDS,
  SETTLEMENT_STATUSES,
  WEIGHT_REVIEW_DECISIONS,
  WEIGHT_REVIEW_STATUSES,
} from "@waste/domain/finance/vocabulary"

import {
  BillableEventKind,
  BillableEventStatus,
  BillingRunStatus,
  BlockReason,
  CancelReason,
  CREDIT_NOTE_NUMBER_PREFIX,
  CreditReason,
  ExclusionReason,
  IndexBase,
  INVOICE_NUMBER_PREFIX,
  InvoiceKind,
  invoiceLabel,
  SettlementEventKind,
  SettlementStatus,
  WeightReviewDecision,
  WeightReviewState,
  WeightReviewStatus,
} from "../finance"
import { Minor, NonNegativeMinor } from "../resource"
import { refusal } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"

describe("the Finance enums", () => {
  test("are the vocabulary the database checks against, value for value and in the same order", () => {
    assert.deepEqual(BillableEventKind.options, [...BILLABLE_EVENT_KINDS])
    assert.deepEqual(BlockReason.options, [...BLOCK_REASONS])
    assert.deepEqual(CancelReason.options, [...CANCEL_REASONS])
    assert.deepEqual(BillableEventStatus.options, [...BILLABLE_EVENT_STATUSES])
    assert.deepEqual(BillingRunStatus.options, [...BILLING_RUN_STATUSES])
    assert.deepEqual(ExclusionReason.options, [...EXCLUSION_REASONS])
    assert.deepEqual(InvoiceKind.options, [...INVOICE_KINDS])
    assert.deepEqual(CreditReason.options, [...CREDIT_REASONS])
    assert.deepEqual(SettlementStatus.options, [...SETTLEMENT_STATUSES])
    assert.deepEqual(SettlementEventKind.options, [...SETTLEMENT_EVENT_KINDS])
    assert.deepEqual(WeightReviewDecision.options, [...WEIGHT_REVIEW_DECISIONS])
    assert.deepEqual(WeightReviewStatus.options, [...WEIGHT_REVIEW_STATUSES])
    assert.deepEqual(IndexBase.options, [...INDEX_BASES])
  })

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

describe("the invoice label", () => {
  test("is the number under the kind's prefix: one series, two prefixes", () => {
    assert.equal(INVOICE_NUMBER_PREFIX, "INV-")
    assert.equal(CREDIT_NOTE_NUMBER_PREFIX, "CN-")
    assert.equal(invoiceLabel("invoice", 26007188), "INV-26007188")
    assert.equal(invoiceLabel("credit-note", 26007189), "CN-26007189")
    assert.equal(invoiceLabel("invoice", 7), "INV-7")
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

describe("Minor and NonNegativeMinor", () => {
  test("money is a whole number of minor units: Minor takes either sign, NonNegativeMinor zero or more, neither a decimal", () => {
    for (const value of [0, 1, 12_345, -1, -12_345]) assert.equal(Minor.parse(value), value, String(value))
    for (const value of [0, 1, 12_345]) assert.equal(NonNegativeMinor.parse(value), value, String(value))
    for (const value of [-1, -12_345]) assert.equal(NonNegativeMinor.safeParse(value).success, false, `${value} is not a price`)
    for (const value of [1.5, -0.5, "100", Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(Minor.safeParse(value).success, false, String(value))
      assert.equal(NonNegativeMinor.safeParse(value).success, false, String(value))
    }
  })
})
