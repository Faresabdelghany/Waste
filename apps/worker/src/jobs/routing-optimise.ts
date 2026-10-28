// Optimisation as a job (#171, decided on #124 and #132): `routing.optimise`
// takes an `optimiser` Plan — sent by `POST /routes/:id/optimise` for a route
// that names a depot (#170, `optimiseSolver`) — orders the route's open stops
// through the provider's optimiser, in one request or, above fifty stops
// (forty-nine on a full trip, whose station is a location too), in parts
// (O15 of #290, `ordered` below), and writes
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
// The request rides the route's clock (O14 of #290, `routeTiming` from
// @waste/db/commands/stop-timing, which the fingerprint reads too): each
// stop's window — where its property's hours and its agreement's promise
// overlap — the route's departure, and its planned driver's break. A Plan
// never loses a stop, and one bad record never stops a route being optimised:
// a stop whose two windows never overlap is sent with none, and a stop no
// order reaches inside its window is asked for again without it, one more
// call, each such stop kept on the Plan with its warning
// (`plan_stop.window_warning`) for the office to mend the record or the
// route. The waiting the windows make is written on the ready Plan, for the
// over-shift verdict.
//
// A route whose stops outweigh its planned vehicle on a full trip (O15 of
// #290, `routeLoad`, the read the fingerprint makes too) sends each stop's
// load and the payload: the solver visits the station whenever the vehicle is
// full, and the Plan writes each such visit as an unload stop at the route's
// station between the pickups it comes after.
//
// Everything else is routing.measure's rule (routing-plans.ts): the read and
// the write in two fenced transactions around a call made outside both, what
// cannot be optimised final, the quota's answers the engine's.
import type { Position2D } from "@waste/contracts/geojson"
import type { Tx } from "@waste/db/client"
import { activateSolved, classOf, ROUTING_OPTIMISE_QUEUE, type RoutingJobData } from "@waste/db/commands/plans"
import { quotaRows, type QuotaRow } from "@waste/db/commands/routing-quota"
import { reloadOver, routeLoad } from "@waste/db/commands/route-load"
import { routeTiming } from "@waste/db/commands/stop-timing"
import { property, sharedCollectionPoint } from "@waste/db/schema/customers"
import { pickup, route } from "@waste/db/schema/execution"
import { depot, unloadingStation } from "@waste/db/schema/places"
import { plan, planLeg, planStop } from "@waste/db/schema/routing"
import { withCompany } from "@waste/db/tenant"
import { orderIsOpen } from "@waste/domain/execution/transitions"
import type { RouteStatus } from "@waste/domain/execution/vocabulary"
import { OPTIMISER_MAX_PARTS, sweepParts } from "@waste/domain/routing/parts"
import { isSuperseded, optimiserMaxStops } from "@waste/domain/routing/plans"
import { shipsReload, unloadsAlong, withUnloads } from "@waste/domain/routing/reloads"
import { SUPERSEDED, type PlanStopWarning, type PlanTrip, type RoutingJobClass } from "@waste/domain/routing/vocabulary"
import { distinctConsecutive } from "@waste/routing/geodesy"
import { DEFAULT_PROFILE, type OptimiseRequest, type OptimiseResult, type RoutedLeg } from "@waste/routing/provider"
import type { Outcome } from "@waste/routing/quota"
import { and, asc, eq } from "drizzle-orm"
import type { Job } from "pg-boss"

import { defineJob, type JobContext } from "./definition"
import { ROUTING_QUEUE_OPTIONS, ROUTING_WORK_OPTIONS } from "./routing-measure"
import { adoptRows, deferPlan, failPlan, learnedAt, legsWithin, positionOf, recordLearned, type Disposition } from "./routing-plans"

export { ROUTING_OPTIMISE_QUEUE }

/** What the first transaction reads: the request and the pickups its stops are, or the sentence that ends the Plan. */
type Gathered =
  | { kind: "request"; request: OptimiseRequest; routeId: string; pickupIds: string[]; trip: string; operatingDate: string; quota: QuotaRow[]; warnings: Map<number, PlanStopWarning>; unloadingStationId: string | null }
  | { kind: "refused"; sentence: string }
  | { kind: "done"; status: string }

async function gather(tx: Tx, keys: { planId: string; companyId: string; provider: string }): Promise<Gathered> {
  const { planId } = keys
  const [found] = await tx.select({ status: plan.status, solver: plan.solver, trip: plan.trip, routeId: plan.routeId }).from(plan).where(eq(plan.id, planId))
  if (!found) return { kind: "done", status: "not there; a sweep between send and work retries nothing" }
  if (found.status !== "calculating") return { kind: "done", status: found.status }
  if (found.solver !== "optimiser") return { kind: "refused", sentence: `a ${found.solver} Plan is routing.measure's to measure, not optimised here` }
  const [ends] = await tx
    .select({
      status: route.status,
      activePlanId: route.activePlanId,
      operatingDate: route.operatingDate,
      plannedStartTime: route.plannedStartTime,
      plannedDriverId: route.plannedDriverId,
      plannedVehicleId: route.plannedVehicleId,
      unloadingStationId: route.unloadingStationId,
      depot: depot.location,
      station: unloadingStation.location,
    })
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
  // Above one request's size the stops are ordered in parts (O15 of #290), each a request; a full trip's station is a location of each, so its parts take one stop fewer.
  const most = OPTIMISER_MAX_PARTS * optimiserMaxStops(found.trip as PlanTrip)
  if (stops.length > most) return { kind: "refused", sentence: `the route has ${stops.length} open pickups, and the optimiser takes at most ${most} in ${OPTIMISER_MAX_PARTS} requests` }
  const points: Position2D[] = []
  for (const stop of stops) {
    const at = positionOf(stop.property) ?? positionOf(stop.point)
    if (!at) return { kind: "refused", sentence: `stop ${stop.position} has no location to route` }
    points.push(at)
  }
  // Each with its seconds at the kerb (O10 of #290) and its window (O14), on the clock the fingerprint read, and its load (O15).
  const pickupIds = stops.map((stop) => stop.id)
  const [timing, load] = await Promise.all([routeTiming(tx, keys.companyId, ends, pickupIds), routeLoad(tx, keys.companyId, ends, pickupIds)])
  const reload = reloadOver(load, { trip: found.trip as PlanTrip, pickupIds })
  const warnings = new Map<number, PlanStopWarning>()
  const timeWindows = stops.map((stop, index) => {
    const window = timing.stops.get(stop.id)?.window ?? null
    if (window !== "disjoint") return window
    warnings.set(index, "windows-disjoint")
    return null
  })
  const request: OptimiseRequest = {
    profile: DEFAULT_PROFILE,
    depot: home,
    stops: points,
    serviceSeconds: stops.map((stop) => timing.stops.get(stop.id)?.serviceSeconds ?? 0),
    ...(timing.timed ? { timeWindows } : {}),
    departure: timing.departure,
    ...(timing.breaks.length > 0 ? { breaks: timing.breaks } : {}),
    station: found.trip === "full" ? station : null,
    ...(reload === null ? {} : { reload }),
  }
  const quota = await quotaRows(tx, { companyId: keys.companyId, provider: keys.provider })
  return { kind: "request", request, routeId: found.routeId, pickupIds, trip: found.trip, operatingDate: ends.operatingDate, quota, warnings, unloadingStationId: ends.unloadingStationId }
}

/**
 * The solver's order as the Plan's stops and its legs as the Plan keeps them:
 * a stops-only Plan the legs between its first and last stop, a full one
 * every leg of the closed trip, the station at each unload visit on the way
 * (O15 of #290). Throws when the answer does not fit the trip asked for.
 */
function shaped(gathered: Extract<Gathered, { kind: "request" }>, order: readonly number[], unloads: readonly number[], trip: readonly RoutedLeg[]): { pickupIds: string[]; unloads: number[]; legs: RoutedLeg[] } {
  const { request } = gathered
  const { station } = request
  if (unloads.length > 0 && (!station || gathered.unloadingStationId === null)) throw new Error("the optimiser unloaded on the way of a trip with no station")
  const driven = order.flatMap((index, place) => (station && unloads.includes(place) ? [station, request.stops[index]] : [request.stops[index]]))
  const tripPoints: Position2D[] = [request.depot, ...driven, ...(station ? [station] : []), request.depot]
  const legs = gathered.trip === "full" ? legsWithin(tripPoints, trip, 0, tripPoints.length - 1) : legsWithin(tripPoints, trip, 1, driven.length)
  return { pickupIds: order.map((index) => gathered.pickupIds[index]), unloads: [...unloads], legs }
}

type Request = Extract<Gathered, { kind: "request" }>

/**
 * The route's stops ordered: in one request where they fit one, else in
 * parts swept around the depot (O15 of #290, `sweepParts`), each part's
 * request starting at the stop the part before it ended at, at the time it
 * finished there, and only the last going home by way of the station. A
 * part's stops no order reached inside their windows are asked for again
 * without them, one call more, each such stop flagged. A reload rides the one
 * request while its stops fit one as shipments (`shipsReload`); a larger
 * route's order is cut where the vehicle fills along it and the trip measured
 * through the station, a directions request per fifty waypoints. The driver's
 * break is sent only to a route asked in one request: no part knows whether
 * the break falls in its own stretch of the day, and the over-shift verdict
 * counts the break whatever the Plan says.
 */
async function ordered(engine: JobContext["routing"], gathered: Request, jobClass: RoutingJobClass): Promise<Outcome<OptimiseResult>> {
  const { request } = gathered
  const parts = sweepParts(request.depot, request.stops, optimiserMaxStops(gathered.trip as PlanTrip))
  const ships = request.reload != null && parts.length === 1 && shipsReload(request.stops.length)
  const answer = await engine.optimiseInParts(parts.length, { class: jobClass }, async (optimise): Promise<Outcome<OptimiseResult>> => {
    const order: number[] = []
    const legs: RoutedLeg[] = []
    let waitingSeconds = 0
    let unloads: number[] | undefined
    let departure = request.departure ?? null
    let provenance: OptimiseResult["provenance"] = { engineVersion: null, graphDate: null }
    for (const [part, indices] of parts.entries()) {
      const last = part === parts.length - 1
      const pick = <T>(values: readonly T[] | undefined) => (values === undefined ? undefined : indices.map((index) => values[index]))
      const asked: OptimiseRequest = {
        profile: request.profile,
        depot: request.depot,
        ...(part > 0 ? { start: request.stops[order[order.length - 1]] } : {}),
        ...(last ? {} : { returns: false }),
        stops: indices.map((index) => request.stops[index]),
        ...(request.serviceSeconds === undefined ? {} : { serviceSeconds: pick(request.serviceSeconds) }),
        ...(request.timeWindows === undefined ? {} : { timeWindows: pick(request.timeWindows) }),
        departure,
        ...(parts.length === 1 && request.breaks !== undefined ? { breaks: request.breaks } : {}),
        station: last ? request.station : null,
        ...(ships ? { reload: request.reload } : {}),
      }
      let outcome = await optimise(asked)
      // The stops no order reached inside their windows are asked for again without them: the Plan keeps every stop, each such one flagged.
      const left = outcome.kind === "answered" ? (outcome.result.unassigned ?? []) : []
      if (left.length > 0) {
        for (const index of left) gathered.warnings.set(indices[index], "window-unreachable")
        outcome = await optimise({ ...asked, timeWindows: (asked.timeWindows ?? []).map((window, index) => (left.includes(index) ? null : window)) })
        const still = outcome.kind === "answered" ? (outcome.result.unassigned ?? []) : []
        if (still.length > 0) return { kind: "refused", sentence: `the optimiser left ${still.length} ${still.length === 1 ? "stop" : "stops"} unassigned even without their time windows` }
      }
      if (outcome.kind !== "answered") return outcome
      const { result } = outcome
      if (result.unloads !== undefined) unloads = result.unloads.map((before) => order.length + before)
      order.push(...result.order.map((index) => indices[index]))
      legs.push(...result.legs)
      waitingSeconds += result.waitingSeconds
      departure = result.finishSeconds ?? departure
      provenance = result.provenance
    }
    return { kind: "answered", result: { order, legs, waitingSeconds, finishSeconds: departure, ...(unloads === undefined ? {} : { unloads }), provenance } }
  })
  if (answer.kind !== "answered" || request.reload == null || ships || !request.station) return answer
  // Too many stops for shipments: the order cut where the vehicle fills along it, and the trip measured through the station.
  const after = unloadsAlong(
    answer.result.order.map((index) => request.reload?.amounts[index] ?? 0),
    request.reload.capacityKg,
  )
  if (after.length === 0) return answer
  const { station } = request
  const driven = answer.result.order.flatMap((index, place) => (after.includes(place) ? [station, request.stops[index]] : [request.stops[index]]))
  const measured = await engine.measure(distinctConsecutive([request.depot, ...driven, station, request.depot]), { class: jobClass })
  if (measured.kind !== "answered") return measured
  return { kind: "answered", result: { ...answer.result, unloads: after, legs: measured.result.legs, provenance: measured.result.provenance } }
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
  const before = { optimisation: learnedAt(engine, "optimisation"), directions: learnedAt(engine, "directions") }
  let outcome: Outcome<OptimiseResult>
  try {
    outcome = await ordered(engine, gathered, classOf(job.data))
  } finally {
    await recordLearned(context, companyId, "optimisation", before.optimisation)
    await recordLearned(context, companyId, "directions", before.directions)
  }
  // The answer is shaped before anything is written: one that does not fit the trip it was asked for is final, since a retry would pay for the same answer again.
  let solved: ReturnType<typeof shaped> | undefined
  if (outcome.kind === "answered") {
    try {
      solved = shaped(gathered, outcome.result.order, outcome.result.unloads ?? [], outcome.result.legs)
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
        const { pickupIds, unloads, legs } = solved as NonNullable<typeof solved>
        const warningOf = new Map([...gathered.warnings].map(([index, warning]) => [gathered.pickupIds[index], warning] as const))
        // The pickups in the solver's order, its unload visits on the way between them at the route's station (O15 of #290).
        await tx.insert(planStop).values(
          withUnloads(pickupIds, unloads).map((stop, index) => ({
            companyId,
            projectId: locked.projectId,
            routeId: locked.routeId,
            planId,
            position: index + 1,
            ...(stop.kind === "pickup" ? { pickupId: stop.pickupId, windowWarning: warningOf.get(stop.pickupId) ?? null } : { kind: "unload", unloadingStationId: gathered.unloadingStationId }),
          })),
        )
        if (legs.length > 0) {
          await tx.insert(planLeg).values(legs.map((leg, index) => ({ companyId, projectId: locked.projectId, routeId: locked.routeId, planId, position: index + 1, path: leg.geometry, metres: leg.metres, seconds: leg.seconds })))
        }
        await tx
          .update(plan)
          .set({
            status: "ready",
            distanceMetres: legs.reduce((sum, leg) => sum + leg.metres, 0),
            durationSeconds: legs.reduce((sum, leg) => sum + leg.seconds, 0),
            waitingSeconds: outcome.result.waitingSeconds,
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
