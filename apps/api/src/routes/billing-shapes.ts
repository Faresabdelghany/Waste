// What the billing half of Finance & Contracting's route modules share
// (Issue #112, slice 4): the rows of `billable_event`, `billing_run`,
// `billing_run_exclusion`, `invoice` and `invoice_line` on the wire, the
// office's scope every statement is bounded by — the tenant and `inProjects`
// — the one statement a billable event is read through, and the family's
// 404s, so routes/billable-events.ts, routes/billable-writes.ts,
// routes/billing-runs.ts, routes/invoice-writes.ts and routes/invoices.ts
// each say only which route does what, the way routes/resolution-shapes.ts
// holds Resolution's shapes for its modules.
//
// A billable event's `status` is a reading and never a column
// (@waste/domain/finance/readings): `invoiced` is an `invoice_line` naming
// the event and `reversed` a `reversal` event naming it, and neither is on
// the event's row. So every event is read through `eventsFrom`, the one
// statement that joins the two LATERAL — one probe per row for the line that
// invoiced it and one for the reversal that undid it, the `assetStateOf`
// precedent (@waste/db/query/asset-state) — and the fold runs over the row
// in `eventOf`, so a page, a single read, the answer to a command and the
// row a write answers all say the same thing about where an event stands.
// `statusIs` is the same fold as a `where`, the four readings as predicates
// over the two subqueries and the two stamps, so a list filters by status in
// SQL without a fifth way of saying what the columns say.
//
// An invoice's `label` is `invoiceLabel(kind, number)`, the contracts' one
// spelling of `INV-26007188` and `CN-26007189`, and every sentence of the
// family names a document by it. Every kind, status and reason column is
// text with a CHECK in the database and an enum on the wire, so the row's
// string is asserted to the vocabulary's type here and nowhere else.
import type { BillableEvent, BillableEventLinks } from "@waste/contracts/billable-events"
import type { BillingRun, BillingRunDetail, BillingRunExclusion } from "@waste/contracts/billing"
import { invoiceLabel } from "@waste/contracts/finance"
import type { Invoice, InvoiceDetail, InvoiceLine } from "@waste/contracts/invoices"
import type { Tx } from "@waste/db/client"
import { billableEvent, billingRun, billingRunExclusion, invoice, invoiceLine } from "@waste/db/schema/finance"
import { billableEventStatus } from "@waste/domain/finance/readings"
import type { BillableEventKind, BillableEventStatus, BillingRunStatus, BlockReason, CancelReason, CreditReason, ExclusionReason, InvoiceKind } from "@waste/domain/finance/vocabulary"
import { and, asc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"

import type { Principal } from "../auth/principal"
import { inProjects } from "../auth/projects"
import { problem } from "../problem"
import { instantOf, stampsOf } from "./shared"

export const noSuchEvent = (id: string) => problem(404, { detail: `No billable event ${id} in the projects this account works in` })
export const noSuchRun = (id: string) => problem(404, { detail: `No billing run ${id} in the projects this account works in` })
export const noSuchInvoice = (id: string) => problem(404, { detail: `No invoice ${id} in the projects this account works in` })

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
  sourceEventId: billableEvent.sourceEventId,
  createdBy: billableEvent.createdBy,
  overrideReason: billableEvent.overrideReason,
  note: billableEvent.note,
  cancelledAt: billableEvent.cancelledAt,
  cancelledBy: billableEvent.cancelledBy,
  cancelReason: billableEvent.cancelReason,
  createdAt: billableEvent.createdAt,
  updatedAt: billableEvent.updatedAt,
}

export type EventRow = Pick<typeof billableEvent.$inferSelect, keyof typeof eventColumns>

/** The event's row beside the two rows that may name it: the line that invoiced it and the reversal that undid it, each null where there is none. */
export type EventReading = EventRow & { invoiceLineId: string | null; reversalId: string | null }

/** The reading a row has the instant it is written: no line and no reversal name it yet, by construction. */
export const UNNAMED = { invoiceLineId: null, reversalId: null }

/** The four links as the wire carries them, off the row's four columns. */
export const linksOf = (row: Pick<EventRow, keyof BillableEventLinks>): BillableEventLinks => ({
  routeId: row.routeId,
  pickupId: row.pickupId,
  ticketId: row.ticketId,
  reversesEventId: row.reversesEventId,
})

/** The status the domain reads off a row and the two rows that may name it. */
export const statusOf = (row: EventReading): BillableEventStatus =>
  billableEventStatus({ blockReason: row.blockReason as BlockReason | null, cancelledAt: row.cancelledAt, invoiced: row.invoiceLineId !== null, reversed: row.reversalId !== null })

/** The billable event on the wire, its status the fold over the reading. */
export function eventOf(row: EventReading): BillableEvent {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind as BillableEventKind,
    status: statusOf(row),
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
    sourceEventId: row.sourceEventId,
    createdBy: row.createdBy,
    overrideReason: row.overrideReason,
    note: row.note,
    cancelledAt: instantOf(row.cancelledAt),
    cancelledBy: row.cancelledBy,
    cancelReason: row.cancelReason as CancelReason | null,
    invoiceLineId: row.invoiceLineId,
    ...stampsOf(row),
  }
}

/** The events of this company, in the projects the caller works in: what every billable event statement is bounded by. */
export const eventScope = (principal: Principal): SQL | undefined => and(eq(billableEvent.companyId, principal.companyId), inProjects(billableEvent.projectId, principal))

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
 * would read as that status.
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
    case "ready":
      return and(notReversed, notInvoiced, notCancelled, isNull(billableEvent.blockReason))
  }
}

/** One billable event of this company by id, inside the caller's projects, with its reading; undefined when it is neither. */
export async function findEvent(tx: Tx, principal: Principal, id: string): Promise<EventReading | undefined> {
  const [row] = await eventsFrom(tx, principal.companyId)
    .query.where(and(eventScope(principal), eq(billableEvent.id, id)))
    .limit(1)
  return row
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

/** The runs of this company, in the projects the caller works in. */
export const runScope = (principal: Principal): SQL | undefined => and(eq(billingRun.companyId, principal.companyId), inProjects(billingRun.projectId, principal))

/** One run of this company by id, inside the caller's projects; undefined when it is neither. */
export async function findRun(tx: Tx, principal: Principal, id: string): Promise<RunRow | undefined> {
  const [row] = await tx
    .select(runColumns)
    .from(billingRun)
    .where(and(runScope(principal), eq(billingRun.id, id)))
    .limit(1)
  return row
}

/** The run with the payers it excluded, in recording order, and the ids of the invoices it issued, in numbering order. */
export async function runDetailOf(tx: Tx, companyId: string, row: RunRow): Promise<BillingRunDetail> {
  const [exclusions, invoices] = await Promise.all([
    tx
      .select(exclusionColumns)
      .from(billingRunExclusion)
      .where(and(eq(billingRunExclusion.companyId, companyId), eq(billingRunExclusion.billingRunId, row.id)))
      .orderBy(asc(billingRunExclusion.id)),
    tx
      .select({ id: invoice.id })
      .from(invoice)
      .where(and(eq(invoice.companyId, companyId), eq(invoice.billingRunId, row.id)))
      .orderBy(asc(invoice.id)),
  ])
  return { ...runOf(row), exclusions: exclusions.map(exclusionOf), invoiceIds: invoices.map((found) => found.id) }
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
}

export type InvoiceRow = Pick<typeof invoice.$inferSelect, keyof typeof invoiceColumns>

/** How every sentence names a document: `INV-26007188`, `CN-26007189`. */
export const labelOf = (row: { kind: string; number: number }): string => invoiceLabel(row.kind as InvoiceKind, row.number)

/** The document on the wire. */
export function invoiceOf(row: InvoiceRow): Invoice {
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

/** The documents of this company, in the projects the caller works in. */
export const invoiceScope = (principal: Principal): SQL | undefined => and(eq(invoice.companyId, principal.companyId), inProjects(invoice.projectId, principal))

/** One document of this company by id, inside the caller's projects; undefined when it is neither. */
export async function findInvoice(tx: Tx, principal: Principal, id: string): Promise<InvoiceRow | undefined> {
  const [row] = await tx
    .select(invoiceColumns)
    .from(invoice)
    .where(and(invoiceScope(principal), eq(invoice.id, id)))
    .limit(1)
  return row
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

/** The document with its lines by position and the credit notes naming it: what the read answers and what `invoice-issued` carries. */
export async function invoiceDetailOf(tx: Tx, companyId: string, row: InvoiceRow): Promise<InvoiceDetail> {
  const [lines, creditNotes] = await Promise.all([linesOf(tx, companyId, row.id), creditNotesOf(tx, companyId, row.id)])
  return { ...invoiceOf(row), lines: lines.map(lineOf), creditNotes: creditNotes.map(invoiceOf) }
}
