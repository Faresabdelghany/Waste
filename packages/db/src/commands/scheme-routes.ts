// What a scheme no longer planning a dated Route reads and writes (Issue #97
// part B, O21 of #290), the one spelling the two processes share: the
// generation job's cleanup in apps/worker (generate-routes.ts), and the
// archive and the next version of a scheme in apps/api
// (routes/scheme-lifecycle.ts), which end a scheme's routes from a day in the
// request's transaction (`endSchemeRoutes`). Which routes are cancelled and
// which trimmed is the domain's (@waste/domain/planning/generation's
// `planRoutes`, planning/lifecycle's `routesEndedFrom`); what the decision
// reads — the scheme's routes under their row locks in id order, the order a
// run and a bulk dispatch lock them in, and the planned ones' open stops,
// the office's among them — and the statements are here.
//
// A cancel is generation's own: `cancelled` with its instant, marked
// `cancelled_by_generation` with the `regeneration` reason code (O5 of #290),
// the sentence as its note and its hold cleared, since a hold is a planned
// route's (`route_hold_shape`); a run names itself on the route it wrote,
// the API's ending names none and the route keeps the run that last wrote it.
// A stop the scheme no longer plans is `skipped` with `regeneration` as its
// reason and the sentence as its note. Nothing is deleted.
import type { SchemeEndingCounts } from "@waste/contracts/route-schemes"
import { REGENERATION_CANCEL, type RouteStatus } from "@waste/domain/execution/vocabulary"
import { routesEndedFrom } from "@waste/domain/planning/lifecycle"
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm"

import type { Tx } from "../client"
import { pickup, route } from "../schema/execution"

/** The scheme's routes over service dates from `from` through `to` (no end where none), under their row locks in id order: a dispatch racing the caller takes its turn, and a bulk dispatch, which locks its routes in the same order, never waits on the caller's second row while it waits on its first. */
export async function lockSchemeRoutes(tx: Tx, companyId: string, schemeId: string, window: { from: string; to?: string }) {
  return await tx
    .select()
    .from(route)
    .where(and(eq(route.companyId, companyId), eq(route.routeSchemeId, schemeId), gte(route.serviceDate, window.from), window.to === undefined ? undefined : lte(route.serviceDate, window.to)))
    .orderBy(asc(route.id))
    .for("update")
}

/** The open stops of the planned routes, the office's among them. */
export async function openStopsOf(tx: Tx, companyId: string, plannedRouteIds: readonly string[]): Promise<{ id: string; routeId: string; origin: string }[]> {
  if (plannedRouteIds.length === 0) return []
  return await tx
    .select({ id: pickup.id, routeId: pickup.routeId, origin: pickup.origin })
    .from(pickup)
    .where(and(eq(pickup.companyId, companyId), inArray(pickup.routeId, [...plannedRouteIds]), eq(pickup.status, "planned")))
}

/** The routes carrying an open stop the office added (#111): trimmed, never cancelled under it. */
export const routesWithOfficeStops = (open: readonly { routeId: string; origin: string }[]): Set<string> => new Set(open.filter((row) => row.origin === "office").map((row) => row.routeId))

/** Cancels planned routes by generation, with the sentence; `generationRunId` names the run that did, where a run did. */
export async function cancelRoutesByGeneration(tx: Tx, companyId: string, routeIds: readonly string[], note: string, at: Date, generationRunId: string | null = null): Promise<void> {
  if (routeIds.length === 0) return
  await tx
    .update(route)
    .set({ status: "cancelled", cancelledAt: at, cancelledByGeneration: true, cancelReasonCode: REGENERATION_CANCEL, note, heldAt: null, ...(generationRunId === null ? {} : { generationRunId }) })
    .where(and(eq(route.companyId, companyId), inArray(route.id, [...routeIds])))
}

/** Skips open stops the scheme no longer plans, by regeneration with the sentence. */
export async function skipStopsByGeneration(tx: Tx, companyId: string, pickupIds: readonly string[], note: string, at: Date): Promise<void> {
  if (pickupIds.length === 0) return
  await tx.update(pickup).set({ status: "skipped", reason: "regeneration", note, outcomeAt: at }).where(and(eq(pickup.companyId, companyId), inArray(pickup.id, [...pickupIds])))
}

/**
 * Ends the scheme's routes from `from`, as the archive and the next version
 * do: each planned one cancelled or trimmed as the domain decides — a
 * cancelled route's every open stop skipped, a trimmed one's own, the
 * office's standing — and the dispatched and running ones counted.
 */
export async function endSchemeRoutes(tx: Tx, companyId: string, schemeId: string, from: string, note: string, at: Date): Promise<SchemeEndingCounts> {
  const routes = await lockSchemeRoutes(tx, companyId, schemeId, { from })
  const open = await openStopsOf(
    tx,
    companyId,
    routes.filter((row) => row.status === "planned").map((row) => row.id),
  )
  const officeStops = routesWithOfficeStops(open)
  const ending = routesEndedFrom(
    routes.map((row) => ({
      id: row.id,
      // A scheme's route always carries its group (`route_scheme_shape`); only the office's ad-hoc route has none, and it has no scheme.
      collectionGroupId: row.collectionGroupId ?? "",
      serviceDate: row.serviceDate,
      operatingDate: row.operatingDate,
      status: row.status as RouteStatus,
      cancelledByGeneration: row.cancelledByGeneration,
      held: row.heldAt !== null,
      officeStops: officeStops.has(row.id),
    })),
    from,
    note,
  )
  const cancelled = ending.decisions.filter((decision) => decision.kind === "cancel").map((decision) => decision.routeId)
  const trimmed = ending.decisions.filter((decision) => decision.kind === "trim").map((decision) => decision.routeId)
  await cancelRoutesByGeneration(tx, companyId, cancelled, note, at)
  if (trimmed.length > 0) await tx.update(route).set({ note }).where(and(eq(route.companyId, companyId), inArray(route.id, trimmed)))
  const cancelledSet = new Set(cancelled)
  const trimmedSet = new Set(trimmed)
  const skipped = open.filter((row) => cancelledSet.has(row.routeId) || (trimmedSet.has(row.routeId) && row.origin === "generation")).map((row) => row.id)
  await skipStopsByGeneration(tx, companyId, skipped, note, at)
  return { cancelled: cancelled.length, trimmed: trimmed.length, kept: ending.kept }
}
