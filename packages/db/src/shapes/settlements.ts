// A settlement on the wire with its lines (Issue #112, §3 "Settlements"): the
// columns, the row with its assignment's provider, `settlementsFrom` (the one
// statement every settlement is read through), `settlementOf` and
// `settlementDetailOf`, which the office's and the provider's reads answer
// and `settlement-closed` carries.
import type { Settlement, SettlementDetail, SettlementLine } from "@waste/contracts/settlements"
import { addDays } from "@waste/domain/days"
import { and, asc, eq, inArray } from "drizzle-orm"

import type { Tx } from "../client"
import { serviceAreaAssignment, settlement, settlementLine } from "../schema/finance"
import { serviceProvider } from "../schema/organisation"
import { instantOf, stampsOf } from "./times"

export const settlementColumns = {
  id: settlement.id,
  projectId: settlement.projectId,
  serviceAreaAssignmentId: settlement.serviceAreaAssignmentId,
  status: settlement.status,
  currency: settlement.currency,
  calculatedAt: settlement.calculatedAt,
  closedAt: settlement.closedAt,
  closedBy: settlement.closedBy,
  lineCount: settlement.lineCount,
  netMinor: settlement.netMinor,
  validFrom: settlement.validFrom,
  validTo: settlement.validTo,
  createdAt: settlement.createdAt,
  updatedAt: settlement.updatedAt,
}

/** The settlement's columns and, through its assignment, whose it is: the provider's id for the scope and its name for the sentences. */
export type SettlementRow = Pick<typeof settlement.$inferSelect, keyof typeof settlementColumns> & { serviceProviderId: string; providerLegalName: string }

/** The period's last day in: the day before its end, the first day out. */
export const lastDayOf = (row: SettlementRow): string => addDays(periodEnd(row), -1)

/** How every sentence names a settlement: the provider and the period as a person reads it, `NordRen ApS · 2026-07-01–2026-07-31`, the last day inside and not the first day out. */
export const labelOf = (row: SettlementRow): string => `${row.providerLegalName} · ${row.validFrom}–${lastDayOf(row)}`

/** The end every settlement has (`settlement_period_closed`): a null beside a settlement is a broken invariant, not a client's doing. */
export function periodEnd(row: { id: string; validTo: string | null }): string {
  if (row.validTo === null) throw new Error(`settlement ${row.id} has no end to its period`)
  return row.validTo
}

/** The row on the wire. The status is text with a CHECK in the database and an enum here. */
export function settlementOf(row: SettlementRow): Settlement {
  return {
    id: row.id,
    projectId: row.projectId,
    serviceAreaAssignmentId: row.serviceAreaAssignmentId,
    status: row.status,
    currency: row.currency,
    calculatedAt: instantOf(row.calculatedAt),
    closedAt: instantOf(row.closedAt),
    closedBy: row.closedBy,
    lineCount: row.lineCount,
    netMinor: row.netMinor,
    validFrom: row.validFrom,
    validTo: periodEnd(row),
    ...stampsOf(row),
  }
}

/** The one statement every settlement is read through: the row with its assignment's provider joined, for the scope and the sentences. */
export function settlementsFrom(tx: Tx) {
  return tx
    .select({ ...settlementColumns, serviceProviderId: serviceAreaAssignment.serviceProviderId, providerLegalName: serviceProvider.legalName })
    .from(settlement)
    .innerJoin(serviceAreaAssignment, and(eq(serviceAreaAssignment.companyId, settlement.companyId), eq(serviceAreaAssignment.id, settlement.serviceAreaAssignmentId)))
    .innerJoin(serviceProvider, and(eq(serviceProvider.companyId, settlement.companyId), eq(serviceProvider.id, serviceAreaAssignment.serviceProviderId)))
}

export const lineColumns = {
  id: settlementLine.id,
  settlementId: settlementLine.settlementId,
  billableEventId: settlementLine.billableEventId,
  serviceProviderPriceId: settlementLine.serviceProviderPriceId,
  quantity: settlementLine.quantity,
  unitPriceMinor: settlementLine.unitPriceMinor,
  netMinor: settlementLine.netMinor,
  createdAt: settlementLine.createdAt,
  updatedAt: settlementLine.updatedAt,
}

export type LineRow = Pick<typeof settlementLine.$inferSelect, keyof typeof lineColumns>

export const lineOf = (row: LineRow): SettlementLine => ({
  id: row.id,
  settlementId: row.settlementId,
  billableEventId: row.billableEventId,
  serviceProviderPriceId: row.serviceProviderPriceId,
  quantity: row.quantity,
  unitPriceMinor: row.unitPriceMinor,
  netMinor: row.netMinor,
  ...stampsOf(row),
})

export async function linesOf(tx: Tx, companyId: string, settlementId: string): Promise<LineRow[]> {
  return await tx
    .select(lineColumns)
    .from(settlementLine)
    .where(and(eq(settlementLine.companyId, companyId), eq(settlementLine.settlementId, settlementId)))
    .orderBy(asc(settlementLine.billableEventId))
}

/** The settlement with its lines: what the read, the create and every command answer, so what a write says is what the next read says. */
export async function settlementDetailOf(tx: Tx, companyId: string, row: SettlementRow): Promise<SettlementDetail> {
  const lines = await linesOf(tx, companyId, row.id)
  return { ...settlementOf(row), lines: lines.map(lineOf) }
}

/** A page's lines in one statement, grouped by settlement, so fifty settlements cost one read and not fifty. */
export async function linesBySettlement(tx: Tx, companyId: string, ids: readonly string[]): Promise<Map<string, LineRow[]>> {
  const grouped = new Map<string, LineRow[]>(ids.map((id) => [id, []]))
  if (ids.length === 0) return grouped
  const rows = await tx
    .select(lineColumns)
    .from(settlementLine)
    .where(and(eq(settlementLine.companyId, companyId), inArray(settlementLine.settlementId, [...ids])))
    .orderBy(asc(settlementLine.billableEventId))
  for (const row of rows) grouped.get(row.settlementId)?.push(row)
  return grouped
}
