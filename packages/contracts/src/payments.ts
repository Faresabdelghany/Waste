// Payments and reconciliation on the wire (#291 slice 6, #292 C6). A payment
// is money as it arrived — registered by the office or a bank statement's
// line — with what it has allocated to invoices and what it has not, a credit
// on its payer's balance; its allocations each apply part of it to one
// invoice of its project, a wrong one undone by a reversal. A bank statement
// travels as the lines the browser read from our own CSV
// (@waste/domain/finance/payments, `bankFileOf`), a batch at a time, each
// with how many identical lines came before it, from which the server
// computes the key that keeps a statement imported twice to one payment per
// line. ISO 20022's CAMT.053 is the standard a bank's export maps onto later.
// A customer's statement runs its invoices, credit notes and payments in a
// currency over a window of days, from an opening balance to a closing one.
import { INVOICE_PAYMENT_STATUSES } from "@waste/domain/finance/payments"
import { PAYMENT_SOURCES } from "@waste/domain/finance/vocabulary"
import { IMPORT_BATCH_MAX } from "@waste/domain/imports/vocabulary"
import * as z from "zod"

import { IsoDate } from "./dates"
import { Id } from "./ids"
import { Currency } from "./organisation"
import { dayWindowIsOrdered, dayWindowOrdered, ProjectScopedListQuery } from "./queries"
import { Minor, NonNegativeInt, NonNegativeTotal, PositiveInt, recorded } from "./resource"
import { Paragraph } from "./text"

export const PaymentSource = z.enum(PAYMENT_SOURCES)
export type PaymentSource = z.infer<typeof PaymentSource>

/** What an invoice reads as from its payments (@waste/domain/finance/payments, `invoicePayment`). */
export const InvoicePaymentStatus = z.enum(INVOICE_PAYMENT_STATUSES)
export type InvoicePaymentStatus = z.infer<typeof InvoicePaymentStatus>

/** Money in minor units that is more than nothing, as a `bigint` total holds it. */
export const PositiveTotal = z.int().positive().max(Number.MAX_SAFE_INTEGER)

/** What a bank's reference field holds, and what its text says about the payer: as long as a statement line carries. */
export const BANK_REFERENCE_MAX = 140
export const BANK_TEXT_MAX = 500

export const PaymentAllocation = z.object({
  ...recorded,
  paymentId: Id,
  invoiceId: Id,
  /** Positive applies, negative undoes the allocation it reverses. */
  amountMinor: Minor.refine((value) => value !== 0, "an allocation moves money: undo one by its reversal"),
  reversesAllocationId: Id.nullable(),
  recordedBy: Id.nullable(),
})
export type PaymentAllocation = z.infer<typeof PaymentAllocation>

export const Payment = z.object({
  ...recorded,
  projectId: Id,
  /** The payer, where known; null for a bank line nobody's yet. */
  customerId: Id.nullable(),
  amountMinor: PositiveTotal,
  currency: Currency,
  paidOn: IsoDate,
  reference: z.string().max(BANK_REFERENCE_MAX).nullable(),
  payerText: z.string().max(BANK_TEXT_MAX).nullable(),
  source: PaymentSource,
  note: Paragraph.nullable(),
  recordedBy: Id.nullable(),
  /** What its allocations apply, reversals taken off. */
  allocatedMinor: NonNegativeTotal,
  /** What remains: a credit on the payer's balance. */
  unallocatedMinor: NonNegativeTotal,
})
export type Payment = z.infer<typeof Payment>

/** A payment with its allocations, in recording order. */
export const PaymentDetail = Payment.extend({ allocations: z.array(PaymentAllocation) })
export type PaymentDetail = z.infer<typeof PaymentDetail>

/** A payment the office registers: the server mints its id, stamps it, says its source and allocates it to the invoice named, what that invoice owes at most. A body's amount is held to the integer's bound (int4.test.ts), a single payment's ceiling. */
export const PaymentCreate = z.strictObject({
  projectId: Id,
  /** The payer; the invoice's payer where an invoice is named and this is not. */
  customerId: Id.optional(),
  amountMinor: PositiveInt,
  currency: Currency,
  paidOn: IsoDate,
  reference: z.string().min(1).max(BANK_REFERENCE_MAX).optional(),
  note: Paragraph.optional(),
  /** The invoice it pays, of the same project and currency. */
  invoiceId: Id.optional(),
})
export type PaymentCreate = z.infer<typeof PaymentCreate>

/** Part of a payment applied to one invoice by the office. */
export const AllocationCreate = z.strictObject({ invoiceId: Id, amountMinor: PositiveInt })
export type AllocationCreate = z.infer<typeof AllocationCreate>

export const PaymentListQuery = ProjectScopedListQuery.extend({
  customerId: Id.optional(),
  invoiceId: Id.optional(),
  /** Only what is not allocated in full. */
  unmatched: z.stringbool({ truthy: ["true"], falsy: ["false"], case: "sensitive" }).optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
}).refine(dayWindowOrdered, dayWindowIsOrdered)
export type PaymentListQuery = z.infer<typeof PaymentListQuery>

/** One incoming line of a statement as the browser read it: its row, what it says, and how many identical lines the file held before it. */
export const BankLine = z.strictObject({
  row: PositiveInt,
  bookedOn: IsoDate,
  amountMinor: PositiveInt,
  currency: Currency,
  reference: z.string().max(BANK_REFERENCE_MAX),
  text: z.string().max(BANK_TEXT_MAX),
  occurrence: NonNegativeInt,
})
export type BankLine = z.infer<typeof BankLine>

/** A batch of a statement's lines, matched against the company's open invoices; what matches nothing lands in the project named. A dry run writes nothing. */
export const BankLines = z.strictObject({
  projectId: Id,
  dryRun: z.boolean().optional(),
  lines: z.array(BankLine).min(1).max(IMPORT_BATCH_MAX),
})
export type BankLines = z.infer<typeof BankLines>

export const BankLineOutcome = z.enum(["matched", "unmatched", "duplicate"])
export type BankLineOutcome = z.infer<typeof BankLineOutcome>

/** A line's answer: matched to an invoice and how much of it, unmatched, or a line a statement already brought; the payment it is, or would be. */
export const BankLineResult = z.object({
  row: PositiveInt,
  outcome: BankLineOutcome,
  /** The payment written, or the one already written for a duplicate; null on a dry run's new line. */
  paymentId: Id.nullable(),
  invoiceId: Id.nullable(),
  allocatedMinor: NonNegativeTotal,
  by: z.enum(["reference", "label"]).nullable(),
})
export type BankLineResult = z.infer<typeof BankLineResult>

export const BankLinesResult = z.object({
  dryRun: z.boolean(),
  lines: z.array(BankLineResult),
  counts: z.object({ matched: NonNegativeInt, unmatched: NonNegativeInt, duplicate: NonNegativeInt }),
})
export type BankLinesResult = z.infer<typeof BankLinesResult>

export const StatementLineKind = z.enum(["invoice", "credit-note", "payment"])

/** One dated line of a statement: what it is, the document or payment it is, its amount on the balance — an invoice raises it, a credit note and a payment lower it — and the balance after it. */
export const StatementLine = z.object({
  on: IsoDate,
  kind: StatementLineKind,
  documentId: Id,
  /** The document's label, or the payment's reference where it has one. */
  label: z.string().nullable(),
  amountMinor: Minor,
  balanceMinor: Minor,
})

export const CustomerStatement = z.object({
  customerId: Id,
  currency: Currency,
  from: IsoDate,
  to: IsoDate,
  /** What the customer owed before \`from\`: invoiced less credited less paid. */
  openingBalanceMinor: Minor,
  lines: z.array(StatementLine),
  closingBalanceMinor: Minor,
})
export type CustomerStatement = z.infer<typeof CustomerStatement>

export const CustomerStatementQuery = z
  .object({ currency: Currency, from: IsoDate, to: IsoDate })
  .refine(dayWindowOrdered, dayWindowIsOrdered)
export type CustomerStatementQuery = z.infer<typeof CustomerStatementQuery>
