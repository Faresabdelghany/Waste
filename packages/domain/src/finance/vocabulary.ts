// Finance & Contracting's closed lists (Issue #112): what a Billable Event
// was made of and why it cannot be invoiced, why a ready one was cancelled,
// where a Billing Run stands and why a payer got no invoice from it, what an
// Invoice is and why a credit note corrects one, where a Settlement stands and
// what a row of its history is, what a review says of an Unload's weight and
// what an indexation multiplied. Like Execution's and Resolution's before it
// (execution/vocabulary.ts, resolution/vocabulary.ts), the database reads each
// list into its `CHECK` (`oneOf` in packages/db/src/schema/checks.ts) and the
// contracts read the same list into a `z.enum`, so the check at the API
// boundary and the check in the column cannot drift.
//
// Two lists are readings and never columns, spelled here as Planning's
// `OCCURRENCE_STATUSES` is: `BILLABLE_EVENT_STATUSES` is what
// finance/readings.ts folds an event's stamps and its invoice line onto —
// `blocked` is a block reason, `cancelled` a cancellation stamp, `invoiced` a
// line naming it, `reversed` a reversal naming it, `ready` none of those; the
// prototype's "In progress" is the deferred recurring event's — and
// `WEIGHT_REVIEW_STATUSES` is the latest review's decision, or `captured`
// when there is none (the prototype's "Needs review"). `BLOCK_REASONS` are
// each actionable: the pickup's container had no placement valid on the day,
// the agreement is not signed, neither the agreement nor the project names a
// list, the list has no row for the product under the event's conditions on
// the day, a ticket's event awaits the office's product, the product has no
// VAT rate; the prototype's "Missing payer" is impossible, a payer being
// `NOT NULL` on the agreement. `CANCEL_REASONS` puts the consumer's reason
// first — a corrected pickup cancels its uninvoiced event with no person —
// and the office's three after it. `BILLING_RUN_STATUSES` is written
// `completed` alone by part A, in the request's transaction; `requested` and
// `failed` are the worker's when a run is scheduled (§7). `CREDIT_REASONS` is
// the prototype's five verbatim as tokens. `SETTLEMENT_STATUSES` is the
// prototype's five less "Under review" (a reading of disputes, deferred) and
// "Reopened" (an open settlement whose history has a `reopened` row);
// `SETTLEMENT_EVENT_KINDS` is what a history row is. `INDEX_BASES` is what an
// indexation multiplied: the locked bid, or the fee it replaced, which
// compounds earlier changes.
//
// One value beside the lists, the way Resolution's `OPEN_TICKET_STATUSES` is
// a value of its list: `OPEN_SETTLEMENT_STATUSES`, the statuses a settlement
// is recalculated in (finance/transitions.ts).
//
// A value is a kebab-case token: it goes into a migration as a SQL literal
// and onto the wire as an enum member, and those are the same string. A list
// is a `readonly` tuple with a type read off it; `FINANCE_VOCABULARIES` names
// them all for the test that walks them.

/** What the occurrence was: a completed pickup, a resolved ticket, a person's entry, or the reversal of an invoiced event a correction undid. */
export const BILLABLE_EVENT_KINDS = ["pickup", "ticket", "manual", "reversal"] as const
/** Why an event cannot be invoiced, each actionable; cleared by `reprice`. */
export const BLOCK_REASONS = ["no-subscription", "agreement-draft", "no-price-list", "no-price-row", "no-product", "no-vat-rate"] as const
/** Why a ready event was cancelled: the consumer's reason first, the office's three after it. */
export const CANCEL_REASONS = ["pickup-corrected", "duplicate", "not-delivered", "other"] as const
/** Where a Billable Event stands: a reading over its stamps and its invoice line, never a column. */
export const BILLABLE_EVENT_STATUSES = ["blocked", "ready", "invoiced", "cancelled", "reversed"] as const
/** Where a Billing Run stands; part A writes `completed` alone. */
export const BILLING_RUN_STATUSES = ["requested", "completed", "failed"] as const
/** Why a payer with events in the period got no invoice: every one of them is blocked. */
export const EXCLUSION_REASONS = ["all-events-blocked"] as const
/** An issued customer financial document: an invoice, or the credit note that corrects one. */
export const INVOICE_KINDS = ["invoice", "credit-note"] as const
/** Why a credit note was issued: the prototype's five, verbatim as tokens. */
export const CREDIT_REASONS = ["service-not-delivered", "quantity-correction", "price-correction", "duplicate", "other"] as const
/** Where a Settlement stands; "under review" and "reopened" are readings. */
export const SETTLEMENT_STATUSES = ["open", "calculated", "closed"] as const
/** What a row of a Settlement's history is. */
export const SETTLEMENT_EVENT_KINDS = ["calculated", "closed", "reopened"] as const
/** What a review row says of an Unload's weight. */
export const WEIGHT_REVIEW_DECISIONS = ["approved", "rejected", "corrected"] as const
/** An Unload's review status: the latest decision, or `captured` when none; a reading, never a column. */
export const WEIGHT_REVIEW_STATUSES = ["captured", "approved", "rejected", "corrected"] as const
/** What an indexation multiplied: the locked bid, or the fee it replaced. */
export const INDEX_BASES = ["bid", "current-fee"] as const

export type BillableEventKind = (typeof BILLABLE_EVENT_KINDS)[number]
export type BlockReason = (typeof BLOCK_REASONS)[number]
export type CancelReason = (typeof CANCEL_REASONS)[number]
export type BillableEventStatus = (typeof BILLABLE_EVENT_STATUSES)[number]
export type BillingRunStatus = (typeof BILLING_RUN_STATUSES)[number]
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number]
export type InvoiceKind = (typeof INVOICE_KINDS)[number]
export type CreditReason = (typeof CREDIT_REASONS)[number]
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number]
export type SettlementEventKind = (typeof SETTLEMENT_EVENT_KINDS)[number]
export type WeightReviewDecision = (typeof WEIGHT_REVIEW_DECISIONS)[number]
export type WeightReviewStatus = (typeof WEIGHT_REVIEW_STATUSES)[number]
export type IndexBase = (typeof INDEX_BASES)[number]

/** The statuses a Settlement is recalculated in: open, or calculated and not yet closed. A value of `SETTLEMENT_STATUSES`, not a vocabulary. */
export const OPEN_SETTLEMENT_STATUSES = ["open", "calculated"] as const satisfies readonly SettlementStatus[]
export type OpenSettlementStatus = (typeof OPEN_SETTLEMENT_STATUSES)[number]

/** Whether a Settlement in this status may be recalculated: it is not closed. */
export const isOpenSettlementStatus = (status: SettlementStatus): status is OpenSettlementStatus => (OPEN_SETTLEMENT_STATUSES as readonly SettlementStatus[]).includes(status)

/** Every list of this module by its name, for a test that walks them and for a reader looking for the whole vocabulary at once. */
export const FINANCE_VOCABULARIES = {
  BILLABLE_EVENT_KINDS,
  BLOCK_REASONS,
  CANCEL_REASONS,
  BILLABLE_EVENT_STATUSES,
  BILLING_RUN_STATUSES,
  EXCLUSION_REASONS,
  INVOICE_KINDS,
  CREDIT_REASONS,
  SETTLEMENT_STATUSES,
  SETTLEMENT_EVENT_KINDS,
  WEIGHT_REVIEW_DECISIONS,
  WEIGHT_REVIEW_STATUSES,
  INDEX_BASES,
} as const satisfies Record<string, readonly [string, ...string[]]>
