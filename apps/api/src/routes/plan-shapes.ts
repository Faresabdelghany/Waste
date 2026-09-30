// What the routing reads and the two Plan-creating commands share (#170,
// decided on #124 and #132): the `plan` row on the wire, its legs, the
// `ActivePlan` reading a route's detail carries with the `sequence` each of
// its pickups gains — both computed on read, never stored — and `ensurePlan`,
// the one door `POST /routes/:id/optimise` and the reorder go through: the
// fingerprint over the request's inputs, the cache that re-activates a
// `ready` match instead of asking the provider again (#124 §4), the Plan
// written `calculating` with a known sequence's stops, activation on creation
// for `manual` and `baseline` (#124 §2), and the job sent in the request's
// transaction under the Plan-id singleton (#132 §3), `interactive` — a
// dispatcher waits on it (#132 §1) — at the priority that class gives it.
// The optimiser orders the stops from the route's depot (#171), so an
// optimiser Plan's fingerprint keys the depot whenever the route names one,
// a stops-only trip's too; a measurement keys the ends only when it measures
// them, the full trip.
import type { Point } from "@waste/contracts/geojson"
import type { ActivePlan, Plan, PlanLeg } from "@waste/contracts/plans"
import type { Tx } from "@waste/db/client"
import { activatePlan, createPlan, plansMatching, planStopIds, routingJobHeld, ROUTING_MEASURE_QUEUE, ROUTING_OPTIMISE_QUEUE, sendRoutingJob } from "@waste/db/commands/plans"
import { QueueMissing, type JobSender } from "@waste/db/jobs"
import { property, sharedCollectionPoint } from "@waste/db/schema/customers"
import { pickup } from "@waste/db/schema/execution"
import { depot, unloadingStation } from "@waste/db/schema/places"
import { plan, planLeg, planStop } from "@waste/db/schema/routing"
import type { PlanSolver, PlanStatus, PlanTrip } from "@waste/domain/routing/vocabulary"
import { planFingerprint, type FingerprintPosition } from "@waste/domain/routing/fingerprint"
import { activeOnCreation, executionOrder, planIsStale, tripOf } from "@waste/domain/routing/plans"
import { DEFAULT_PROFILE, type RoutingIdentity } from "@waste/routing/provider"
import { and, asc, eq, inArray, type SQL } from "drizzle-orm"

import type { Principal } from "../auth/principal"
import { inProjects } from "../auth/projects"
import { problem } from "../problem"
import { WORKER_QUEUE_MISSING } from "./generation"
import { stampsOf } from "./shared"

export const noSuchPlan = (id: string) => problem(404, { detail: `No plan ${id} in the projects this account works in` })

export const planColumns = {
  id: plan.id,
  projectId: plan.projectId,
  routeId: plan.routeId,
  solver: plan.solver,
  status: plan.status,
  trip: plan.trip,
  distanceMetres: plan.distanceMetres,
  durationSeconds: plan.durationSeconds,
  deferredUntil: plan.deferredUntil,
  failureReason: plan.failureReason,
  provider: plan.provider,
  engineVersion: plan.engineVersion,
  graphDate: plan.graphDate,
  createdAt: plan.createdAt,
  updatedAt: plan.updatedAt,
}

export type PlanRow = Pick<typeof plan.$inferSelect, keyof typeof planColumns>

/** The plan on the wire. The fingerprint stays the server's key and is not answered. */
export function planOf(row: PlanRow): Plan {
  return {
    id: row.id,
    projectId: row.projectId,
    routeId: row.routeId,
    solver: row.solver as PlanSolver,
    status: row.status as PlanStatus,
    trip: row.trip as PlanTrip,
    distanceMetres: row.distanceMetres,
    durationSeconds: row.durationSeconds,
    deferredUntil: row.deferredUntil === null ? null : row.deferredUntil.toISOString(),
    failureReason: row.failureReason,
    provider: row.provider,
    engineVersion: row.engineVersion,
    graphDate: row.graphDate,
    ...stampsOf(row),
  }
}

/** The plans of this company, in the projects the caller works in. */
export const planScope = (principal: Principal): SQL | undefined => and(eq(plan.companyId, principal.companyId), inProjects(plan.projectId, principal))

/** One plan of this company by id, inside the caller's projects; undefined when it is neither. */
export async function findPlan(tx: Tx, principal: Principal, id: string): Promise<PlanRow | undefined> {
  const [row] = await tx
    .select(planColumns)
    .from(plan)
    .where(and(planScope(principal), eq(plan.id, id)))
    .limit(1)
  return row
}

/** One plan's legs in driving order, as the wire carries them. */
export async function legsOfPlan(tx: Tx, companyId: string, planId: string): Promise<PlanLeg[]> {
  const rows = await tx
    .select({ position: planLeg.position, path: planLeg.path, metres: planLeg.metres, seconds: planLeg.seconds })
    .from(planLeg)
    .where(and(eq(planLeg.companyId, companyId), eq(planLeg.planId, planId)))
    .orderBy(asc(planLeg.position))
  return rows
}

/** What the sequence and the staleness are read from: a stop's id, baseline place and state, however a caller spells the rest of it. */
export type SequencedStop = { id: string; position: number; status: string; reason: string | null }

/** The `ActivePlan` reading over its row and the route's stops today: `stale` is a reading, never a status (#124 §2). */
const activePlanOf = (row: PlanRow, stops: readonly SequencedStop[], named: readonly string[]): ActivePlan => ({
  id: row.id,
  solver: row.solver as PlanSolver,
  status: row.status as PlanStatus,
  trip: row.trip as PlanTrip,
  distanceMetres: row.distanceMetres,
  durationSeconds: row.durationSeconds,
  stale: planIsStale({
    named,
    open: stops.filter((stop) => stop.status === "planned").map((stop) => stop.id),
    removed: stops.filter((stop) => stop.status === "skipped" && stop.reason === "regeneration").map((stop) => stop.id),
  }),
  deferredUntil: row.deferredUntil === null ? null : row.deferredUntil.toISOString(),
})

export type PlanContext = {
  activePlan: ActivePlan | null
  /** Each stop's place in the current execution order, 1..n: the active Plan's where there is one, the baseline's otherwise. */
  sequence: Map<string, number>
}

const baselineIds = (stops: readonly SequencedStop[]): string[] =>
  [...stops].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).map((stop) => stop.id)

const sequenceOver = (ordered: readonly string[]): Map<string, number> => new Map(ordered.map((id, index) => [id, index + 1]))

/** The stops in execution order, each carrying its ordinal: the one spelling the office's detail and the driver's read share. */
export function sequencedPickups<Stop extends { id: string }>(stops: readonly Stop[], context: PlanContext): (Stop & { sequence: number })[] {
  return stops.map((stop) => ({ ...stop, sequence: context.sequence.get(stop.id) as number })).sort((a, b) => a.sequence - b.sequence)
}

/** The reading one route's detail needs, over stops the caller already loaded. */
export async function planContextOf(tx: Tx, companyId: string, routeRef: { activePlanId: string | null }, stops: readonly SequencedStop[]): Promise<PlanContext> {
  const baseline = baselineIds(stops)
  if (routeRef.activePlanId === null) return { activePlan: null, sequence: sequenceOver(baseline) }
  const [row] = await tx
    .select(planColumns)
    .from(plan)
    .where(and(eq(plan.companyId, companyId), eq(plan.id, routeRef.activePlanId)))
    .limit(1)
  if (row === undefined) return { activePlan: null, sequence: sequenceOver(baseline) }
  const named = await planStopIds(tx, { companyId, planId: row.id })
  return { activePlan: activePlanOf(row, stops, named), sequence: sequenceOver(executionOrder(baseline, named)) }
}

/** The `ActivePlan` of every route asked for, by route, in three statements over the page's ids: what the live list carries beside each row. */
export async function activePlansByRoute(tx: Tx, companyId: string, rows: readonly { id: string; activePlanId: string | null }[]): Promise<Map<string, ActivePlan>> {
  const withPlans = rows.filter((row) => row.activePlanId !== null)
  if (withPlans.length === 0) return new Map()
  const planIds = withPlans.map((row) => row.activePlanId as string)
  const [plans, named, stops] = await Promise.all([
    tx.select(planColumns).from(plan).where(and(eq(plan.companyId, companyId), inArray(plan.id, planIds))),
    tx
      .select({ planId: planStop.planId, pickupId: planStop.pickupId, position: planStop.position })
      .from(planStop)
      .where(and(eq(planStop.companyId, companyId), inArray(planStop.planId, planIds)))
      .orderBy(asc(planStop.position)),
    tx
      .select({ id: pickup.id, routeId: pickup.routeId, position: pickup.position, status: pickup.status, reason: pickup.reason })
      .from(pickup)
      .where(
        and(
          eq(pickup.companyId, companyId),
          inArray(
            pickup.routeId,
            withPlans.map((row) => row.id),
          ),
        ),
      ),
  ])
  const planById = new Map(plans.map((row) => [row.id, row] as const))
  const namedByPlan = new Map<string, string[]>()
  for (const stop of named) {
    const bucket = namedByPlan.get(stop.planId) ?? []
    bucket.push(stop.pickupId)
    namedByPlan.set(stop.planId, bucket)
  }
  const stopsByRoute = new Map<string, SequencedStop[]>()
  for (const stop of stops) {
    const bucket = stopsByRoute.get(stop.routeId) ?? []
    bucket.push(stop)
    stopsByRoute.set(stop.routeId, bucket)
  }
  const readings = new Map<string, ActivePlan>()
  for (const row of withPlans) {
    const planRow = planById.get(row.activePlanId as string)
    if (planRow === undefined) continue
    readings.set(row.id, activePlanOf(planRow, stopsByRoute.get(row.id) ?? [], namedByPlan.get(planRow.id) ?? []))
  }
  return readings
}

const positionOf = (location: Point | null): FingerprintPosition | null => (location === null ? null : [location.coordinates[0], location.coordinates[1]])

/** What a Plan's fingerprint reads of the route (#124 §4, corrected by #132 §6): the ends the result depends on and each stop's coordinates, an unlocated one keying as none. */
async function fingerprintParts(tx: Tx, companyId: string, routeRow: { id: string; depotId: string | null; unloadingStationId: string | null }, solver: PlanSolver, orderedPickupIds: readonly string[]) {
  const trip = tripOf({ hasDepot: routeRow.depotId !== null, hasStation: routeRow.unloadingStationId !== null })
  const located =
    orderedPickupIds.length === 0
      ? []
      : await tx
          .select({ id: pickup.id, property: property.location, point: sharedCollectionPoint.location })
          .from(pickup)
          .leftJoin(property, and(eq(property.companyId, pickup.companyId), eq(pickup.propertyId, property.id)))
          .leftJoin(sharedCollectionPoint, and(eq(sharedCollectionPoint.companyId, pickup.companyId), eq(pickup.sharedCollectionPointId, sharedCollectionPoint.id)))
          .where(and(eq(pickup.companyId, companyId), inArray(pickup.id, [...orderedPickupIds])))
  // An unlocated stop keys by its pickup id (#170): the request still fingerprints, and two orders over unlocated stops stay two.
  const at = new Map(located.map((row) => [row.id, positionOf(row.property) ?? positionOf(row.point)] as const))
  // A full trip measures both ends; the optimiser orders from the depot on any trip (#171).
  const depotId = trip === "full" || solver === "optimiser" ? routeRow.depotId : null
  const stationId = trip === "full" ? routeRow.unloadingStationId : null
  const [[home], [station]] = await Promise.all([
    depotId === null
      ? []
      : tx
          .select({ location: depot.location })
          .from(depot)
          .where(and(eq(depot.companyId, companyId), eq(depot.id, depotId)))
          .limit(1),
    stationId === null
      ? []
      : tx
          .select({ location: unloadingStation.location })
          .from(unloadingStation)
          .where(and(eq(unloadingStation.companyId, companyId), eq(unloadingStation.id, stationId)))
          .limit(1),
  ])
  const ends = { depot: positionOf(home?.location ?? null), station: positionOf(station?.location ?? null) }
  return { trip, ...ends, stops: orderedPickupIds.map((id) => at.get(id) ?? id) }
}

export type EnsuredPlan = { planId: string; created: boolean }

/**
 * The one door a Plan is asked for through: fingerprint, cache, create,
 * activate, enqueue — all in the request's transaction, the provider never
 * called (#124 §4: the call is the job's, outside any transaction). A `ready`
 * match is re-activated and consumes no call; a `calculating` one is answered
 * as it stands (its job held, or re-sent, under the Plan-id singleton); a `failed` one is
 * retried with a new Plan.
 */
export async function ensurePlan(
  tx: Tx,
  principal: Principal,
  routeRow: { id: string; projectId: string; operatingDate: string; depotId: string | null; unloadingStationId: string | null },
  request: { solver: PlanSolver; orderedPickupIds: readonly string[] },
  { routing, jobs }: { routing: RoutingIdentity; jobs: JobSender },
): Promise<EnsuredPlan> {
  const parts = await fingerprintParts(tx, principal.companyId, routeRow, request.solver, request.orderedPickupIds)
  const fingerprint = planFingerprint({
    provider: routing.name,
    profile: DEFAULT_PROFILE,
    solver: request.solver,
    depot: parts.depot,
    station: parts.station,
    stops: parts.stops,
  })
  // A match is reusable only when its stops are the request's very pickups: the
  // fingerprint keys coordinates, and regeneration re-mints ids at the same
  // places — replaying such a Plan would answer the baseline while claiming the
  // order. An optimiser Plan still calculating has no stops to compare and its
  // solver reads the route's stops when it runs, so it is reused as it stands.
  const sameStops = async (matchId: string): Promise<boolean> => {
    const named = await planStopIds(tx, { companyId: principal.companyId, planId: matchId })
    return named.length === request.orderedPickupIds.length && new Set(named).size === new Set([...named, ...request.orderedPickupIds]).size
  }
  const queue = request.solver === "optimiser" ? ROUTING_OPTIMISE_QUEUE : ROUTING_MEASURE_QUEUE
  const send = async (planId: string) => {
    // The Plan's id keys the singleton: one live job per Plan, and Plans of one (route, fingerprint) are already
    // deduplicated above — a queue-wide fingerprint key would let another route's identical trip swallow this send.
    try {
      await sendRoutingJob(jobs.send, tx, queue, { planId, companyId: principal.companyId, class: "interactive" }, routeRow)
    } catch (error) {
      if (error instanceof QueueMissing) throw problem(503, { detail: WORKER_QUEUE_MISSING })
      throw error
    }
  }
  const matches = await plansMatching(tx, { companyId: principal.companyId, routeId: routeRow.id, fingerprint })
  const ready = matches.find((match) => match.status === "ready")
  if (ready !== undefined && (await sameStops(ready.id))) {
    await activatePlan(tx, { companyId: principal.companyId, routeId: routeRow.id, planId: ready.id })
    return { planId: ready.id, created: false }
  }
  const calculating = matches.find((match) => match.status === "calculating")
  if (calculating !== undefined && (request.solver === "optimiser" || (await sameStops(calculating.id)))) {
    // The order is applied, not merely acknowledged: a manual or baseline match becomes the active Plan again.
    if (activeOnCreation(request.solver)) await activatePlan(tx, { companyId: principal.companyId, routeId: routeRow.id, planId: calculating.id })
    // And its job may be gone (retries exhausted, the row archived): re-send under the same key, #187's hardening.
    if (!(await routingJobHeld(tx, queue, calculating.id))) await send(calculating.id)
    return { planId: calculating.id, created: false }
  }
  const planId = await createPlan(tx, {
    companyId: principal.companyId,
    projectId: routeRow.projectId,
    routeId: routeRow.id,
    solver: request.solver,
    trip: parts.trip,
    provider: routing.name,
    fingerprint,
    stops: request.solver === "optimiser" ? [] : request.orderedPickupIds,
  })
  if (activeOnCreation(request.solver)) await activatePlan(tx, { companyId: principal.companyId, routeId: routeRow.id, planId })
  await send(planId)
  return { planId, created: true }
}
