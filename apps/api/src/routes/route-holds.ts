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
// start, depot or unloading station — what every route of the scheme copies —
// release every held route of the scheme; a group's vehicle, driver or
// provider — what that group's routes copy — release that group's alone,
// since another group's routes copy nothing from it. A change of days, the
// scheme's or a group's, releases only the held routes whose own collection it
// takes away, on a weekday the days no longer hold: one that adds a day
// releases nothing, since no held route's collection changed (#226). A held
// route on a weekday taken away is cancelled by the next run all the same,
// which clears its hold; released here, it no longer reads as held on a
// collection the scheme dropped. `release-hold` (routes/routes.ts) hands one
// route back by hand. The scheme's `PATCH` (with or without `collectionGroups`,
// routes/route-schemes.ts) and the group's `PATCH` (routes/collection-groups.ts)
// both ask this module. Both hold the scheme's row lock, which a generation
// run takes before it reads a route, so a release and a run take turns. A
// held route is a planned one, so a release never writes a route that was
// dispatched.
import { serviceDayOf } from "@waste/domain/route-schemes/recurrence"
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

/** What an edit releases of the held routes it reaches: every one, those on the weekdays it takes away, or none. */
export type HoldRelease = { kind: "all" } | { kind: "days"; left: readonly string[] } | { kind: "none" }

/** The days `before` holds that `after` does not: the collections an edit of days takes away. */
const daysTakenAway = (before: readonly string[], after: readonly string[]): string[] => before.filter((day) => !after.includes(day))

/** A change of days as a release: the held routes on a weekday taken away, or none where the days only grew. */
const daysRelease = (before: readonly string[], after: readonly string[]): HoldRelease => {
  const left = daysTakenAway(before, after)
  return left.length === 0 ? { kind: "none" } : { kind: "days", left }
}

/** What a scheme patch releases: every held route of the scheme where it moves what they all copy — the start, the depot, the station — else those on the service days it takes away. */
export function schemeReleases(current: SchemeCovered, patch: SchemeCoveredPatch): HoldRelease {
  if (
    (patch.plannedStartTime !== undefined && patch.plannedStartTime !== (current.plannedStartTime === null ? null : timeOf(current.plannedStartTime))) ||
    (patch.depotId !== undefined && patch.depotId !== current.depotId) ||
    (patch.unloadingStationId !== undefined && patch.unloadingStationId !== current.unloadingStationId)
  ) {
    return { kind: "all" }
  }
  return patch.serviceDays === undefined ? { kind: "none" } : daysRelease(current.serviceDays, patch.serviceDays)
}

/** What a group as an edit leaves it releases: every held route of the group where its vehicle, driver or provider moved, else those on the days it takes away. */
export function groupReleases(before: GroupCovered, after: GroupCovered): HoldRelease {
  if (before.vehicleId !== after.vehicleId || before.driverId !== after.driverId || before.serviceProviderId !== after.serviceProviderId) return { kind: "all" }
  return daysRelease(before.days, after.days)
}

/**
 * Releases the holds of the scheme's routes, or of the named groups' routes,
 * as `release` says — all of them, or those on a weekday taken away — in the
 * edit's transaction: each released route goes back to being the scheme's,
 * which the next generation run then refreshes in full. Fenced like every
 * route statement (`routeScope`: the tenant and the caller's projects), and
 * to the scheme's own project.
 */
export async function releaseHolds(tx: Tx, principal: Principal, projectId: string, of: { routeSchemeId: string } | { collectionGroupIds: readonly string[] }, release: HoldRelease = { kind: "all" }): Promise<void> {
  if (release.kind === "none") return
  const routes = "routeSchemeId" in of ? eq(route.routeSchemeId, of.routeSchemeId) : of.collectionGroupIds.length === 0 ? undefined : inArray(route.collectionGroupId, [...of.collectionGroupIds])
  if (routes === undefined) return
  const held = and(routeScope(principal), eq(route.projectId, projectId), routes, isNotNull(route.heldAt))
  if (release.kind === "all") {
    await tx.update(route).set({ heldAt: null }).where(held)
    return
  }
  // The held routes whose own collection the edit took away: on a weekday the days no longer hold, by the route's service date — its identity, which a day move by hand never changes.
  const candidates = await tx.select({ id: route.id, serviceDate: route.serviceDate }).from(route).where(held)
  const away = candidates.filter((row) => release.left.includes(serviceDayOf(row.serviceDate))).map((row) => row.id)
  if (away.length > 0) await tx.update(route).set({ heldAt: null }).where(and(held, inArray(route.id, away)))
}
