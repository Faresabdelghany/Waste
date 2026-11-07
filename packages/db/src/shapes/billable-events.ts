// A billable event on the wire (Issue #112): `recordBillableEvent` answers
// the row it wrote as the route answers it, and the worker's consumer reads a
// pickup's live event through `eventsFrom`, the one statement every billable
// event is read through.
//
// A billable event's `status` is a reading and never a column
// (@waste/domain/finance/readings): `invoiced` is an `invoice_line` naming
// the event and `reversed` a `reversal` event naming it, and neither is on
// the event's row. So every event is read through `eventsFrom`, the one
// statement that joins the two LATERAL — one probe per row for the line that
// invoiced it and one for the reversal that undid it, the `assetStateOf`
// precedent (query/asset-state.ts) — and the fold runs over the row in
// `eventOf`, so a page, a single read, the answer to a command and the row a
// write answers all say the same thing about where an event stands.
// `statusIs` is the same fold as a `where`, the four readings as predicates
// over the two subqueries and the two stamps, so a list filters by status in
// SQL without a fifth way of saying what the columns say.
//
// Every kind, status and reason column is text with a CHECK in the database
// and an enum on the wire, so the row's string is asserted to the
// vocabulary's type here and nowhere else.
import type { BillableEvent, BillableEventLinks } from "@waste/contracts/billable-events"
import { billableEventStatus } from "@waste/domain/finance/readings"
import type { BillableEventKind, BillableEventStatus, BlockReason, CancelReason } from "@waste/domain/finance/vocabulary"
import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"

import type { Tx } from "../client"
import { billableEvent, invoiceLine } from "../schema/finance"
import { instantOf, stampsOf } from "./times"

export const eventColumns = {
  id: billableEvent.id,
  projectId: billableEvent.projectId,
  kind: billableEvent.kind,
  serviceDate: billableEvent.serviceDate,
  agreementId: billableEvent.agreementId,
  subscriptionId: billableEvent.subscriptionId,
  productId: billableEvent.productId,
  quantity: billableEvent.quantity,
  unitPriceMinor: billableEvent.unitPriceMinor,
  netMinor: billableEvent.netMinor,
  vatPercent: billableEvent.vatPercent,
  vatMinor: billableEvent.vatMinor,
  currency: billableEvent.currency,
  priceListRowId: billableEvent.priceListRowId,
  blockReason: billableEvent.blockReason,
  routeId: billableEvent.routeId,
  pickupId: billableEvent.pickupId,
  ticketId: billableEvent.ticketId,
  reversesEventId: billableEvent.reversesEventId,
  evidenceProofId: billableEvent.evidenceProofId,
  visitId: billableEvent.visitId,
  unloadId: billableEvent.unloadId,
  weightKg: billableEvent.weightKg,
  scaleTicketLineId: billableEvent.scaleTicketLineId,
  chargePeriodFrom: billableEvent.chargePeriodFrom,
  chargePeriodTo: billableEvent.chargePeriodTo,
  chargedDays: billableEvent.chargedDays,
  periodDays: billableEvent.periodDays,
  containerId: billableEvent.containerId,
  placementId: billableEvent.placementId,
  sourceEventId: billableEvent.sourceEventId,
  createdBy: billableEvent.createdBy,
  overrideReason: billableEvent.overrideReason,
  note: billableEvent.note,
  cancelledAt: billableEvent.cancelledAt,
  cancelledBy: billableEvent.cancelledBy,
  cancelReason: billableEvent.cancelReason,
  heldAt: billableEvent.heldAt,
  heldBy: billableEvent.heldBy,
  holdReason: billableEvent.holdReason,
  createdAt: billableEvent.createdAt,
  updatedAt: billableEvent.updatedAt,
}

export type EventRow = Pick<typeof billableEvent.$inferSelect, keyof typeof eventColumns>

/** The event's row beside the two rows that may name it: the line that invoiced it and the reversal that undid it, each null where there is none. */
export type EventReading = EventRow & { invoiceLineId: string | null; reversalId: string | null }

/** The reading a row has the instant it is written: no line and no reversal name it yet, by construction. */
export const UNNAMED = { invoiceLineId: null, reversalId: null }

/** The eight links as the wire carries them, off the row's eight columns: the evidence a Pickup Exception's charge names is its `proofId` (#293 M5), a recycling-centre visit's charge its `visitId` (#393), a weight charge its `unloadId` (O28 of #290), and a window line's charge its `scaleTicketLineId` (M16b of #293). */
export const linksOf = (row: Pick<EventRow, "routeId" | "pickupId" | "ticketId" | "reversesEventId" | "evidenceProofId" | "visitId" | "unloadId" | "scaleTicketLineId">): BillableEventLinks => ({
  routeId: row.routeId,
  pickupId: row.pickupId,
  ticketId: row.ticketId,
  reversesEventId: row.reversesEventId,
  proofId: row.evidenceProofId,
  visitId: row.visitId,
  unloadId: row.unloadId,
  scaleTicketLineId: row.scaleTicketLineId,
})

/** The status the domain reads off a row and the two rows that may name it. */
export const statusOf = (row: EventReading): BillableEventStatus =>
  billableEventStatus({ blockReason: row.blockReason as BlockReason | null, cancelledAt: row.cancelledAt, invoiced: row.invoiceLineId !== null, reversed: row.reversalId !== null, heldAt: row.heldAt })

/** The billable event on the wire, its status the fold over the reading. */
export function eventOf(row: EventReading): BillableEvent {
  const status = statusOf(row)
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind as BillableEventKind,
    status,
    serviceDate: row.serviceDate,
    agreementId: row.agreementId,
    subscriptionId: row.subscriptionId,
    productId: row.productId,
    quantity: row.quantity,
    weightKg: row.weightKg,
    unitPriceMinor: row.unitPriceMinor,
    netMinor: row.netMinor,
    vatPercent: row.vatPercent,
    vatMinor: row.vatMinor,
    currency: row.currency,
    priceListRowId: row.priceListRowId,
    blockReason: row.blockReason as BlockReason | null,
    links: linksOf(row),
    // The four are set together on a recurring charge and on nothing else (billable_event_charge_shape).
    charge:
      row.chargePeriodFrom === null || row.chargePeriodTo === null || row.chargedDays === null || row.periodDays === null
        ? null
        : { periodFrom: row.chargePeriodFrom, periodTo: row.chargePeriodTo, chargedDays: row.chargedDays, periodDays: row.periodDays },
    sourceEventId: row.sourceEventId,
    createdBy: row.createdBy,
    overrideReason: row.overrideReason,
    note: row.note,
    cancelledAt: instantOf(row.cancelledAt),
    cancelledBy: row.cancelledBy,
    cancelReason: row.cancelReason as CancelReason | null,
    // The hold while it stands: a cancellation, which leaves the columns as they were, ends it as a release does.
    hold: status !== "held" || row.heldAt === null || row.holdReason === null ? null : { at: row.heldAt.toISOString(), by: row.heldBy, reason: row.holdReason },
    invoiceLineId: row.invoiceLineId,
    ...stampsOf(row),
  }
}

/**
 * The one statement every billable event is read through: the row with the
 * two rows that may name it joined LATERAL — the invoice line that charges
 * for it and the `reversal` event that undoes it, one probe each per row,
 * `invoice_line_billable_event_id_idx` and `billable_event_reverses_event_id_idx`
 * serving them — so a page, a single read and the answer to a command all
 * read the same status. The two subqueries are handed back beside the query
 * for the status filter (`statusIs`) to name their columns.
 */
export function eventsFrom(tx: Tx, companyId: string) {
  const line = tx
    .select({ id: invoiceLine.id })
    .from(invoiceLine)
    .where(and(eq(invoiceLine.companyId, companyId), eq(invoiceLine.billableEventId, billableEvent.id)))
    .limit(1)
    .as("invoicing_line")
  const reversal = alias(billableEvent, "reversal")
  const reversing = tx
    .select({ id: reversal.id })
    .from(reversal)
    .where(and(eq(reversal.companyId, companyId), eq(reversal.reversesEventId, billableEvent.id)))
    .limit(1)
    .as("reversing_event")
  const query = tx
    .select({ ...eventColumns, invoiceLineId: line.id, reversalId: reversing.id })
    .from(billableEvent)
    .leftJoinLateral(line, sql`true`)
    .leftJoinLateral(reversing, sql`true`)
  return { query, line, reversing }
}

type Naming = Pick<ReturnType<typeof eventsFrom>, "line" | "reversing">

/**
 * The reading as a `where`: the domain's fold with the later fact winning,
 * spelled over the two LATERAL columns and the two stamps — `reversed` is a
 * reversal naming it; `invoiced` a line and no reversal; `cancelled` the stamp
 * and neither; `blocked` the reason and none of those; `ready` none of the
 * four — so `GET /billable-events?status=` answers exactly the rows `eventOf`
 * would read as that status, and the consumer's "live event" is `blocked` or
 * `ready` spelled the same way.
 */
export function statusIs(status: BillableEventStatus, { line, reversing }: Naming): SQL | undefined {
  const notReversed = isNull(reversing.id)
  const notInvoiced = isNull(line.id)
  const notCancelled = isNull(billableEvent.cancelledAt)
  switch (status) {
    case "reversed":
      return isNotNull(reversing.id)
    case "invoiced":
      return and(notReversed, isNotNull(line.id))
    case "cancelled":
      return and(notReversed, notInvoiced, isNotNull(billableEvent.cancelledAt))
    case "blocked":
      return and(notReversed, notInvoiced, notCancelled, isNotNull(billableEvent.blockReason))
    case "held":
      return and(notReversed, notInvoiced, notCancelled, isNull(billableEvent.blockReason), isNotNull(billableEvent.heldAt))
    case "ready":
      return and(notReversed, notInvoiced, notCancelled, isNull(billableEvent.blockReason), isNull(billableEvent.heldAt))
  }
}
