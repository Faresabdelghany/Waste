// Optimisation as a job (#171, decided on #124 and #132): `routing.optimise`
// takes an `optimiser` Plan — sent by `POST /routes/:id/optimise` for a route
// of fifty open stops or fewer that names a depot (#170, `optimiseSolver`) —
// orders the route's open stops through the provider's optimiser, and writes
// the answer: the stops in the solver's order (the Plan's sequence, written
// on `ready` for a solved one, #124 §1), the legs, the totals, the
// provenance, `calculating → ready`, and the Plan made the route's active one
// in the same transaction (#124 §2: atomically on `ready`; a Plan that fails
// leaves the one before it active).
//
// The optimiser orders from the depot: the vehicle leaves it and comes back,
// and a full trip visits the unloading station after every stop (#124 §3) —
// one optimisation call either way, no directions call (#132). A
// `stops-only` Plan keeps only the legs between its stops, measured and
// shown as partial. A later order wins (amending #124 §2, recorded in
// ADR-0009): making a Plan active fails the optimisations it overtakes
// where it is written — a request's activation every one waiting
// (`activatePlan`), this job's own activation the ones asked for before it
// (`activateSolved`) — so their jobs find them settled and make no call. The
// job still asks itself before its call whether a newer Plan is active, and
// an answer landing after one is kept `ready`, as history, and never
// activated — nor is one for a route that has started, whose order is frozen
// (ADR-0002). The route row is locked before the Plan, the office's order,
// so a reorder and an answer never cross.
//
// Everything else is routing.measure's rule (routing-plans.ts): the read and
// the write in two fenced transactions around a call made outside both, what
// cannot be optimised final, the quota's answers the engine's.
import type { Position2D } from "@waste/contracts/geojson"
import type { Tx } from "@waste/db/client"
import { activateSolved, classOf, ROUTING_OPTIMISE_QUEUE, type RoutingJobData } from "@waste/db/commands/plans"
import { quotaRows, type QuotaRow } from "@waste/db/commands/routing-quota"
import { property, sharedCollectionPoint } from "@waste/db/schema/customers"
import { pickup, route } from "@waste/db/schema/execution"
import { depot, unloadingStation } from "@waste/db/schema/places"
import { plan, planLeg, planStop } from "@waste/db/schema/routing"
import { withCompany } from "@waste/db/tenant"
import { orderIsOpen } from "@waste/domain/execution/transitions"
import type { RouteStatus } from "@waste/domain/execution/vocabulary"
import { isSuperseded, OPTIMISER_MAX_STOPS } from "@waste/domain/routing/plans"
import { SUPERSEDED } from "@waste/domain/routing/vocabulary"
import { DEFAULT_PROFILE, type OptimiseRequest, type RoutedLeg } from "@waste/routing/provider"
import { and, asc, eq } from "drizzle-orm"
import type { Job } from "pg-boss"

import { defineJob, type JobContext } from "./definition"
import { ROUTING_QUEUE_OPTIONS, ROUTING_WORK_OPTIONS } from "./routing-measure"
import { adoptRows, deferPlan, failPlan, learnedAt, legsWithin, positionOf, recordLearned, type Disposition } from "./routing-plans"

export { ROUTING_OPTIMISE_QUEUE }

/** What the first transaction reads: the request and the pickups its stops are, or the sentence that ends the Plan. */
type Gathered =
  | { kind: "request"; request: OptimiseRequest; routeId: string; pickupIds: string[]; trip: string; operatingDate: string; quota: QuotaRow[] }
  | { kind: "refused"; sentence: string }
  | { kind: "done"; status: string }

async function gather(tx: Tx, keys: { planId: string; companyId: string; provider: string }): Promise<Gathered> {
  const { planId } = keys
  const [found] = await tx.select({ status: plan.status, solver: plan.solver, trip: plan.trip, routeId: plan.routeId }).from(plan).where(eq(plan.id, planId))
  if (!found) return { kind: "done", status: "not there; a sweep between send and work retries nothing" }
  if (found.status !== "calculating") return { kind: "done", status: found.status }
  if (found.solver !== "optimiser") return { kind: "refused", sentence: `a ${found.solver} Plan is routing.measure's to measure, not optimised here` }
  const [ends] = await tx
    .select({ status: route.status, activePlanId: route.activePlanId, operatingDate: route.operatingDate, depot: depot.location, station: unloadingStation.location })
    .from(route)
    .leftJoin(depot, eq(route.depotId, depot.id))
    .leftJoin(unloadingStation, eq(route.unloadingStationId, unloadingStation.id))
    .where(eq(route.id, found.routeId))
  if (!ends) return { kind: "done", status: "without its route" }
  // The route has moved past this request: the later order wins, and no call is spent on the earlier one.
  if (isSuperseded({ solver: "optimiser", planId, activePlanId: ends.activePlanId })) return { kind: "refused", sentence: SUPERSEDED }
  if (!orderIsOpen(ends.status as RouteStatus)) return { kind: "refused", sentence: ends.status === "active" ? "the route has started, so its order is frozen" : `the route is ${ends.status}, so its order does not change` }
  const home = positionOf(ends.depot)
  if (!home) return { kind: "refused", sentence: "the optimiser orders the stops from the route's depot, and the route names none" }
  const station = positionOf(ends.station)
  if (found.trip === "full" && !station) return { kind: "refused", sentence: "a full trip needs the route's unloading station, and it has none" }
  // The route's open stops as they are now: the optimiser's request is a set, and the solver reads it when it runs (#170).
  const stops = await tx
    .select({ id: pickup.id, position: pickup.position, property: property.location, point: sharedCollectionPoint.location })
    .from(pickup)
    .leftJoin(property, eq(pickup.propertyId, property.id))
    .leftJoin(sharedCollectionPoint, eq(pickup.sharedCollectionPointId, sharedCollectionPoint.id))
    .where(and(eq(pickup.routeId, found.routeId), eq(pickup.status, "planned")))
    .orderBy(asc(pickup.position), asc(pickup.id))
  if (stops.length === 0) return { kind: "refused", sentence: "the route has no open pickups to order" }
  if (stops.length > OPTIMISER_MAX_STOPS) return { kind: "refused", sentence: `the route has ${stops.length} open pickups, and one optimisation takes at most ${OPTIMISER_MAX_STOPS}` }
  const points: Position2D[] = []
  for (const stop of stops) {
    const at = positionOf(stop.property) ?? positionOf(stop.point)
    if (!at) return { kind: "refused", sentence: `stop ${stop.position} has no location to route` }
    points.push(at)
  }
  const request: OptimiseRequest = { profile: DEFAULT_PROFILE, depot: home, stops: points, station: found.trip === "full" ? station : null }
  const quota = await quotaRows(tx, { companyId: keys.companyId, provider: keys.provider })
  return { kind: "request", request, routeId: found.routeId, pickupIds: stops.map((stop) => stop.id), trip: found.trip, operatingDate: ends.operatingDate, quota }
}

/** The solver's order as the Plan's stops and its legs as the Plan keeps them: a stops-only Plan the legs between its first and last stop, a full one every leg of the closed trip. Throws when the answer does not fit the trip asked for. */
function shaped(gathered: Extract<Gathered, { kind: "request" }>, order: readonly number[], trip: readonly RoutedLeg[]): { pickupIds: string[]; legs: RoutedLeg[] } {
  const { request } = gathered
  const tripPoints: Position2D[] = [request.depot, ...order.map((index) => request.stops[index]), ...(request.station ? [request.station] : []), request.depot]
  const legs = gathered.trip === "full" ? legsWithin(tripPoints, trip, 0, tripPoints.length - 1) : legsWithin(tripPoints, trip, 1, order.length)
  return { pickupIds: order.map((index) => gathered.pickupIds[index]), legs }
}

async function optimiseOne(job: Job<RoutingJobData>, context: JobContext): Promise<Disposition["status"]> {
  const { planId, companyId } = job.data
  const engine = context.routing
  const gathered = await withCompany(context.api.db, companyId, (tx: Tx) => gather(tx, { planId, companyId, provider: engine.name }))
  if (gathered.kind === "done") {
    context.log(`routing.optimise: plan ${planId} is ${gathered.status}; this run writes nothing`)
    return "completed"
  }
  if (gathered.kind === "refused") {
    await withCompany(context.api.db, companyId, (tx: Tx) => failPlan(tx, planId, gathered.sentence, context.log, ROUTING_OPTIMISE_QUEUE))
    context.log(`routing.optimise: plan ${planId} failed: ${gathered.sentence}`)
    return "completed"
  }
  adoptRows(engine, gathered.quota)
  const before = learnedAt(engine, "optimisation")
  let outcome: Awaited<ReturnType<typeof engine.optimise>>
  try {
    outcome = await engine.optimise(gathered.request, { class: classOf(job.data) })
  } finally {
    await recordLearned(context, companyId, "optimisation", before)
  }
  // The answer is shaped before anything is written: one that does not fit the trip it was asked for is final, since a retry would pay for the same answer again.
  let solved: { pickupIds: string[]; legs: RoutedLeg[] } | undefined
  if (outcome.kind === "answered") {
    try {
      solved = shaped(gathered, outcome.result.order, outcome.result.legs)
    } catch (error) {
      const sentence = `the provider's answer did not fit the trip: ${error instanceof Error ? error.message : String(error)}`
      await withCompany(context.api.db, companyId, (tx: Tx) => failPlan(tx, planId, sentence, context.log, ROUTING_OPTIMISE_QUEUE))
      context.log(`routing.optimise: plan ${planId} failed: ${sentence}`)
      return "completed"
    }
  }
  return withCompany(context.api.db, companyId, async (tx: Tx): Promise<Disposition["status"]> => {
    switch (outcome.kind) {
      case "deferred":
        await deferPlan(tx, context, job, ROUTING_OPTIMISE_QUEUE, { until: outcome.until, operatingDate: gathered.operatingDate })
        context.log(`routing.optimise: plan ${planId} waits for the ${outcome.family} quota (${outcome.cause}) until ${outcome.until.toISOString()}`)
        return "completed"
      case "refused":
        await failPlan(tx, planId, outcome.sentence, context.log, ROUTING_OPTIMISE_QUEUE)
        return "completed"
      case "key-refused":
        await failPlan(tx, planId, outcome.sentence, context.log, ROUTING_OPTIMISE_QUEUE)
        return "deadletter"
      case "answered": {
        // The route before the Plan, the office's order of locks.
        const [current] = await tx.select({ status: route.status, activePlanId: route.activePlanId }).from(route).where(eq(route.id, gathered.routeId)).for("update")
        const [locked] = await tx.select({ status: plan.status, projectId: plan.projectId, routeId: plan.routeId }).from(plan).where(eq(plan.id, planId)).for("update")
        if (!locked || locked.status !== "calculating" || !current) {
          context.log(`routing.optimise: plan ${planId} moved to ${locked?.status ?? "nowhere"} meanwhile; this run writes nothing`)
          return "completed"
        }
        const { provenance } = outcome.result
        const { pickupIds, legs } = solved as NonNullable<typeof solved>
        await tx.insert(planStop).values(pickupIds.map((pickupId, index) => ({ companyId, projectId: locked.projectId, routeId: locked.routeId, planId, pickupId, position: index + 1 })))
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
        if (!orderIsOpen(current.status as RouteStatus) || isSuperseded({ solver: "optimiser", planId, activePlanId: current.activePlanId })) {
          context.log(`routing.optimise: plan ${planId} is ready but not activated: the route ${orderIsOpen(current.status as RouteStatus) ? "has a newer order" : `is ${current.status}`}`)
          return "completed"
        }
        await activateSolved(tx, { companyId, routeId: locked.routeId, planId })
        return "completed"
      }
    }
  })
}

export const routingOptimise = defineJob<RoutingJobData>({
  queue: ROUTING_OPTIMISE_QUEUE,
  description: "Orders an optimiser Plan's stops through the routing provider's optimiser and its quota engine: the solver's sequence, legs, totals and provenance onto the Plan, activated on ready unless the route has moved past it, or deferred to the quota's reset.",
  queueOptions: ROUTING_QUEUE_OPTIONS,
  workOptions: ROUTING_WORK_OPTIONS,
  handler: async (jobs, context): Promise<Disposition[]> => {
    const settled: Disposition[] = []
    for (const job of jobs) settled.push({ id: job.id, status: await optimiseOne(job, context) })
    return settled
  },
})
