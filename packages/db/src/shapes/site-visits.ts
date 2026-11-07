// A recycling-centre visit on the wire (Issue #393, M4 of #293): the
// columns, the row type and `siteVisitOf`, with the fractions it brought.
// `recordVisit` emits `site-visit-recorded` with it, the office's void emits
// `site-visit-voided` with it, and the worker's Finance consumer reads a
// visit through `visitById`.
import type { SiteVisit, VisitChargeQuoted } from "@waste/contracts/site-visits"
import type { SiteVisitIdentification, SiteVisitOutcome, SiteVisitRefusalReason, SiteVisitSource, VisitChargeBasis } from "@waste/domain/visits/vocabulary"
import { and, asc, eq, inArray } from "drizzle-orm"

import type { Tx } from "../client"
import { siteVisit, siteVisitFraction } from "../schema/site-visits"
import { instantOf, stampsOf } from "./times"

export const visitColumns = {
  id: siteVisit.id,
  projectId: siteVisit.projectId,
  siteId: siteVisit.siteId,
  occurredAt: siteVisit.occurredAt,
  serviceDate: siteVisit.serviceDate,
  source: siteVisit.source,
  externalId: siteVisit.externalId,
  identification: siteVisit.identification,
  identifierValue: siteVisit.identifierValue,
  credentialId: siteVisit.credentialId,
  propertyId: siteVisit.propertyId,
  customerId: siteVisit.customerId,
  agreementId: siteVisit.agreementId,
  outcome: siteVisit.outcome,
  refusalReason: siteVisit.refusalReason,
  recordedBy: siteVisit.recordedBy,
  note: siteVisit.note,
  chargeBasis: siteVisit.chargeBasis,
  chargeN: siteVisit.chargeN,
  chargeProductId: siteVisit.chargeProductId,
  voidedAt: siteVisit.voidedAt,
  voidedBy: siteVisit.voidedBy,
  voidReason: siteVisit.voidReason,
  createdAt: siteVisit.createdAt,
  updatedAt: siteVisit.updatedAt,
}

export type VisitRow = Pick<typeof siteVisit.$inferSelect, keyof typeof visitColumns>

/** A visit on the wire, with the fractions it brought. */
export function siteVisitOf(row: VisitRow, wasteFractionIds: readonly string[]): SiteVisit {
  return {
    id: row.id,
    projectId: row.projectId,
    siteId: row.siteId,
    occurredAt: row.occurredAt.toISOString(),
    serviceDate: row.serviceDate,
    source: row.source as SiteVisitSource,
    externalId: row.externalId,
    identification: row.identification as SiteVisitIdentification,
    identifierValue: row.identifierValue,
    credentialId: row.credentialId,
    propertyId: row.propertyId,
    customerId: row.customerId,
    agreementId: row.agreementId,
    outcome: row.outcome as SiteVisitOutcome,
    refusalReason: row.refusalReason as SiteVisitRefusalReason | null,
    recordedBy: row.recordedBy,
    note: row.note,
    wasteFractionIds: [...wasteFractionIds],
    charge: quotedOf(row),
    voidedAt: instantOf(row.voidedAt),
    voidedBy: row.voidedBy,
    voidReason: row.voidReason,
    ...stampsOf(row),
  }
}

/** What a visit's row says it was charged at when it was recorded; null for a refused one. */
export const quotedOf = (row: Pick<VisitRow, "chargeBasis" | "chargeN" | "chargeProductId">): VisitChargeQuoted | null =>
  row.chargeBasis === null ? null : { basis: row.chargeBasis as VisitChargeBasis, n: row.chargeN, productId: row.chargeProductId }

/** The fractions of each visit asked, by visit, in the order they were written. */
export async function fractionsOf(tx: Tx, companyId: string, visitIds: readonly string[]): Promise<Map<string, string[]>> {
  const fractions = new Map<string, string[]>()
  if (visitIds.length === 0) return fractions
  const rows = await tx
    .select({ visitId: siteVisitFraction.visitId, wasteFractionId: siteVisitFraction.wasteFractionId })
    .from(siteVisitFraction)
    .where(and(eq(siteVisitFraction.companyId, companyId), inArray(siteVisitFraction.visitId, [...visitIds])))
    .orderBy(asc(siteVisitFraction.id))
  for (const row of rows) fractions.set(row.visitId, [...(fractions.get(row.visitId) ?? []), row.wasteFractionId])
  return fractions
}

/** One visit of the company with its fractions, or undefined. */
export async function visitById(tx: Tx, companyId: string, id: string): Promise<{ row: VisitRow; visit: SiteVisit } | undefined> {
  const [row] = await tx
    .select(visitColumns)
    .from(siteVisit)
    .where(and(eq(siteVisit.companyId, companyId), eq(siteVisit.id, id)))
    .limit(1)
  if (row === undefined) return undefined
  return { row, visit: siteVisitOf(row, (await fractionsOf(tx, companyId, [row.id])).get(row.id) ?? []) }
}
