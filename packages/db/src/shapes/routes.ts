// A route on the wire (Issue #104): the columns every route statement
// selects, the row type, and `routeOf`. The office's commands and the driver
// door emit the route events with the `Route` as the route answers it, through
// these.
//
// A route's `progress` is derived and never stored (#104 §2): one aggregate
// over the page's ids, grouped by route and status, folded by the domain's
// `progressOf`, so a page of fifty routes costs one statement and not fifty,
// and the list, the single read and the live read all answer the same fold.
//
// The route's `label` is `routeLabel(number)`, the contracts' one spelling of
// `RC-1042`, and every sentence names a route by it. `generationRunId` is the
// column since migration 0012 (#97 part B): the run that last wrote the route,
// null on one no run has, and on the office's ad-hoc route. `heldAt` is the
// column since 0015 (#209): the hold `assign` and `reschedule` put on a
// planned route, which generation's refresh keeps. Since 0016 (#111) a
// route's scheme and group are null together on an ad-hoc route.
import type { Route, RouteProgress } from "@waste/contracts/routes"
import { progressOf, type PickupCounts } from "@waste/domain/execution/progress"
import { PICKUP_STATUSES, type PickupStatus } from "@waste/domain/execution/vocabulary"
import { routeLabel } from "@waste/domain/numbering"
import { and, count, eq, inArray } from "drizzle-orm"

import type { Tx } from "../client"
import { pickup, route } from "../schema/execution"
import { instantOf, stampsOf, timeOf } from "./times"

export const routeColumns = {
  id: route.id,
  projectId: route.projectId,
  routeSchemeId: route.routeSchemeId,
  collectionGroupId: route.collectionGroupId,
  serviceDate: route.serviceDate,
  operatingDate: route.operatingDate,
  number: route.number,
  status: route.status,
  note: route.note,
  cancelReasonCode: route.cancelReasonCode,
  cancelledByGeneration: route.cancelledByGeneration,
  generationRunId: route.generationRunId,
  activePlanId: route.activePlanId,
  plannedStartTime: route.plannedStartTime,
  plannedVehicleId: route.plannedVehicleId,
  plannedDriverId: route.plannedDriverId,
  plannedTrailerId: route.plannedTrailerId,
  depotId: route.depotId,
  plannedServiceProviderId: route.plannedServiceProviderId,
  unloadingStationId: route.unloadingStationId,
  heldAt: route.heldAt,
  actualVehicleId: route.actualVehicleId,
  actualDriverId: route.actualDriverId,
  actualTrailerId: route.actualTrailerId,
  dispatchedAt: route.dispatchedAt,
  startedAt: route.startedAt,
  completedAt: route.completedAt,
  cancelledAt: route.cancelledAt,
  createdAt: route.createdAt,
  updatedAt: route.updatedAt,
}

export type RouteRow = Pick<typeof route.$inferSelect, keyof typeof routeColumns>

/** How every sentence names a route: `RC-1042`. */
export const labelOf = (row: { number: number }): string => routeLabel(row.number)

/** The row on the wire with the progress read for it. The status is text with a CHECK in the database and an enum here; the start drops Postgres's seconds. */
export function routeOf(row: RouteRow, progress: RouteProgress): Route {
  return {
    id: row.id,
    projectId: row.projectId,
    routeSchemeId: row.routeSchemeId,
    collectionGroupId: row.collectionGroupId,
    serviceDate: row.serviceDate,
    operatingDate: row.operatingDate,
    number: row.number,
    label: labelOf(row),
    status: row.status,
    note: row.note,
    cancelReasonCode: row.cancelReasonCode,
    cancelledByGeneration: row.cancelledByGeneration,
    generationRunId: row.generationRunId,
    plannedStartTime: row.plannedStartTime === null ? null : timeOf(row.plannedStartTime),
    planned: {
      vehicleId: row.plannedVehicleId,
      driverId: row.plannedDriverId,
      trailerId: row.plannedTrailerId,
      serviceProviderId: row.plannedServiceProviderId,
      depotId: row.depotId,
      unloadingStationId: row.unloadingStationId,
    },
    heldAt: instantOf(row.heldAt),
    actual: { vehicleId: row.actualVehicleId, driverId: row.actualDriverId, trailerId: row.actualTrailerId },
    dispatchedAt: instantOf(row.dispatchedAt),
    startedAt: instantOf(row.startedAt),
    completedAt: instantOf(row.completedAt),
    cancelledAt: instantOf(row.cancelledAt),
    progress,
    ...stampsOf(row),
  }
}

/** A count of zero for every pickup status, the vocabulary's. */
const noneOfEach = (): Record<PickupStatus, number> => Object.fromEntries(PICKUP_STATUSES.map((status) => [status, 0])) as Record<PickupStatus, number>

/**
 * The progress of every route asked for, by route: one aggregate over the
 * page's ids grouped by route and status, folded by the domain. A route with
 * no pickups is absent from the counts and reads as done at zero, so a caller
 * reads through `progressFor`.
 */
export async function progressByRoute(tx: Tx, companyId: string, routeIds: readonly string[]): Promise<Map<string, RouteProgress>> {
  const byRoute = new Map<string, Record<PickupStatus, number>>()
  if (routeIds.length === 0) return new Map()
  const rows = await tx
    .select({ routeId: pickup.routeId, status: pickup.status, n: count() })
    .from(pickup)
    .where(and(eq(pickup.companyId, companyId), inArray(pickup.routeId, [...routeIds])))
    .groupBy(pickup.routeId, pickup.status)
  for (const row of rows) {
    const counts = byRoute.get(row.routeId) ?? noneOfEach()
    counts[row.status] = row.n
    byRoute.set(row.routeId, counts)
  }
  return new Map(routeIds.map((id) => [id, progressOf(byRoute.get(id) ?? {})] as const))
}

/** The progress of one route out of a page's, or the empty fold for a route the aggregate did not mention. */
export const progressFor = (progress: ReadonlyMap<string, RouteProgress>, routeId: string): RouteProgress => progress.get(routeId) ?? progressOf({} as Partial<PickupCounts>)

/** The routes on the wire, their progress read in one statement. */
export async function routesOf(tx: Tx, companyId: string, rows: readonly RouteRow[]): Promise<Route[]> {
  const progress = await progressByRoute(
    tx,
    companyId,
    rows.map((row) => row.id),
  )
  return rows.map((row) => routeOf(row, progressFor(progress, row.id)))
}

/** One route on the wire, its progress read the way a page reads it, so what a write answers is what the next read says. */
export async function routeWithProgress(tx: Tx, companyId: string, row: RouteRow): Promise<Route> {
  const [answered] = await routesOf(tx, companyId, [row])
  return answered
}
