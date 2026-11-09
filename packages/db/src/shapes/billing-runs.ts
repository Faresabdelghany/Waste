// A billing run on the wire (Issue #112): `runBilling` answers the run's
// row and its exclusions, and the office reads a run with the payers it
// excluded and the invoices it issued (`runDetailOf`).
import type { BillingRun, BillingRunDetail, BillingRunExclusion } from "@waste/contracts/billing"
import { and, asc, eq } from "drizzle-orm"

import type { Tx } from "../client"
import { billingRun, billingRunExclusion, invoice } from "../schema/finance"
import { instantOf, stampsOf } from "./times"

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

export function runOf(row: RunRow): BillingRun {
  return {
    id: row.id,
    projectId: row.projectId,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    status: row.status,
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

export function exclusionOf(row: ExclusionRow): BillingRunExclusion {
  return {
    id: row.id,
    recordedAt: row.recordedAt.toISOString(),
    billingRunId: row.billingRunId,
    customerId: row.customerId,
    reason: row.reason,
    eventCount: row.eventCount,
  }
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
