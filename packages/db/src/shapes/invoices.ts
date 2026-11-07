// An invoice or a credit note on the wire, with its lines (Issue #112):
// `issueInvoice` answers the `InvoiceDetail` it publishes in
// `invoice-issued`, and the office reads a document with how its payments
// stand (#291 C6). A document's `label` is `invoiceLabel(kind, number)`, the
// contracts' one spelling of `INV-26007188` and `CN-26007189`.
import { invoiceLabel } from "@waste/contracts/finance"
import type { Invoice, InvoiceDetail, InvoiceLine } from "@waste/contracts/invoices"
import { invoicePayment, type InvoicePaymentStatus } from "@waste/domain/finance/payments"
import type { CreditReason, InvoiceKind } from "@waste/domain/finance/vocabulary"
import { and, asc, eq, inArray, sum } from "drizzle-orm"

import type { Tx } from "../client"
import { invoice, invoiceLine, paymentAllocation } from "../schema/finance"

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
