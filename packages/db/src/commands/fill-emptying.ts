// The fill-driven emptying (O26 of #290, row 9.10): the worker's
// `fill-threshold` rule, raising an alert for a container whose pairing books
// an emptying, books the office's emptying of it ahead of its next scheduled
// one, in the same transaction as the alert. Which route is the domain's
// (`fillEmptyingRoute`, @waste/domain/execution/fill-emptying); this module
// reads what the choice needs and writes the stop as Add stop
// (apps/api's routes/pickups.ts) writes an emptying: an office stop,
// `planned`, after the route's last position, at the place and fraction of
// the container's placement in force on the route's service date, never the
// same work twice while it is planned, and only where the route's planned
// vehicle serves it (`misfitOf`). The route's `updatedAt` moves and no event
// is written, as Add stop's. Generation never moves or skips an office stop,
// and an office emptying on a route generation has no stop of the container
// stands for the round's emptying of it there.
//
// A refusal — the route started meanwhile, the container placed nowhere that
// day, the vehicle unable to take it — books nothing and is the alert's
// words, never the job's failure: the stop is written in a savepoint, and a
// misfit takes it back.
import { routeLabel } from "@waste/contracts/execution"
import { fillEmptyingRoute, type EmptyingRoute, type FillEmptyingOutcome } from "@waste/domain/execution/fill-emptying"
import { and, asc, eq, gte, inArray, lt, max, sql } from "drizzle-orm"

import type { Tx } from "../client"
import { validOn } from "../query/valid-on"
import { agreement, subscription } from "../schema/agreements"
import { containerServicePlacement } from "../schema/containers"
import { pickup, route } from "../schema/execution"
import { misfitOf, pickupFitStops } from "./fleet-fit"
import { lockRow } from "./shared"

/** The routes a stop may still be added to: not started. */
const NOT_STARTED = ["planned", "ready"] as const

/** Where and what a container's stop collects on a day. */
export type PlacementStop = { propertyId: string | null; sharedCollectionPointId: string | null; wasteFractionId: string }

/**
 * The place and the fraction of a container's stop on a service date: the
 * placement in force that day — the placement, its subscription and its
 * agreement each valid that day, generation's own eligibility — the place the
 * subscription names and the fraction the placement holds; undefined for a
 * container placed nowhere that day. Add stop reads it too.
 */
export async function placementStopOn(tx: Tx, scope: { companyId: string; projectId: string }, containerId: string, serviceDate: string): Promise<PlacementStop | undefined> {
  const [place] = await tx
    .select({ propertyId: subscription.propertyId, sharedCollectionPointId: subscription.sharedCollectionPointId, wasteFractionId: containerServicePlacement.wasteFractionId })
    .from(containerServicePlacement)
    .innerJoin(
      subscription,
      and(eq(subscription.companyId, containerServicePlacement.companyId), eq(subscription.projectId, containerServicePlacement.projectId), eq(subscription.id, containerServicePlacement.subscriptionId), validOn(subscription, serviceDate)),
    )
    .innerJoin(agreement, and(eq(agreement.companyId, subscription.companyId), eq(agreement.projectId, subscription.projectId), eq(agreement.id, subscription.agreementId), validOn(agreement, serviceDate)))
    .where(and(eq(containerServicePlacement.companyId, scope.companyId), eq(containerServicePlacement.projectId, scope.projectId), eq(containerServicePlacement.containerId, containerId), validOn(containerServicePlacement, serviceDate)))
    .limit(1)
  return place
}

const routeColumns = {
  id: route.id,
  number: route.number,
  operatingDate: route.operatingDate,
  routeSchemeId: route.routeSchemeId,
  collectionGroupId: route.collectionGroupId,
}
const emptyingRouteOf = (row: { id: string; number: number; operatingDate: string; routeSchemeId: string | null; collectionGroupId: string | null }): EmptyingRoute => ({
  id: row.id,
  label: routeLabel(row.number),
  operatingDate: row.operatingDate,
  routeSchemeId: row.routeSchemeId,
  collectionGroupId: row.collectionGroupId,
})

/** What the stop says to the driver: why it is there. */
export const fillEmptyingNote = (sensorIdentifier: string, fillPercent: number, measuredAt: string): string =>
  `Emptying brought forward: sensor ${sensorIdentifier} read ${fillPercent}% at ${measuredAt}.`

/** Thrown inside the savepoint to take the stop back, carrying why. */
class Refusal extends Error {}

/**
 * Books the fill-driven emptying of a container in the caller's transaction,
 * under `withCompany`, and answers what it came to. `today` is the project's
 * day; `note` the stop's words.
 */
export async function bookFillEmptying(tx: Tx, scope: { companyId: string; projectId: string }, containerId: string, today: string, note: string): Promise<FillEmptyingOutcome> {
  const { companyId, projectId } = scope
  // The container's next emptying of generation's, still planned on a route that has not started.
  const [next] = await tx
    .select(routeColumns)
    .from(pickup)
    .innerJoin(route, and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)))
    .where(
      and(
        eq(pickup.companyId, companyId),
        eq(pickup.projectId, projectId),
        eq(pickup.containerId, containerId),
        eq(pickup.origin, "generation"),
        eq(pickup.service, "empty"),
        eq(pickup.status, "planned"),
        inArray(route.status, [...NOT_STARTED]),
        gte(route.operatingDate, today),
      ),
    )
    .orderBy(asc(route.operatingDate), asc(route.id))
    .limit(1)
  const nextRoute = next === undefined ? null : emptyingRouteOf(next)
  const candidates =
    nextRoute === null || nextRoute.routeSchemeId === null || nextRoute.collectionGroupId === null
      ? []
      : await tx
          .select(routeColumns)
          .from(route)
          .where(
            and(
              eq(route.companyId, companyId),
              eq(route.projectId, projectId),
              eq(route.routeSchemeId, nextRoute.routeSchemeId),
              eq(route.collectionGroupId, nextRoute.collectionGroupId),
              inArray(route.status, [...NOT_STARTED]),
              gte(route.operatingDate, today),
              lt(route.operatingDate, nextRoute.operatingDate),
            ),
          )
  const choice = fillEmptyingRoute(nextRoute, candidates.map(emptyingRouteOf), today)
  if (choice.kind !== "book") return choice
  const chosen = choice.route

  await lockRow(tx, route, { companyId, id: chosen.id })
  const [locked] = await tx
    .select({ status: route.status, serviceDate: route.serviceDate, plannedVehicleId: route.plannedVehicleId })
    .from(route)
    .where(and(eq(route.companyId, companyId), eq(route.id, chosen.id)))
    .limit(1)
  if (locked === undefined || !(NOT_STARTED as readonly string[]).includes(locked.status)) return { kind: "refused", route: chosen, reason: "the route has started" }
  const place = await placementStopOn(tx, scope, containerId, locked.serviceDate)
  if (place === undefined) return { kind: "refused", route: chosen, reason: "the container has no placement in force on the route's service date" }
  // The same work booked once: an emptying the office has planned for the container on the route already is this one, from an earlier filling or a person.
  const [booked] = await tx
    .select({ id: pickup.id })
    .from(pickup)
    .where(and(eq(pickup.companyId, companyId), eq(pickup.routeId, chosen.id), eq(pickup.containerId, containerId), eq(pickup.origin, "office"), eq(pickup.service, "empty"), eq(pickup.status, "planned")))
    .limit(1)
  if (booked !== undefined) return { kind: "booked", route: chosen }

  try {
    await tx.transaction(async (savepoint) => {
      const [last] = await savepoint
        .select({ position: max(pickup.position) })
        .from(pickup)
        .where(and(eq(pickup.companyId, companyId), eq(pickup.routeId, chosen.id)))
      const [row] = await savepoint
        .insert(pickup)
        .values({ companyId, projectId, routeId: chosen.id, position: (last?.position ?? 0) + 1, origin: "office", service: "empty", status: "planned", containerId, ...place, note })
        .returning({ id: pickup.id })
      if (locked.plannedVehicleId !== null) {
        const misfit = await misfitOf(savepoint, companyId, locked.plannedVehicleId, await pickupFitStops(savepoint, companyId, [row!.id]))
        if (misfit !== undefined) throw new Refusal(misfit)
      }
      await savepoint
        .update(route)
        .set({ updatedAt: sql`now()` })
        .where(and(eq(route.companyId, companyId), eq(route.id, chosen.id)))
    })
  } catch (error) {
    if (error instanceof Refusal) return { kind: "refused", route: chosen, reason: error.message }
    throw error
  }
  return { kind: "booked", route: chosen }
}
