// The reads a Pickup Exception is judged from (Issue #293, M5), shared by the
// API's history of a place (apps/api/src/routes/pickup-exceptions.ts, M5a)
// and the Finance consumer that charges one at its stop's event (M5b,
// apps/worker/src/jobs/finance-facts.ts): a project's rules with their
// ladders, the stops at a place that are exceptions as their rows say so,
// and the proof that recorded each stop's outcome. The judging is the
// domain's (@waste/domain/execution/pickup-exceptions); these are the
// statements it asks for, spelled once so the history and the charge read the
// same rows.
import type { PickupExceptionRuleFacts, PickupExceptionStop } from "@waste/domain/execution/pickup-exceptions"
import { CODED_PROOF_KINDS, PICKUP_EXCEPTION_REASONS, type PickupOrigin, type PickupOutcome, type PickupReason, type PickupService, type PickupStatus } from "@waste/domain/execution/vocabulary"
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, or, type SQL } from "drizzle-orm"

import type { Tx } from "../client"
import { pickup, proofOfService, route } from "../schema/execution"
import { pickupExceptionRule, pickupExceptionRuleStep } from "../schema/pickup-exceptions"

/** Each rule's ladder by position, for the rules named. */
export async function laddersOf(tx: Tx, companyId: string, ruleIds: readonly string[]): Promise<Map<string, string[]>> {
  const ladders = new Map<string, string[]>()
  if (ruleIds.length === 0) return ladders
  const steps = await tx
    .select({ ruleId: pickupExceptionRuleStep.ruleId, productId: pickupExceptionRuleStep.productId })
    .from(pickupExceptionRuleStep)
    .where(and(eq(pickupExceptionRuleStep.companyId, companyId), inArray(pickupExceptionRuleStep.ruleId, [...ruleIds])))
    .orderBy(asc(pickupExceptionRuleStep.ruleId), asc(pickupExceptionRuleStep.position))
  for (const step of steps) ladders.set(step.ruleId, [...(ladders.get(step.ruleId) ?? []), step.productId])
  return ladders
}

/** The rules of one project, any period, as the domain reads them. */
export async function exceptionRulesOf(tx: Tx, companyId: string, projectId: string): Promise<PickupExceptionRuleFacts[]> {
  const rows = await tx
    .select({
      id: pickupExceptionRule.id,
      validFrom: pickupExceptionRule.validFrom,
      validTo: pickupExceptionRule.validTo,
      outcome: pickupExceptionRule.outcome,
      reason: pickupExceptionRule.reason,
      contaminantCodeId: pickupExceptionRule.contaminantCodeId,
      freeCount: pickupExceptionRule.freeCount,
      windowDays: pickupExceptionRule.windowDays,
    })
    .from(pickupExceptionRule)
    .where(and(eq(pickupExceptionRule.companyId, companyId), eq(pickupExceptionRule.projectId, projectId)))
  const ladders = await laddersOf(
    tx,
    companyId,
    rows.map((row) => row.id),
  )
  return rows.map((row) => ({
    id: row.id,
    validFrom: row.validFrom,
    validTo: row.validTo,
    outcome: row.outcome as PickupOutcome,
    reason: row.reason as PickupReason | null,
    contaminantCodeId: row.contaminantCodeId,
    freeCount: row.freeCount,
    windowDays: row.windowDays,
    ladder: ladders.get(row.id) ?? [],
  }))
}

/** The stops that are exceptions as a row says so: missed for a reason the customer caused, or collected but tagged — the domain's `isPickupException` in SQL. */
export const pickupExceptionRows = (): SQL | undefined =>
  or(
    and(inArray(pickup.status, ["failed", "skipped"]), inArray(pickup.reason, [...PICKUP_EXCEPTION_REASONS])),
    and(eq(pickup.status, "completed"), isNotNull(pickup.contaminantCodeId)),
  )

/** The place a stop is counted at: its Property, or its Shared Collection Point. */
export type ExceptionPlace = { kind: "property" | "point"; id: string }

/** A stop's place as the ladder counts it, from its two columns; undefined for a stop at neither (an address-only stop). */
export const placeOf = (stop: { propertyId: string | null; sharedCollectionPointId: string | null }): ExceptionPlace | undefined =>
  stop.sharedCollectionPointId !== null ? { kind: "point", id: stop.sharedCollectionPointId } : stop.propertyId !== null ? { kind: "property", id: stop.propertyId } : undefined

/**
 * The exceptions at a place in one project with service dates from `from` to
 * `to`, both inclusive, as the domain counts them: what a stop's ladder is
 * judged over. Every row read is an exception by its row.
 */
export async function exceptionStopsAt(tx: Tx, companyId: string, projectId: string, place: ExceptionPlace, from: string, to: string): Promise<PickupExceptionStop[]> {
  const placeColumn = place.kind === "property" ? pickup.propertyId : pickup.sharedCollectionPointId
  const rows = await tx
    .select({ id: pickup.id, status: pickup.status, reason: pickup.reason, contaminantCodeId: pickup.contaminantCodeId, origin: pickup.origin, service: pickup.service, serviceDate: route.serviceDate })
    .from(pickup)
    .innerJoin(route, and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)))
    .where(and(eq(pickup.companyId, companyId), eq(pickup.projectId, projectId), eq(placeColumn, place.id), gte(route.serviceDate, from), lte(route.serviceDate, to), pickupExceptionRows()))
    .orderBy(asc(route.serviceDate), asc(pickup.id))
  return rows.map((row) => ({
    id: row.id,
    status: row.status as PickupStatus,
    reason: row.reason as PickupReason | null,
    contaminantCodeId: row.contaminantCodeId,
    origin: row.origin as PickupOrigin,
    service: row.service as PickupService,
    serviceDate: row.serviceDate,
    place: place.id,
  }))
}

/** The latest proof recording each stop's outcome — the driver's completion, skip or failure, or the office's correction — by stop. */
export async function latestOutcomeProofs(tx: Tx, companyId: string, pickupIds: readonly string[]): Promise<Map<string, string>> {
  if (pickupIds.length === 0) return new Map()
  const rows = await tx
    .selectDistinctOn([proofOfService.pickupId], { pickupId: proofOfService.pickupId, id: proofOfService.id })
    .from(proofOfService)
    .where(and(eq(proofOfService.companyId, companyId), inArray(proofOfService.pickupId, [...pickupIds]), inArray(proofOfService.kind, [...CODED_PROOF_KINDS])))
    // The server's clock, then the id: a driver's proof is minted on the device's clock, which may run ahead of the office's correction recorded after it.
    .orderBy(asc(proofOfService.pickupId), desc(proofOfService.recordedAt), desc(proofOfService.id))
  return new Map(rows.flatMap((row) => (row.pickupId === null ? [] : [[row.pickupId, row.id] as const])))
}
