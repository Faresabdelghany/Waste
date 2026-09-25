// The Invoice on the wire (Issue #112): "an issued customer financial
// document" (CONTEXT.md). Every invoice exists issued, so it is a ledger row
// — `recorded`, never `updatedAt`, no patch — carrying what an external
// ledger needs to book it without reading another table: its `number` from
// the company's unbroken series under the `label` a person reads (`INV-26007188`,
// `CN-26007189`; the two held together at `label` as a route's and a ticket's
// are), its kind, the payer, the currency, when it was issued and is due, the
// period it bills (an invoice's; null on a credit note), the run that issued
// it (an invoice's) or the invoice it credits and why (a credit note's), and
// its totals as issued, `grossMinor` the net and the VAT (`totalsAgree`). A
// credit note is an Invoice of `kind = credit-note`: the prototype's
// "Corrections use cancellation or full or partial credit notes" makes it an
// issued customer financial document too, and one series with two prefixes
// is how a company numbers them (§7.13). "Sent" is the export's own row and
// not here.
//
// A line charges for one Billable Event or credits one line, never both and
// never neither (`oneSource`), with the product's invoice name and the service
// date frozen as text in `description`, the quantity — on a credit line, the
// quantity credited — and its amounts in minor units. `InvoiceDetail` is the
// invoice with its lines by position and the credit notes naming it.
//
// `POST /invoices/:id/credit-notes` is the one write: full — `lines: "all"`,
// crediting every line by what remains of it — or partial, the named lines by
// the named quantities, each once (`EACH_LINE_ONCE`) and at most
// `CREDIT_LINES_MAX`; the route holds each to the line's remaining quantity.
// A credit is by quantity, never by amount (§7.25): the amount follows from
// the line's unit price.
import { IsoDate } from "./dates"
import { CreditReason, InvoiceKind, invoiceLabel } from "./finance"
import { Id } from "./ids"
import { Currency } from "./organisation"
import { dayWindowIsOrdered, dayWindowOrdered, ProjectScopedListQuery } from "./queries"
import { eachOnce, eachOnceSentence, Minor, NonNegativeMinor, PositiveInt, recorded } from "./resource"
import { Paragraph } from "./text"
import * as z from "zod"

/** What a document whose label is not its number under its kind's prefix is told. */
export const LABEL_IS_THE_NUMBER = "label is the number under the prefix of its kind"
const labelIsTheNumber = { message: LABEL_IS_THE_NUMBER, path: ["label"] }

/** The label is the number's, under the kind's prefix. */
export const labelMatches = (value: { kind: InvoiceKind; number: number; label: string }): boolean => value.label === invoiceLabel(value.kind, value.number)

/** What a document whose gross is not its net and its VAT is told. */
export const GROSS_IS_NET_PLUS_VAT = "grossMinor is netMinor and vatMinor together"
const grossIsNetPlusVat = { message: GROSS_IS_NET_PLUS_VAT, path: ["grossMinor"] }

/** The totals agree. */
export const totalsAgree = (value: { netMinor: number; vatMinor: number; grossMinor: number }): boolean => value.grossMinor === value.netMinor + value.vatMinor

/** An invoice's fields, spelled once for the two resources that carry them; each refines the two rules again, since spreading takes the fields and not them. */
const invoiceFields = {
  ...recorded,
  projectId: Id,
  /** The document number from the company's series; `label` is it under the kind's prefix. */
  number: PositiveInt,
  label: z.string().min(1),
  kind: InvoiceKind,
  /** The payer. */
  customerId: Id,
  /** One per document; a payer with agreements in two currencies gets two invoices. */
  currency: Currency,
  issuedOn: IsoDate,
  /** Thirty days on for an invoice; the day of issue for a credit note. */
  dueOn: IsoDate,
  /** The run's period on an invoice; null on a credit note. */
  periodFrom: IsoDate.nullable(),
  periodTo: IsoDate.nullable(),
  /** The run that issued an invoice; null on a credit note. */
  billingRunId: Id.nullable(),
  /** What a credit note corrects, why, and the note; null on an invoice. */
  creditsInvoiceId: Id.nullable(),
  creditReason: CreditReason.nullable(),
  creditNote: Paragraph.nullable(),
  /** The totals as issued; a credit note's zero or negative. */
  netMinor: Minor,
  vatMinor: Minor,
  grossMinor: Minor,
  /** The caller; null for the worker's run. */
  issuedBy: Id.nullable(),
}

export const Invoice = z.object(invoiceFields).refine(labelMatches, labelIsTheNumber).refine(totalsAgree, grossIsNetPlusVat)
export type Invoice = z.infer<typeof Invoice>

/** What a line charging for an event and crediting a line, or doing neither, is told. */
export const ONE_SOURCE = "A line charges for one billable event or credits one line"
const oneSourceAt = { message: ONE_SOURCE, path: ["billableEventId"] }

/** Exactly one of the two sources. */
export const oneSource = (line: { billableEventId: string | null; creditsLineId: string | null }): boolean => (line.billableEventId !== null) !== (line.creditsLineId !== null)

export const InvoiceLine = z
  .object({
    ...recorded,
    invoiceId: Id,
    position: PositiveInt,
    /** On an invoice's line: the event it charges for. */
    billableEventId: Id.nullable(),
    /** On a credit note's line: the invoice line credited. */
    creditsLineId: Id.nullable(),
    /** Frozen text: the product's invoice name and the service date as they stood when issued — a `Paragraph`, since a `Label`-long invoice name with the day beside it overflows a `Label`. */
    description: Paragraph,
    productId: Id.nullable(),
    serviceDate: IsoDate.nullable(),
    /** On a credit line, the quantity credited. */
    quantity: PositiveInt,
    unitPriceMinor: NonNegativeMinor,
    /** Negative on a credit line and on a reversal's. */
    netMinor: Minor,
    vatPercent: z.int(),
    vatMinor: Minor,
  })
  .refine(oneSource, oneSourceAt)
export type InvoiceLine = z.infer<typeof InvoiceLine>

/** An invoice with its lines by position and the credit notes naming it. */
export const InvoiceDetail = z
  .object({
    ...invoiceFields,
    /** By position. */
    lines: z.array(InvoiceLine),
    /** The credit notes that credit this invoice; empty on a credit note. */
    creditNotes: z.array(Invoice),
  })
  .refine(labelMatches, labelIsTheNumber)
  .refine(totalsAgree, grossIsNetPlusVat)
export type InvoiceDetail = z.infer<typeof InvoiceDetail>

/** The most lines a partial credit may name: an invoice's lines, not an import. */
export const CREDIT_LINES_MAX = 500

export const EACH_LINE_ONCE = eachOnceSentence("line", "a line is credited by one quantity in one credit note")
const eachLineOnce = { message: EACH_LINE_ONCE, path: ["lines"] }

/** One line credited by a quantity, held by the route to what remains of it. */
const CreditedLine = z.strictObject({
  lineId: Id,
  quantity: PositiveInt,
})

/** `POST /invoices/:id/credit-notes`: full (`"all"`) or partial (the lines by quantity), with the reason and a note. The number, the totals and the issuer are the server's. */
export const CreditNoteCreate = z
  .strictObject({
    reason: CreditReason,
    note: Paragraph.optional(),
    /** `"all"` credits every line by what remains of it; a list credits the named lines by the named quantities. */
    lines: z.union([z.literal("all"), z.array(CreditedLine).min(1).max(CREDIT_LINES_MAX)]),
  })
  .refine((body) => body.lines === "all" || eachOnce(body.lines, (line) => line.lineId), eachLineOnce)
export type CreditNoteCreate = z.infer<typeof CreditNoteCreate>

/** A page of documents: one project's, of one kind, one payer's, one run's, crediting one invoice, over a window of `issuedOn`. */
export const InvoiceListQuery = ProjectScopedListQuery.extend({
  kind: InvoiceKind.optional(),
  customerId: Id.optional(),
  billingRunId: Id.optional(),
  /** The credit notes naming this invoice. */
  creditsInvoiceId: Id.optional(),
  /** The first day of the window over `issuedOn`, inclusive. */
  from: IsoDate.optional(),
  /** The last day, inclusive. */
  to: IsoDate.optional(),
}).refine(dayWindowOrdered, dayWindowIsOrdered)
export type InvoiceListQuery = z.infer<typeof InvoiceListQuery>
