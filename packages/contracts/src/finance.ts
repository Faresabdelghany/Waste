// Finance & Contracting's closed lists at the API boundary (Issue #112): each
// of @waste/domain/finance/vocabulary's tuples turned into the `z.enum` the
// routes validate against, so an unknown token never reaches a `CHECK` that
// would refuse it as a 500 naming nothing. Shared here because eight modules
// read them — `price-lists.ts` none but the Registry's customer kind,
// `service-provider-prices.ts` the index base, `billable-events.ts` the kind,
// the block and cancel reasons and the status, `billing.ts` the run's status
// and the exclusion reason, `invoices.ts` the kind and the credit reason,
// `settlements.ts` the settlement's status and its history's kind,
// `weight-control.ts` the decision and the status — and a list spelled in one
// place is a list that cannot drift between them.
//
// Two things beside the enums are the context's presentation on the wire,
// the `execution.ts` and `resolution.ts` precedent. An invoice's display
// number is `INV-26007188` and a credit note's `CN-26007189`: the database
// stores `number` from the company's one counter, so the two kinds share a
// series and the prefix is presentation, spelled once here, and
// `invoiceLabel` is the one way a number and a kind become the `label` an
// `Invoice` carries and every sentence names ("Invoice INV-26007188 is fully
// credited"). And an Unload's review status travels beside every `Unload` as
// `WeightReviewState` — the reading, the latest review's id and the
// correction it wrote, `captured` with two nulls where nobody has looked —
// defined here rather than in weight-control.ts, which imports the unload's
// weights rule from unloads.ts and could not be imported back by it.
import {
  BILLABLE_EVENT_KINDS,
  BILLABLE_EVENT_STATUSES,
  BILLING_RUN_STATUSES,
  BLOCK_REASONS,
  CANCEL_REASONS,
  CREDIT_REASONS,
  EXCLUSION_REASONS,
  INDEX_BASES,
  INDEX_SKIP_REASONS,
  INVOICE_KINDS,
  PAYMENT_REFERENCE_SCHEMES,
  SETTLEMENT_EVENT_KINDS,
  SETTLEMENT_STATUSES,
  WEIGHT_REVIEW_DECISIONS,
  WEIGHT_REVIEW_STATUSES,
} from "@waste/domain/finance/vocabulary"
import { BIC_PATTERN, DEFAULT_PAYMENT_TERMS_DAYS, FIK_CREDITOR_PATTERN, IBAN_PATTERN, PAYMENT_REFERENCE_PATTERN, PAYMENT_TERMS_MAX, VAT_NUMBER_PATTERN } from "@waste/domain/finance/payment"
import * as z from "zod"

import { IsoDate } from "./dates"
import { Id } from "./ids"
import { Int4, NonNegativeMinor } from "./resource"
import { Label } from "./text"

/** What a Billable Event was made of: a pickup, a ticket, a person's entry, or the reversal of an invoiced event. */
export const BillableEventKind = z.enum(BILLABLE_EVENT_KINDS)
export type BillableEventKind = z.infer<typeof BillableEventKind>

/** Why an event cannot be invoiced, each actionable. */
export const BlockReason = z.enum(BLOCK_REASONS)
export type BlockReason = z.infer<typeof BlockReason>

/** Why a ready event was cancelled; `pickup-corrected` is the consumer's and no body's. */
export const CancelReason = z.enum(CANCEL_REASONS)
export type CancelReason = z.infer<typeof CancelReason>

/** Where a Billable Event stands: a reading, answered on every read and taken on no write. */
export const BillableEventStatus = z.enum(BILLABLE_EVENT_STATUSES)
export type BillableEventStatus = z.infer<typeof BillableEventStatus>

/** Where a Billing Run stands. */
export const BillingRunStatus = z.enum(BILLING_RUN_STATUSES)
export type BillingRunStatus = z.infer<typeof BillingRunStatus>

/** Why a payer with events in the period got no invoice. */
export const ExclusionReason = z.enum(EXCLUSION_REASONS)
export type ExclusionReason = z.infer<typeof ExclusionReason>

/** An invoice, or the credit note that corrects one. */
export const InvoiceKind = z.enum(INVOICE_KINDS)
export type InvoiceKind = z.infer<typeof InvoiceKind>

/** Why a credit note was issued. */
export const CreditReason = z.enum(CREDIT_REASONS)
export type CreditReason = z.infer<typeof CreditReason>

/** Where a Settlement stands. */
export const SettlementStatus = z.enum(SETTLEMENT_STATUSES)
export type SettlementStatus = z.infer<typeof SettlementStatus>

/** What a row of a Settlement's history is. */
export const SettlementEventKind = z.enum(SETTLEMENT_EVENT_KINDS)
export type SettlementEventKind = z.infer<typeof SettlementEventKind>

/** What a review says of an Unload's weight. */
export const WeightReviewDecision = z.enum(WEIGHT_REVIEW_DECISIONS)
export type WeightReviewDecision = z.infer<typeof WeightReviewDecision>

/** An Unload's review status: the latest decision, or `captured`. */
export const WeightReviewStatus = z.enum(WEIGHT_REVIEW_STATUSES)
export type WeightReviewStatus = z.infer<typeof WeightReviewStatus>

/** What an indexation multiplied: the locked bid, or the fee it replaced. */
export const IndexBase = z.enum(INDEX_BASES)
export type IndexBase = z.infer<typeof IndexBase>

/** Why an Apply index over many prices leaves a row as it is (#291 C8). */
export const IndexSkipReason = z.enum(INDEX_SKIP_REASONS)
export type IndexSkipReason = z.infer<typeof IndexSkipReason>

/**
 * What every Apply index over many prices takes (#291 C8): the label, the
 * basis points and the first day the new prices hold, as the single provider
 * index takes them, and `dryRun`, the preview, which answers the plan and
 * writes nothing.
 */
export const indexBody = {
  /** What the indexation is: `CPI 2027`. */
  label: Label,
  /** 320 for +3.2 %; negative allowed, a deflator. Within an `integer`, the column it is kept in. */
  basisPoints: Int4,
  /** The first day the new prices hold. */
  appliedFrom: IsoDate,
  /** The preview: the plan answered, nothing written. */
  dryRun: z.boolean().optional(),
}

/** One row of an Apply index's plan: indexed at a price, with the successor's id once written, or skipped with why. */
export const IndexLine = z.object({
  /** The row judged: a price list row or a service provider price. */
  id: Id,
  productId: Id,
  /** What the row charges now. */
  fromMinor: NonNegativeMinor,
  /** The successor's price; null on a skipped row. */
  toMinor: NonNegativeMinor.nullable(),
  /** The successor written; null on a skipped row and throughout a preview. */
  indexedId: Id.nullable(),
  /** Why the row stays as it is; null on an indexed row. */
  skipped: IndexSkipReason.nullable(),
})
export type IndexLine = z.infer<typeof IndexLine>

/** What an Apply index over many prices answers: the body's index again, and one line per row in force on the day or starting after it, oldest first. */
export const IndexResult = z.object({
  dryRun: z.boolean(),
  label: Label,
  basisPoints: z.int(),
  appliedFrom: IsoDate,
  lines: z.array(IndexLine),
})
export type IndexResult = z.infer<typeof IndexResult>

/** The prefix an invoice's number is shown with: `INV-26007188`. Presentation, spelled once. */
export const INVOICE_NUMBER_PREFIX = "INV-"

/** The prefix a credit note's number is shown with: `CN-26007189`. The same series as an invoice's; the prefix says which kind of document the number is. */
export const CREDIT_NOTE_NUMBER_PREFIX = "CN-"

/** The label a document is named by, from the number the database stores and the kind the row carries. */
export const invoiceLabel = (kind: InvoiceKind, number: number): string => `${kind === "invoice" ? INVOICE_NUMBER_PREFIX : CREDIT_NOTE_NUMBER_PREFIX}${number}`

/** The reading an Unload carries: its review status, the latest review's id, and the new Unload a correction wrote — `captured` with two nulls where no review exists, and never null itself. */
export const WeightReviewState = z.object({
  status: WeightReviewStatus,
  /** The latest review, in recording order; null where there is none. */
  latestReviewId: Id.nullable(),
  /** The Unload row a correction wrote, where the latest decision is `corrected`. */
  correctionUnloadId: Id.nullable(),
})
export type WeightReviewState = z.infer<typeof WeightReviewState>

/**
 * How an invoice is paid (#291 C4): a project's terms, or a customer's own,
 * and its reference scheme; the company's invoice identity — the VAT
 * registration, the bank account and the FIK creditor number — each by the
 * domain's shape (@waste/domain/finance/payment), upper case and without the
 * spaces a person types for reading.
 */
export const PaymentTermsDays = z.int().min(0).max(PAYMENT_TERMS_MAX)
export const PaymentReferenceScheme = z.enum(PAYMENT_REFERENCE_SCHEMES)
export type PaymentReferenceScheme = z.infer<typeof PaymentReferenceScheme>
export const VatNumber = z.string().regex(new RegExp(VAT_NUMBER_PATTERN), "a VAT registration: its country's two letters, then its number, such as DK12345678")
export const Iban = z.string().regex(new RegExp(IBAN_PATTERN), "an IBAN without spaces, such as DK5000400440116243")
export const Bic = z.string().regex(new RegExp(BIC_PATTERN), "a BIC of eight or eleven characters, such as DABADKKK")
export const FikCreditorNumber = z.string().regex(new RegExp(FIK_CREDITOR_PATTERN), "a FIK creditor number: eight digits")
/** A frozen payment reference: FIK 71's fifteen digits or FIK 75's sixteen. */
export const PaymentReference = z.string().regex(new RegExp(PAYMENT_REFERENCE_PATTERN))

/** A new project's terms, the column's default. */
export { DEFAULT_PAYMENT_TERMS_DAYS }
