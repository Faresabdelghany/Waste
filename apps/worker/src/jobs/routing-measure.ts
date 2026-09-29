// Measurement as a job (#169, decided on #124 and #132): `routing.measure`
// takes a `baseline` or `manual` Plan whose stops were written at creation
// (#124 §1: the sequence is written exactly once, on creation for a known
// sequence), asks the provider for the legs of its trip, and writes what came
// back — the legs, the totals, the provenance — flipping `calculating →
// ready`. The queue is `exclusive` with the Plan's fingerprint as
// `singletonKey`, so two requests for one result collapse (#132 §3); ten
// minutes to run, kept a week, pg-boss's retries 3 at 30 s → 5 min (#132 §4;
// the quota engine that defers instead arrives with #171).
//
// No database transaction is ever held open across the provider call (#124
// §4): one fenced transaction reads the Plan, its stops and their
// coordinates; the call runs outside; a second fenced transaction re-reads
// the Plan under its row lock and writes, so a replay — the same job sent
// twice, a retry after a crash between the call and the write — finds the
// Plan already `ready` and writes nothing. A stop or an end of the trip
// without a location is a semantic refusal, final the way #132 §4 has it:
// the Plan `failed` with the sentence, the job completes, nothing retries
// what data cannot answer.
import type { Point, Position2D } from "@waste/contracts/geojson"
import type { Tx } from "@waste/db/client"
import { ROUTING_MEASURE_QUEUE, ROUTING_OPTIMISE_QUEUE, type RoutingJobData } from "@waste/db/commands/plans"
import { property, sharedCollectionPoint } from "@waste/db/schema/customers"
import { pickup, route } from "@waste/db/schema/execution"
import { depot, unloadingStation } from "@waste/db/schema/places"
import { plan, planLeg, planStop } from "@waste/db/schema/routing"
import { withCompany } from "@waste/db/tenant"
import { DEFAULT_PROFILE } from "@waste/routing/provider"
import { asc, eq } from "drizzle-orm"

import { defineJob, type JobContext, type JobQueueOptions } from "./definition"

export { ROUTING_MEASURE_QUEUE }
export type RoutingMeasureData = RoutingJobData

/** What the first transaction reads: the trip's points in driving order, or the sentence that ends the Plan. */
type Gathered = { kind: "points"; points: Position2D[] } | { kind: "refused"; sentence: string } | { kind: "done"; status: string }

const positionOf = (location: Point | null): Position2D | null => (location ? [location.coordinates[0], location.coordinates[1]] : null)

/** Consecutive identical coordinates span no leg — two bins at one address are one point of the trip — and PostGIS refuses a zero-length LINESTRING, so they collapse here. */
const distinctConsecutive = (points: readonly Position2D[]): Position2D[] =>
  points.filter((point, index) => index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1])

async function gather(tx: Tx, planId: string): Promise<Gathered> {
  const [found] = await tx.select({ status: plan.status, solver: plan.solver, trip: plan.trip, routeId: plan.routeId }).from(plan).where(eq(plan.id, planId))
  // Deleted between send and work (a tenant sweep, a reset): permanently unanswerable, so nothing retries it.
  if (!found) return { kind: "done", status: "not there; a sweep between send and work retries nothing" }
  if (found.status !== "calculating") return { kind: "done", status: found.status }
  // An optimiser Plan has no creation-time sequence: its stops and legs are the solver's to write on routing.optimise (#171).
  if (found.solver === "optimiser") return { kind: "refused", sentence: "an optimiser Plan is routing.optimise's to solve, not measured here" }
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
  if (found.trip === "full") {
    const [ends] = await tx
      .select({ depot: depot.location, station: unloadingStation.location })
      .from(route)
      .leftJoin(depot, eq(route.depotId, depot.id))
      .leftJoin(unloadingStation, eq(route.unloadingStationId, unloadingStation.id))
      .where(eq(route.id, found.routeId))
    const home = positionOf(ends?.depot ?? null)
    const station = positionOf(ends?.station ?? null)
    if (!home || !station) return { kind: "refused", sentence: "a full trip needs the route's depot and unloading station, and one is missing" }
    return { kind: "points", points: distinctConsecutive([home, ...points, station, home]) }
  }
  return { kind: "points", points: distinctConsecutive(points) }
}

/** Fails the Plan under its row lock, exactly as the ready path writes: a Plan that moved meanwhile is left as it is. */
async function fail(tx: Tx, planId: string, sentence: string, log: (message: string) => void): Promise<void> {
  const [locked] = await tx.select({ status: plan.status }).from(plan).where(eq(plan.id, planId)).for("update")
  if (!locked || locked.status !== "calculating") {
    log(`routing.measure: plan ${planId} moved to ${locked?.status ?? "nowhere"} meanwhile; the refusal writes nothing`)
    return
  }
  await tx.update(plan).set({ status: "failed", failureReason: sentence, deferredUntil: null }).where(eq(plan.id, planId))
}

async function measureOne(data: RoutingMeasureData, context: JobContext): Promise<void> {
  const gathered = await withCompany(context.api.db, data.companyId, (tx: Tx) => gather(tx, data.planId))
  if (gathered.kind === "done") {
    context.log(`routing.measure: plan ${data.planId} is ${gathered.status}; this run writes nothing`)
    return
  }
  if (gathered.kind === "refused") {
    await withCompany(context.api.db, data.companyId, (tx: Tx) => fail(tx, data.planId, gathered.sentence, context.log))
    context.log(`routing.measure: plan ${data.planId} failed: ${gathered.sentence}`)
    return
  }
  // Fewer than two points span no leg: a one-stop stops-only trip is ready at zero, measured over nothing.
  const measured = gathered.points.length < 2 ? { legs: [], provenance: { engineVersion: null, graphDate: null } } : await context.routing.measure({ profile: DEFAULT_PROFILE, points: gathered.points })
  await withCompany(context.api.db, data.companyId, async (tx: Tx) => {
    const [locked] = await tx.select({ status: plan.status, projectId: plan.projectId, routeId: plan.routeId }).from(plan).where(eq(plan.id, data.planId)).for("update")
    if (!locked || locked.status !== "calculating") {
      context.log(`routing.measure: plan ${data.planId} moved to ${locked?.status ?? "nowhere"} meanwhile; this run writes nothing`)
      return
    }
    if (measured.legs.length > 0) {
      await tx.insert(planLeg).values(
        measured.legs.map((leg, index) => ({
          companyId: data.companyId,
          projectId: locked.projectId,
          routeId: locked.routeId,
          planId: data.planId,
          position: index + 1,
          path: leg.geometry,
          metres: leg.metres,
          seconds: leg.seconds,
        })),
      )
    }
    await tx
      .update(plan)
      .set({
        status: "ready",
        distanceMetres: measured.legs.reduce((sum, leg) => sum + leg.metres, 0),
        durationSeconds: measured.legs.reduce((sum, leg) => sum + leg.seconds, 0),
        deferredUntil: null,
        engineVersion: measured.provenance.engineVersion,
        graphDate: measured.provenance.graphDate,
      })
      .where(eq(plan.id, data.planId))
  })
}

/** #132 §3–4 for both routing queues: exclusive under the fingerprint singleton, ten minutes to run, done jobs kept a week, retries 3 at 30 s → 5 min. */
const ROUTING_QUEUE_OPTIONS: JobQueueOptions = {
  policy: "exclusive",
  expireInSeconds: 600,
  // A done job's week (#132 §3): deleteAfterSeconds is completed-job retention; retentionSeconds would instead bound how long a queued job may wait, which #171's deferral needs long.
  deleteAfterSeconds: 7 * 24 * 60 * 60,
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 300,
}

export const routingMeasure = defineJob<RoutingMeasureData>({
  queue: ROUTING_MEASURE_QUEUE,
  description: "Measures a baseline or manual Plan's trip through the routing provider: legs, totals and provenance onto the Plan, calculating → ready.",
  queueOptions: ROUTING_QUEUE_OPTIONS,
  // The API sends optimiser Plans to `routing.optimise` (#170) and its worker arrives with #171 (S3): the queue is
  // created here so a send never meets a missing queue, the registry's rule, and a job waits on it until S3 works it.
  // Until then a queued job may wait weeks, so the queued-state bound is stretched past pg-boss's fourteen-day default;
  // #171 drops the override when the queue gains its worker.
  publishes: [{ queue: ROUTING_OPTIMISE_QUEUE, queueOptions: { ...ROUTING_QUEUE_OPTIONS, retentionSeconds: 60 * 24 * 60 * 60 } }],
  handler: async (jobs, context) => {
    for (const job of jobs) await measureOne(job.data, context)
  },
})
