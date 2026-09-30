// Measurement as a job (#169, decided on #124 and #132; the quota engine of
// #171): `routing.measure` takes a `baseline` or `manual` Plan whose stops
// were written at creation (#124 §1: the sequence is written exactly once, on
// creation for a known sequence), asks the provider through the quota engine
// for the legs of its trip — in chunks above fifty waypoints, consecutive
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
// quota's answers are the engine's (routing-plans.ts): a batch job at the
// reserve or a family exhausted defers the Plan to the reset, and the key
// refused fails it and the job at once.
import type { Position2D } from "@waste/contracts/geojson"
import type { Tx } from "@waste/db/client"
import { classOf, ROUTING_MEASURE_QUEUE, type RoutingJobData } from "@waste/db/commands/plans"
import { quotaRows, type QuotaRow } from "@waste/db/commands/routing-quota"
import { property, sharedCollectionPoint } from "@waste/db/schema/customers"
import { pickup, route } from "@waste/db/schema/execution"
import { depot, unloadingStation } from "@waste/db/schema/places"
import { plan, planLeg, planStop } from "@waste/db/schema/routing"
import { withCompany } from "@waste/db/tenant"
import { isSuperseded } from "@waste/domain/routing/plans"
import { SUPERSEDED, type PlanSolver } from "@waste/domain/routing/vocabulary"
import { distinctConsecutive } from "@waste/routing/geodesy"
import { asc, eq } from "drizzle-orm"
import type { Job } from "pg-boss"

import { defineJob, type JobContext, type JobQueueOptions } from "./definition"
import { adoptRows, deferPlan, failPlan, learnedAt, positionOf, recordLearned, type Disposition } from "./routing-plans"

export { ROUTING_MEASURE_QUEUE }
export type RoutingMeasureData = RoutingJobData

/** What the first transaction reads: the trip's points in driving order, or the sentence that ends the Plan. */
type Gathered =
  | { kind: "points"; points: Position2D[]; operatingDate: string; quota: QuotaRow[] }
  | { kind: "refused"; sentence: string }
  | { kind: "done"; status: string }

async function gather(tx: Tx, keys: { planId: string; companyId: string; provider: string }): Promise<Gathered> {
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
  if (isSuperseded({ solver: found.solver as PlanSolver, planId, activePlanId: ends.activePlanId })) return { kind: "refused", sentence: SUPERSEDED }
  const stops = await tx
    .select({ position: planStop.position, property: property.location, point: sharedCollectionPoint.location })
    .from(planStop)
    .innerJoin(pickup, eq(planStop.pickupId, pickup.id))
    .leftJoin(property, eq(pickup.propertyId, property.id))
    .leftJoin(sharedCollectionPoint, eq(pickup.sharedCollectionPointId, sharedCollectionPoint.id))
    .where(eq(planStop.planId, planId))
    .orderBy(asc(planStop.position))
  const points: Position2D[] = []
  for (const stop of stops) {
    const at = positionOf(stop.property) ?? positionOf(stop.point)
    if (!at) return { kind: "refused", sentence: `stop ${stop.position} has no location to route` }
    points.push(at)
  }
  const quota = await quotaRows(tx, { companyId: keys.companyId, provider: keys.provider })
  const { operatingDate } = ends
  if (found.trip === "full") {
    const home = positionOf(ends.depot)
    const station = positionOf(ends.station)
    if (!home || !station) return { kind: "refused", sentence: "a full trip needs the route's depot and unloading station, and one is missing" }
    return { kind: "points", points: distinctConsecutive([home, ...points, station, home]), operatingDate, quota }
  }
  return { kind: "points", points: distinctConsecutive(points), operatingDate, quota }
}

async function measureOne(job: Job<RoutingMeasureData>, context: JobContext): Promise<Disposition["status"]> {
  const { planId, companyId } = job.data
  const engine = context.routing
  const gathered = await withCompany(context.api.db, companyId, (tx: Tx) => gather(tx, { planId, companyId, provider: engine.name }))
  if (gathered.kind === "done") {
    context.log(`routing.measure: plan ${planId} is ${gathered.status}; this run writes nothing`)
    return "completed"
  }
  if (gathered.kind === "refused") {
    await withCompany(context.api.db, companyId, (tx: Tx) => failPlan(tx, planId, gathered.sentence, context.log, ROUTING_MEASURE_QUEUE))
    context.log(`routing.measure: plan ${planId} failed: ${gathered.sentence}`)
    return "completed"
  }
  adoptRows(engine, gathered.quota)
  const before = learnedAt(engine, "directions")
  // A transient failure — a second 429 running, the network — is thrown, and pg-boss retries the job; what the calls taught is stored either way.
  let outcome: Awaited<ReturnType<typeof engine.measure>>
  try {
    outcome = await engine.measure(gathered.points, { class: classOf(job.data) })
  } finally {
    await recordLearned(context, companyId, "directions", before)
  }
  return withCompany(context.api.db, companyId, async (tx: Tx): Promise<Disposition["status"]> => {
    switch (outcome.kind) {
      case "deferred":
        await deferPlan(tx, context, job, ROUTING_MEASURE_QUEUE, { until: outcome.until, operatingDate: gathered.operatingDate })
        context.log(`routing.measure: plan ${planId} waits for the ${outcome.family} quota (${outcome.cause}) until ${outcome.until.toISOString()}`)
        return "completed"
      case "refused":
        await failPlan(tx, planId, outcome.sentence, context.log, ROUTING_MEASURE_QUEUE)
        return "completed"
      case "key-refused":
        await failPlan(tx, planId, outcome.sentence, context.log, ROUTING_MEASURE_QUEUE)
        return "deadletter"
      case "answered": {
        const [locked] = await tx.select({ status: plan.status, projectId: plan.projectId, routeId: plan.routeId }).from(plan).where(eq(plan.id, planId)).for("update")
        if (!locked || locked.status !== "calculating") {
          context.log(`routing.measure: plan ${planId} moved to ${locked?.status ?? "nowhere"} meanwhile; this run writes nothing`)
          return "completed"
        }
        const { legs, provenance } = outcome.result
        if (legs.length > 0) {
          await tx.insert(planLeg).values(
            legs.map((leg, index) => ({ companyId, projectId: locked.projectId, routeId: locked.routeId, planId, position: index + 1, path: leg.geometry, metres: leg.metres, seconds: leg.seconds })),
          )
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
        return "completed"
      }
    }
  })
}

/**
 * #132 §3–4 for both routing queues: exclusive under the Plan-id singleton,
 * ten minutes to run, done jobs kept a week, retries 3 at 30 s → 5 min, and
 * a queued job kept at most pg-boss's fortnight — a deferral waits a day at
 * most — named so a database where the optimiser's queue was stretched to
 * sixty days, before #171 gave it a worker, is brought back to it.
 */
export const ROUTING_QUEUE_OPTIONS: JobQueueOptions = {
  policy: "exclusive",
  expireInSeconds: 600,
  deleteAfterSeconds: 7 * 24 * 60 * 60,
  retentionSeconds: 14 * 24 * 60 * 60,
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 300,
}

/** Settled per job (routing-plans.ts): a key refusal fails its job without a retry. */
export const ROUTING_WORK_OPTIONS = { perJobResults: true } as const

export const routingMeasure = defineJob<RoutingMeasureData>({
  queue: ROUTING_MEASURE_QUEUE,
  description: "Measures a baseline or manual Plan's trip through the routing provider and its quota engine: legs, totals and provenance onto the Plan, calculating → ready, or deferred to the quota's reset.",
  queueOptions: ROUTING_QUEUE_OPTIONS,
  workOptions: ROUTING_WORK_OPTIONS,
  handler: async (jobs, context): Promise<Disposition[]> => {
    const settled: Disposition[] = []
    for (const job of jobs) settled.push({ id: job.id, status: await measureOne(job, context) })
    return settled
  },
})

