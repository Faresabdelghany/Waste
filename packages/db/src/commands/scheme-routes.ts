// What a scheme no longer planning a dated Route writes (Issue #97 part B, O21
// of #290), the one spelling the two processes share: the generation job's
// cleanup in apps/worker (generate-routes.ts), and the archive and the next
// version of a scheme in apps/api (routes/scheme-lifecycle.ts), which end a
// scheme's routes from a day in the request's transaction. Which routes are
// cancelled and which trimmed is the domain's (@waste/domain/planning/
// generation's `planRoutes`, planning/lifecycle's `routesEndedFrom`); these are
// the statements.
//
// A cancel is generation's own: `cancelled` with its instant, marked
// `cancelled_by_generation` with the `regeneration` reason code (O5 of #290),
// the sentence as its note and its hold cleared, since a hold is a planned
// route's (`route_hold_shape`); a run names itself on the route it wrote,
// the API's ending names none and the route keeps the run that last wrote it.
// A stop the scheme no longer plans is `skipped` with `regeneration` as its
// reason and the sentence as its note. Nothing is deleted.
import { REGENERATION_CANCEL } from "@waste/domain/execution/vocabulary"
import { and, eq, inArray } from "drizzle-orm"

import type { Tx } from "../client"
import { pickup, route } from "../schema/execution"

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
