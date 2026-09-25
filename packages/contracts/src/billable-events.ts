// The Billable Event on the wire (Issue #112): "a validated occurrence that
// is eligible to become an invoice line" (CONTEXT.md) — a completed pickup,
// a resolved ticket, a person's entry, or the reversal of an invoiced event a
// correction undid. It carries its `status`, a reading and never a column
// (@waste/domain/finance/readings: blocked is a block reason, cancelled a
// stamp, invoiced a line naming it, reversed a reversal naming it, ready none
// of those), answered on every read and taken on no write; what it was under
// (the agreement, the subscription, the product, null where the block reason
// says why); the price as resolved on `serviceDate` and frozen, or null while
// blocked; the row that won, so the price stays traceable; `links`, the four
// ids the database checks — the route and its pickup, the ticket, the event
// it reverses; who made it, a person (`createdBy`) or an outbox event
// (`sourceEventId`), never both; the person's price and reason on a manual
// event; the cancellation's stamps; and `invoiceLineId`, the line that
// invoiced it, read.
//
// Three doors write one and two commands move it (#112 §3). `POST
// /billable-events` is the office's manual event: an agreement and a product
// of the project, a quantity, a service date, a note, and either the
// resolver's price or a person's `unitPriceMinor` with an `overrideReason` —
// the pair, `overrideWithAReason`, since a price of one's own wants its
// reason and a reason without a price is nothing. `reprice` runs the
// resolver again over a blocked event, the ticket's event taking the product
// the office picked; `cancel` stamps a ready or blocked event with the
// caller, the clock and a reason — the office's three, never the consumer's
// `pickup-corrected`. The consumer's two doors are the worker's.
import { IsoDate, IsoDateTime } from "./dates"
import { BillableEventKind, BillableEventStatus, BlockReason, CancelReason } from "./finance"
import { Id } from "./ids"
import { Currency } from "./organisation"
import { dayWindowIsOrdered, dayWindowOrdered, ProjectScopedListQuery } from "./queries"
import { Minor, NonNegativeMinor, PositiveInt, stamped } from "./resource"
import { Paragraph } from "./text"
import * as z from "zod"

/** What an event links to: the ids the occurrence named, each null where it named none. */
export const BillableEventLinks = z.object({
  routeId: Id.nullable(),
  /** A pickup of the route the event names. */
  pickupId: Id.nullable(),
  ticketId: Id.nullable(),
  /** On a reversal: the invoiced event it undoes. */
  reversesEventId: Id.nullable(),
})
export type BillableEventLinks = z.infer<typeof BillableEventLinks>

export const BillableEvent = z.object({
  ...stamped,
  projectId: Id,
  kind: BillableEventKind,
  /** The reading, answered on every read and never taken on a write. */
  status: BillableEventStatus,
  /** The day the occurrence is priced and billed on. */
  serviceDate: IsoDate,
  /** What the occurrence was under; null where the block reason says why. */
  agreementId: Id.nullable(),
  subscriptionId: Id.nullable(),
  productId: Id.nullable(),
  /** In the product's unit; 1 for a pickup and a ticket. */
  quantity: PositiveInt,
  /** The price as resolved and frozen; the five null together while blocked. A reversal's net and VAT are negative. */
  unitPriceMinor: Minor.nullable(),
  netMinor: Minor.nullable(),
  vatPercent: z.int().nullable(),
  vatMinor: Minor.nullable(),
  currency: Currency.nullable(),
  /** The row that won; null while blocked, on a manual event with a person's price, and on a reversal. */
  priceListRowId: Id.nullable(),
  /** Why the event is not ready; null once priced. */
  blockReason: BlockReason.nullable(),
  links: BillableEventLinks,
  /** The outbox event the consumer made it from, or null for a person's. */
  sourceEventId: Id.nullable(),
  /** The person who entered it, or null for the consumer's. */
  createdBy: Id.nullable(),
  /** Why a manual event carries a person's price and no row. */
  overrideReason: Paragraph.nullable(),
  note: Paragraph.nullable(),
  cancelledAt: IsoDateTime.nullable(),
  /** The person who cancelled it; null on the consumer's cancellation. */
  cancelledBy: Id.nullable(),
  cancelReason: CancelReason.nullable(),
  /** The invoice line that charges for it; null until a run puts it on one. */
  invoiceLineId: Id.nullable(),
})
export type BillableEvent = z.infer<typeof BillableEvent>

/** What a body giving a price of its own without a reason, or a reason without a price, is told. */
export const OVERRIDE_WITH_A_REASON = "Give the reason with a price of your own, and neither without the other"
const overrideWithAReasonAt = { message: OVERRIDE_WITH_A_REASON, path: ["overrideReason"] }

/** A person's price and its reason come together or not at all. */
export const overrideWithAReason = (body: { unitPriceMinor?: number; overrideReason?: string }): boolean => (body.unitPriceMinor === undefined) === (body.overrideReason === undefined)

/** `POST /billable-events`: the office's manual event, priced by the resolver or by the person with a reason. The status, the links, the origin and the stamps are the server's. */
export const BillableEventCreate = z
  .strictObject({
    projectId: Id,
    agreementId: Id,
    productId: Id,
    quantity: PositiveInt,
    serviceDate: IsoDate,
    note: Paragraph.optional(),
    /** A price of the person's own, with its reason; the resolver's when absent. */
    unitPriceMinor: NonNegativeMinor.optional(),
    overrideReason: Paragraph.optional(),
  })
  .refine(overrideWithAReason, overrideWithAReasonAt)
export type BillableEventCreate = z.infer<typeof BillableEventCreate>

/** `POST /billable-events/:id/reprice`: the resolver again over a blocked event; a ticket's event takes the product the office picked, and any other kind refuses one. */
export const BillableEventReprice = z.strictObject({
  productId: Id.optional(),
})
export type BillableEventReprice = z.infer<typeof BillableEventReprice>

/** `POST /billable-events/:id/cancel`: the office's reason, never the consumer's, and a note. */
export const BillableEventCancel = z.strictObject({
  reason: CancelReason.exclude(["pickup-corrected"]),
  note: Paragraph.optional(),
})
export type BillableEventCancel = z.infer<typeof BillableEventCancel>

/** A page of events: one project's, by status, kind or block reason, under one agreement, for one payer, of one product, about one route, pickup or ticket, over a window of service dates. */
export const BillableEventListQuery = ProjectScopedListQuery.extend({
  status: BillableEventStatus.optional(),
  kind: BillableEventKind.optional(),
  blockReason: BlockReason.optional(),
  agreementId: Id.optional(),
  /** The payer, through the agreement. */
  customerId: Id.optional(),
  productId: Id.optional(),
  routeId: Id.optional(),
  pickupId: Id.optional(),
  ticketId: Id.optional(),
  /** The first day of the window over `serviceDate`, inclusive. */
  from: IsoDate.optional(),
  /** The last day, inclusive. */
  to: IsoDate.optional(),
}).refine(dayWindowOrdered, dayWindowIsOrdered)
export type BillableEventListQuery = z.infer<typeof BillableEventListQuery>
