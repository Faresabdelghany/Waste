// The hold on a dated Route (#209). When the office moves a planned route's
// day, start or Planned Assignment by hand — `reschedule` or `assign`
// (routes/routes.ts) — the route is held (`held_at`, migration 0015), and
// generation's refresh (apps/worker's generate-routes.ts) keeps its day, its
// start and its assignment from then on, its pickups and its note still
// refreshed, so the next run does not revert the office. One hold per route,
// not per field: it covers the operating date, the planned start and the
// Planned Assignment — the vehicle, the driver, the provider, the trailer, the
// depot and the unloading station.
//
// A hold is a planned route's (`route_hold_shape`): generation refreshes
// nothing else, so `dispatch` clears it, and so does either cancel — the
// office's, or generation's when the scheme no longer runs the collection, a
// route it brings back later returning to its scheme.
//
// An edit of what the hold covers releases it, in the edit's transaction, so
// the next run brings those routes back to the scheme: the scheme's planned
// start, depot, unloading station or service days — what every route of the
// scheme copies or runs on — release every held route of the scheme; a
// group's vehicle, driver, provider or days — what that group's routes copy
// or run on — release that group's alone, since another group's routes copy
// nothing from it. The scheme's `PATCH` (with or without `collectionGroups`,
// routes/route-schemes.ts) and the group's `PATCH` (routes/collection-groups.ts)
// both ask this module. Both hold the scheme's row lock, which a generation
// run takes before it reads a route, so a release and a run take turns. A
// held route is a planned one, so a release never writes a route that was
// dispatched.
import { withinServiceDays } from "@waste/contracts/route-schemes"
import type { Tx } from "@waste/db/client"
import { route } from "@waste/db/schema/execution"
import { and, eq, inArray, isNotNull } from "drizzle-orm"

import type { Principal } from "../auth/principal"
import { routeScope } from "./execution-shapes"
import { timeOf } from "./shared"

/** The scheme's fields a hold covers, as the stored row carries them: the start as Postgres spells a time. */
type SchemeCovered = { plannedStartTime: string | null; depotId: string | null; unloadingStationId: string | null; serviceDays: readonly string[] }

/** The same fields as a patch gives them, each optional; the start on the wire's clock, `HH:MM`. */
type SchemeCoveredPatch = Partial<SchemeCovered>

/** A group's fields a hold covers. */
export type GroupCovered = { vehicleId: string | null; driverId: string | null; serviceProviderId: string | null; days: readonly string[] }

/** Two sets of days alike, whatever order they were given in: each within the other, in the contracts' one spelling of within. */
const sameDays = (a: readonly string[], b: readonly string[]): boolean => withinServiceDays(a, b) && withinServiceDays(b, a)

/** Whether a scheme patch moves what every route of the scheme copies or runs on: its start, its depot, its station or its service days. */
export function schemeMovesHeld(current: SchemeCovered, patch: SchemeCoveredPatch): boolean {
  return (
    (patch.plannedStartTime !== undefined && patch.plannedStartTime !== (current.plannedStartTime === null ? null : timeOf(current.plannedStartTime))) ||
    (patch.depotId !== undefined && patch.depotId !== current.depotId) ||
    (patch.unloadingStationId !== undefined && patch.unloadingStationId !== current.unloadingStationId) ||
    (patch.serviceDays !== undefined && !sameDays(patch.serviceDays, current.serviceDays))
  )
}

/** Whether a group as an edit leaves it moves what its routes copy or run on: its vehicle, its driver, its provider or its days. */
export function groupMovesHeld(before: GroupCovered, after: GroupCovered): boolean {
  return before.vehicleId !== after.vehicleId || before.driverId !== after.driverId || before.serviceProviderId !== after.serviceProviderId || !sameDays(before.days, after.days)
}

/**
 * Releases the holds of the scheme's routes, or of the named groups' routes,
 * in the edit's transaction: each held route goes back to being the scheme's,
 * which the next generation run then refreshes in full. Fenced like every
 * route statement (`routeScope`: the tenant and the caller's projects), and
 * to the scheme's own project.
 */
export async function releaseHolds(tx: Tx, principal: Principal, projectId: string, of: { routeSchemeId: string } | { collectionGroupIds: readonly string[] }): Promise<void> {
  const routes = "routeSchemeId" in of ? eq(route.routeSchemeId, of.routeSchemeId) : of.collectionGroupIds.length === 0 ? undefined : inArray(route.collectionGroupId, [...of.collectionGroupIds])
  if (routes === undefined) return
  await tx
    .update(route)
    .set({ heldAt: null })
    .where(and(routeScope(principal), eq(route.projectId, projectId), routes, isNotNull(route.heldAt)))
}
