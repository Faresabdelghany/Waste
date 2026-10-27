// The billable event and the invoice on the wire, as the commands and the
// API's routes both read them (Issue #112; lifted here from
// `apps/api/src/routes/billing-shapes.ts`, whose Principal-bound half — the
// scopes and the family's 404s — stays there). `recordBillableEvent` answers
// the row it wrote as the route answers it; `runBilling` answers the run's
// row and its exclusions; `issueInvoice` answers the `InvoiceDetail` it
// publishes; and the worker's consumer reads a pickup's live event through
// `eventsFrom`, the one statement every billable event is read through.
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
// An invoice's `label` is `invoiceLabel(kind, number)`, the contracts' one
// spelling of `INV-26007188` and `CN-26007189`. Every kind, status and reason
// column is text with a CHECK in the database and an enum on the wire, so the
// row's string is asserted to the vocabulary's type here and nowhere else.
import type { BillableEvent, BillableEventLinks } from "@waste/contracts/billable-events"
import type { BillingRun, BillingRunExclusion } from "@waste/contracts/billing"
import { invoiceLabel } from "@waste/contracts/finance"
import type { Invoice, InvoiceDetail, InvoiceLine } from "@waste/contracts/invoices"
import { invoicePayment, type InvoicePaymentStatus } from "@waste/domain/finance/payments"
import { billableEventStatus } from "@waste/domain/finance/readings"
import type { BillableEventKind, BillableEventStatus, BillingRunStatus, BlockReason, CancelReason, CreditReason, ExclusionReason, InvoiceKind } from "@waste/domain/finance/vocabulary"
import { and, asc, eq, inArray, isNotNull, isNull, sql, sum, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"

import type { Tx } from "../client"
import { billableEvent, billingRun, billingRunExclusion, invoice, invoiceLine, paymentAllocation } from "../schema/finance"

/** The instants of a row, as the wire spells them. */
export const stampsOf = (row: { createdAt: Date; updatedAt: Date }): { createdAt: string; updatedAt: string } => ({ createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })

/** The instant of a row's nullable column, as the wire spells it; null stays null. */
export const instantOf = (value: Date | null): string | null => (value === null ? null : value.toISOString())

// The billable event.

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

/** The six links as the wire carries them, off the row's six columns: the evidence a Pickup Exception's charge names is its `proofId` (#293 M5), and a recycling-centre visit's charge its `visitId` (#393). */
export const linksOf = (row: Pick<EventRow, "routeId" | "pickupId" | "ticketId" | "reversesEventId" | "evidenceProofId" | "visitId">): BillableEventLinks => ({
  routeId: row.routeId,
  pickupId: row.pickupId,
  ticketId: row.ticketId,
  reversesEventId: row.reversesEventId,
  proofId: row.evidenceProofId,
  visitId: row.visitId,
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

// The billing run and its exclusions.

export const runColumns = {
  id: billingRun.id,
  projectId: billingRun.projectId,
  periodFrom: billingRun.periodFrom,
  periodTo: billingRun.periodTo,
  status: billingRun.status,
  requestedBy: billingRun.requestedBy,
  completedAt: billingRun.completedAt,
  eventCount: billingRun.eventCount,
  invoiceCount: billingRun.invoiceCount,
  excludedCustomerCount: billingRun.excludedCustomerCount,
  netMinor: billingRun.netMinor,
  vatMinor: billingRun.vatMinor,
  note: billingRun.note,
  createdAt: billingRun.createdAt,
  updatedAt: billingRun.updatedAt,
}

export type RunRow = Pick<typeof billingRun.$inferSelect, keyof typeof runColumns>

/** The run on the wire. */
export function runOf(row: RunRow): BillingRun {
  return {
    id: row.id,
    projectId: row.projectId,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    status: row.status as BillingRunStatus,
    requestedBy: row.requestedBy,
    completedAt: instantOf(row.completedAt),
    eventCount: row.eventCount,
    invoiceCount: row.invoiceCount,
    excludedCustomerCount: row.excludedCustomerCount,
    netMinor: row.netMinor,
    vatMinor: row.vatMinor,
    note: row.note,
    ...stampsOf(row),
  }
}

export const exclusionColumns = {
  id: billingRunExclusion.id,
  recordedAt: billingRunExclusion.recordedAt,
  billingRunId: billingRunExclusion.billingRunId,
  customerId: billingRunExclusion.customerId,
  reason: billingRunExclusion.reason,
  eventCount: billingRunExclusion.eventCount,
}

export type ExclusionRow = Pick<typeof billingRunExclusion.$inferSelect, keyof typeof exclusionColumns>

/** The exclusion on the wire. */
export function exclusionOf(row: ExclusionRow): BillingRunExclusion {
  return {
    id: row.id,
    recordedAt: row.recordedAt.toISOString(),
    billingRunId: row.billingRunId,
    customerId: row.customerId,
    reason: row.reason as ExclusionReason,
    eventCount: row.eventCount,
  }
}

// The invoice and its lines.

export const invoiceColumns = {
  id: invoice.id,
  recordedAt: invoice.recordedAt,
  projectId: invoice.projectId,
  number: invoice.number,
  kind: invoice.kind,
  customerId: invoice.customerId,
  currency: invoice.currency,
  issuedOn: invoice.issuedOn,
  dueOn: invoice.dueOn,
  periodFrom: invoice.periodFrom,
  periodTo: invoice.periodTo,
  billingRunId: invoice.billingRunId,
  creditsInvoiceId: invoice.creditsInvoiceId,
  creditReason: invoice.creditReason,
  creditNote: invoice.creditNote,
  netMinor: invoice.netMinor,
  vatMinor: invoice.vatMinor,
  grossMinor: invoice.grossMinor,
  issuedBy: invoice.issuedBy,
  paymentReference: invoice.paymentReference,
}

export type InvoiceRow = Pick<typeof invoice.$inferSelect, keyof typeof invoiceColumns>

/** How every sentence names a document: `INV-26007188`, `CN-26007189`. */
export const labelOf = (row: { kind: string; number: number }): string => invoiceLabel(row.kind as InvoiceKind, row.number)

/** What a document's payments make of it (#291 C6): what they apply, what it still owes, and its status; a credit note's none. */
export type InvoiceStanding = { paidMinor: number; outstandingMinor: number; paymentStatus: InvoicePaymentStatus | null }

/** How a document stands the day it is issued, nothing paid or credited yet: the outbox's and the issuing request's reading. */
export function issueStanding(row: Pick<InvoiceRow, "kind" | "grossMinor" | "dueOn" | "issuedOn">): InvoiceStanding {
  if (row.kind !== "invoice") return { paidMinor: 0, outstandingMinor: 0, paymentStatus: null }
  const reading = invoicePayment({ grossMinor: row.grossMinor, creditedMinor: 0, allocatedMinor: 0, dueOn: row.dueOn, today: row.issuedOn })
  return { paidMinor: reading.paidMinor, outstandingMinor: reading.outstandingMinor, paymentStatus: reading.status }
}

/**
 * How each document stands on its project's day (#291 C6): its allocations
 * summed, reversals taken off, and its credit notes' gross, each read once
 * for the whole set; a credit note's standing is none.
 */
export async function standingsOf(tx: Tx, companyId: string, rows: readonly InvoiceRow[], todayOf: (projectId: string) => Promise<string>): Promise<Map<string, InvoiceStanding>> {
  const invoices = rows.filter((row) => row.kind === "invoice")
  const standings = new Map<string, InvoiceStanding>(rows.filter((row) => row.kind !== "invoice").map((row) => [row.id, issueStanding(row)]))
  if (invoices.length === 0) return standings
  const ids = invoices.map((row) => row.id)
  const [allocated, credited] = await Promise.all([
    tx
      .select({ invoiceId: paymentAllocation.invoiceId, amountMinor: sum(paymentAllocation.amountMinor).mapWith(Number) })
      .from(paymentAllocation)
      .where(and(eq(paymentAllocation.companyId, companyId), inArray(paymentAllocation.invoiceId, ids)))
      .groupBy(paymentAllocation.invoiceId),
    tx
      .select({ invoiceId: invoice.creditsInvoiceId, grossMinor: sum(invoice.grossMinor).mapWith(Number) })
      .from(invoice)
      .where(and(eq(invoice.companyId, companyId), inArray(invoice.creditsInvoiceId, ids)))
      .groupBy(invoice.creditsInvoiceId),
  ])
  const allocatedBy = new Map(allocated.map((row) => [row.invoiceId, row.amountMinor]))
  const creditedBy = new Map(credited.map((row) => [row.invoiceId, row.grossMinor]))
  const days = new Map<string, string>()
  for (const row of invoices) {
    let today = days.get(row.projectId)
    if (today === undefined) {
      today = await todayOf(row.projectId)
      days.set(row.projectId, today)
    }
    const reading = invoicePayment({ grossMinor: row.grossMinor, creditedMinor: creditedBy.get(row.id) ?? 0, allocatedMinor: allocatedBy.get(row.id) ?? 0, dueOn: row.dueOn, today })
    standings.set(row.id, { paidMinor: reading.paidMinor, outstandingMinor: reading.outstandingMinor, paymentStatus: reading.status })
  }
  return standings
}

/** The document on the wire, standing as given or, where none is, as it stood on the day it was issued. */
export function invoiceOf(row: InvoiceRow, standing: InvoiceStanding = issueStanding(row)): Invoice {
  return {
    id: row.id,
    recordedAt: row.recordedAt.toISOString(),
    projectId: row.projectId,
    number: row.number,
    label: labelOf(row),
    kind: row.kind as InvoiceKind,
    customerId: row.customerId,
    currency: row.currency,
    issuedOn: row.issuedOn,
    dueOn: row.dueOn,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    billingRunId: row.billingRunId,
    creditsInvoiceId: row.creditsInvoiceId,
    creditReason: row.creditReason as CreditReason | null,
    creditNote: row.creditNote,
    netMinor: row.netMinor,
    vatMinor: row.vatMinor,
    grossMinor: row.grossMinor,
    issuedBy: row.issuedBy,
    paymentReference: row.paymentReference,
    ...standing,
  }
}

export const lineColumns = {
  id: invoiceLine.id,
  recordedAt: invoiceLine.recordedAt,
  invoiceId: invoiceLine.invoiceId,
  position: invoiceLine.position,
  billableEventId: invoiceLine.billableEventId,
  creditsLineId: invoiceLine.creditsLineId,
  description: invoiceLine.description,
  productId: invoiceLine.productId,
  serviceDate: invoiceLine.serviceDate,
  quantity: invoiceLine.quantity,
  unitPriceMinor: invoiceLine.unitPriceMinor,
  netMinor: invoiceLine.netMinor,
  vatPercent: invoiceLine.vatPercent,
  vatMinor: invoiceLine.vatMinor,
}

export type LineRow = Pick<typeof invoiceLine.$inferSelect, keyof typeof lineColumns>

/** The line on the wire. */
export function lineOf(row: LineRow): InvoiceLine {
  return {
    id: row.id,
    recordedAt: row.recordedAt.toISOString(),
    invoiceId: row.invoiceId,
    position: row.position,
    billableEventId: row.billableEventId,
    creditsLineId: row.creditsLineId,
    description: row.description,
    productId: row.productId,
    serviceDate: row.serviceDate,
    quantity: row.quantity,
    unitPriceMinor: row.unitPriceMinor,
    netMinor: row.netMinor,
    vatPercent: row.vatPercent,
    vatMinor: row.vatMinor,
  }
}

/** One document's lines, by position. */
export async function linesOf(tx: Tx, companyId: string, invoiceId: string): Promise<LineRow[]> {
  return await tx
    .select(lineColumns)
    .from(invoiceLine)
    .where(and(eq(invoiceLine.companyId, companyId), eq(invoiceLine.invoiceId, invoiceId)))
    .orderBy(asc(invoiceLine.position))
}

/** The credit notes naming one invoice, in numbering order; none name a credit note. */
export async function creditNotesOf(tx: Tx, companyId: string, invoiceId: string): Promise<InvoiceRow[]> {
  return await tx
    .select(invoiceColumns)
    .from(invoice)
    .where(and(eq(invoice.companyId, companyId), eq(invoice.creditsInvoiceId, invoiceId)))
    .orderBy(asc(invoice.id))
}

/** The document with its lines by position and the credit notes naming it, standing as given: what the read answers and what `invoice-issued` carries. */
export async function invoiceDetailOf(tx: Tx, companyId: string, row: InvoiceRow, standing?: InvoiceStanding): Promise<InvoiceDetail> {
  const [lines, creditNotes] = await Promise.all([linesOf(tx, companyId, row.id), creditNotesOf(tx, companyId, row.id)])
  return { ...invoiceOf(row, standing), lines: lines.map(lineOf), creditNotes: creditNotes.map((note) => invoiceOf(note)) }
}
