// Measurement as a job (#169, decided on #124 and #132; the quota engine of
// #171): `routing.measure` takes a `baseline` or `manual` Plan whose stops
// were written at creation (#124 §1: the sequence is written exactly once, on
// creation for a known sequence), its unload visits on the way among them at
// the station each names (O15 of #290), asks the provider through the quota
// engine for the legs of its trip — in chunks above fifty waypoints, consecutive
// chunks sharing a point — and writes what came back: the legs, the totals,
// the provenance, `calculating → ready`. The queue is `exclusive` with the
// Plan's id as `singletonKey`, so one Plan never holds two live jobs — two
// requests for one result collapse earlier, at the senders' fingerprint cache
// (#132 §3); ten minutes to run, kept a week, pg-boss's retries 3 at 30 s →
// 5 min for what is transient (a second 429 running, the network).
//
// No database transaction is ever held open across the provider call (#124
// §4): one fenced transaction reads the Plan, its route, its stops and their
// coordinates and the company's quota rows; the call runs outside; a second
// fenced transaction re-reads the Plan under its row lock and writes, so a
// replay finds the Plan already `ready` and writes nothing. What cannot be
// measured is final, the way #132 §4 has it — a stop or an end of the trip
// without a location, the provider's own refusal, a Plan that is no longer
// the route's active one (`superseded`, no call: a measurement nobody will
// read) — the Plan `failed` with the sentence and the job complete. The
// quota's answers are the engine's (plan-job.ts): a batch job at the
// reserve or a family exhausted defers the Plan to the reset, and the key
// refused fails it and the job at once.
import type { Position2D } from "@waste/contracts/geojson"
import type { Tx } from "@waste/db/client"
import { ROUTING_MEASURE_QUEUE } from "@waste/db/commands/plans"
import { quotaRows } from "@waste/db/commands/routing-quota"
import { property, sharedCollectionPoint } from "@waste/db/schema/customers"
import { pickup, route } from "@waste/db/schema/execution"
import { depot, unloadingStation } from "@waste/db/schema/places"
import { plan, planLeg, planStop } from "@waste/db/schema/routing"
import { isSuperseded } from "@waste/domain/routing/plans"
import { SUPERSEDED } from "@waste/domain/routing/vocabulary"
import { distinctConsecutive } from "@waste/domain/geo"
import { asc, eq } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"

import { definePlanJob, positionOf, type Gathered } from "./plan-job"

/** The first transaction: the trip's points in driving order, or the sentence that ends the Plan. */
async function gather(tx: Tx, keys: { planId: string; companyId: string; provider: string }): Promise<Gathered<Position2D[]>> {
  const { planId } = keys
  const [found] = await tx.select({ status: plan.status, solver: plan.solver, trip: plan.trip, routeId: plan.routeId }).from(plan).where(eq(plan.id, planId))
  // Deleted between send and work (a tenant sweep, a reset): permanently unanswerable, so nothing retries it.
  if (!found) return { kind: "done", status: "not there; a sweep between send and work retries nothing" }
  if (found.status !== "calculating") return { kind: "done", status: found.status }
  // An optimiser Plan has no creation-time sequence: its stops and legs are the solver's to write on routing.optimise.
  if (found.solver === "optimiser") return { kind: "refused", sentence: "an optimiser Plan is routing.optimise's to solve, not measured here" }
  const [ends] = await tx
    .select({ activePlanId: route.activePlanId, operatingDate: route.operatingDate, depot: depot.location, station: unloadingStation.location })
    .from(route)
    .leftJoin(depot, eq(route.depotId, depot.id))
    .leftJoin(unloadingStation, eq(route.unloadingStationId, unloadingStation.id))
    .where(eq(route.id, found.routeId))
  // The route is the Plan's parent by key; one that is gone went with a tenant sweep.
  if (!ends) return { kind: "done", status: "without its route" }
  // A measurement of an order nobody reads any more makes no call (#132 §4).
  if (isSuperseded({ solver: found.solver, planId, activePlanId: ends.activePlanId })) return { kind: "refused", sentence: SUPERSEDED }
  // The Plan's stops in its order: its pickups at their places and its unload visits on the way at their station (O15 of #290).
  const visitStation = alias(unloadingStation, "visit_station")
  const stops = await tx
    .select({ position: planStop.position, kind: planStop.kind, property: property.location, point: sharedCollectionPoint.location, station: visitStation.location })
    .from(planStop)
    .leftJoin(pickup, eq(planStop.pickupId, pickup.id))
    .leftJoin(property, eq(pickup.propertyId, property.id))
    .leftJoin(sharedCollectionPoint, eq(pickup.sharedCollectionPointId, sharedCollectionPoint.id))
    .leftJoin(visitStation, eq(planStop.unloadingStationId, visitStation.id))
    .where(eq(planStop.planId, planId))
    .orderBy(asc(planStop.position))
  const points: Position2D[] = []
  for (const stop of stops) {
    const at = stop.kind === "unload" ? positionOf(stop.station) : (positionOf(stop.property) ?? positionOf(stop.point))
    if (!at) return { kind: "refused", sentence: `stop ${stop.position} has no location to route` }
    points.push(at)
  }
  const quota = await quotaRows(tx, { companyId: keys.companyId, provider: keys.provider })
  const { operatingDate } = ends
  if (found.trip === "full") {
    const home = positionOf(ends.depot)
    const station = positionOf(ends.station)
    if (!home || !station) return { kind: "refused", sentence: "a full trip needs the route's depot and unloading station, and one is missing" }
    return { kind: "asks", ask: distinctConsecutive([home, ...points, station, home]), operatingDate, quota }
  }
  return { kind: "asks", ask: distinctConsecutive(points), operatingDate, quota }
}

export const routingMeasure = definePlanJob({
  queue: ROUTING_MEASURE_QUEUE,
  description: "Measures a baseline or manual Plan's trip through the routing provider and its quota engine: legs, totals and provenance onto the Plan, calculating → ready, or deferred to the quota's reset.",
  families: ["directions"],
  gather,
  call: (engine, points, jobClass) => engine.measure(points, { class: jobClass }),
  shape: (_points, answer) => answer,
  write: async (tx, { planId, companyId, answer, lockPlan }) => {
    const locked = await lockPlan()
    if (locked === undefined) return
    const { legs, provenance } = answer
    if (legs.length > 0) {
      await tx.insert(planLeg).values(legs.map((leg, index) => ({ companyId, projectId: locked.projectId, routeId: locked.routeId, planId, position: index + 1, path: leg.geometry, metres: leg.metres, seconds: leg.seconds })))
    }
    await tx
      .update(plan)
      .set({
        status: "ready",
        distanceMetres: legs.reduce((sum, leg) => sum + leg.metres, 0),
        durationSeconds: legs.reduce((sum, leg) => sum + leg.seconds, 0),
        deferredUntil: null,
        engineVersion: provenance.engineVersion,
        graphDate: provenance.graphDate,
      })
      .where(eq(plan.id, planId))
  },
})
