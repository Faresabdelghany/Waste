// What the routing reads and the two Plan-creating commands share (#170,
// decided on #124 and #132): the `plan` row on the wire, its legs, the
// `ActivePlan` reading a route's detail carries with the `sequence` each of
// its pickups gains — both computed on read, never stored — and `ensurePlan`,
// the one door `POST /routes/:id/optimise` and the reorder go through: the
// fingerprint over the request's inputs, the cache that re-activates a
// `ready` match instead of asking the provider again (#124 §4), the Plan
// written `calculating` with a known sequence's stops, activation on creation
// for `manual` and `baseline` (#124 §2), and the job sent in the request's
// transaction under the fingerprint singleton (#132 §3).
import type { Point } from "@waste/contracts/geojson"
import type { ActivePlan, Plan, PlanLeg } from "@waste/contracts/plans"
import type { Tx } from "@waste/db/client"
import { activatePlan, createPlan, plansMatching, planStopIds, ROUTING_MEASURE_QUEUE, ROUTING_OPTIMISE_QUEUE, type RoutingJobData } from "@waste/db/commands/plans"
import { QueueMissing, sendInTransaction, type JobSender } from "@waste/db/jobs"
import { property, sharedCollectionPoint } from "@waste/db/schema/customers"
import { pickup } from "@waste/db/schema/execution"
import { depot, unloadingStation } from "@waste/db/schema/places"
import { plan, planLeg, planStop } from "@waste/db/schema/routing"
import type { PlanSolver, PlanStatus, PlanTrip } from "@waste/domain/routing/vocabulary"
import { planFingerprint, type FingerprintPosition } from "@waste/domain/routing/fingerprint"
import { activeOnCreation, executionOrder, planIsStale, tripOf } from "@waste/domain/routing/plans"
import type { RoutingProvider } from "@waste/routing/provider"
import { DEFAULT_PROFILE } from "@waste/routing/provider"
import { and, asc, eq, inArray, type SQL } from "drizzle-orm"

import type { Principal } from "../auth/principal"
import { inProjects } from "../auth/projects"
import { problem } from "../problem"
import { stampsOf } from "./shared"

/** What a request that needs the worker's queue and finds none is told: the deployment's order, in one sentence, as a 503 (#187's rule). */
export const ROUTING_QUEUE_MISSING = "The worker has not started on this database yet, so its routing queue is not there; start it and ask again"

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
  for (const stop of named) namedByPlan.set(stop.planId, [...(namedByPlan.get(stop.planId) ?? []), stop.pickupId])
  const stopsByRoute = new Map<string, SequencedStop[]>()
  for (const stop of stops) stopsByRoute.set(stop.routeId, [...(stopsByRoute.get(stop.routeId) ?? []), stop])
  const readings = new Map<string, ActivePlan>()
  for (const row of withPlans) {
    const planRow = planById.get(row.activePlanId as string)
    if (planRow === undefined) continue
    readings.set(row.id, activePlanOf(planRow, stopsByRoute.get(row.id) ?? [], namedByPlan.get(planRow.id) ?? []))
  }
  return readings
}

const positionOf = (location: Point | null): FingerprintPosition | null => (location === null ? null : [location.coordinates[0], location.coordinates[1]])

/** What a Plan's fingerprint reads of the route (#124 §4, corrected by #132 §6): the trip's ends and each stop's coordinates, an unlocated one keying as none. */
async function fingerprintParts(tx: Tx, companyId: string, routeRow: { id: string; depotId: string | null; unloadingStationId: string | null }, orderedPickupIds: readonly string[]) {
  const trip = tripOf({ hasDepot: routeRow.depotId !== null, hasStation: routeRow.unloadingStationId !== null })
  const located =
    orderedPickupIds.length === 0
      ? []
      : await tx
          .select({ id: pickup.id, property: property.location, point: sharedCollectionPoint.location })
          .from(pickup)
          .leftJoin(property, eq(pickup.propertyId, property.id))
          .leftJoin(sharedCollectionPoint, eq(pickup.sharedCollectionPointId, sharedCollectionPoint.id))
          .where(and(eq(pickup.companyId, companyId), inArray(pickup.id, [...orderedPickupIds])))
  // An unlocated stop keys by its pickup id (#170): the request still fingerprints, and two orders over unlocated stops stay two.
  const at = new Map(located.map((row) => [row.id, positionOf(row.property) ?? positionOf(row.point)] as const))
  let ends: { depot: FingerprintPosition | null; station: FingerprintPosition | null } = { depot: null, station: null }
  if (trip === "full") {
    const [[home], [station]] = await Promise.all([
      tx
        .select({ location: depot.location })
        .from(depot)
        .where(and(eq(depot.companyId, companyId), eq(depot.id, routeRow.depotId as string)))
        .limit(1),
      tx
        .select({ location: unloadingStation.location })
        .from(unloadingStation)
        .where(and(eq(unloadingStation.companyId, companyId), eq(unloadingStation.id, routeRow.unloadingStationId as string)))
        .limit(1),
    ])
    ends = { depot: positionOf(home?.location ?? null), station: positionOf(station?.location ?? null) }
  }
  return { trip, ...ends, stops: orderedPickupIds.map((id) => at.get(id) ?? id) }
}

export type EnsuredPlan = { planId: string; created: boolean }

/**
 * The one door a Plan is asked for through: fingerprint, cache, create,
 * activate, enqueue — all in the request's transaction, the provider never
 * called (#124 §4: the call is the job's, outside any transaction). A `ready`
 * match is re-activated and consumes no call; a `calculating` one is answered
 * as it stands (the fingerprint singleton holds its job); a `failed` one is
 * retried with a new Plan.
 */
export async function ensurePlan(
  tx: Tx,
  principal: Principal,
  routeRow: { id: string; projectId: string; depotId: string | null; unloadingStationId: string | null },
  request: { solver: PlanSolver; orderedPickupIds: readonly string[] },
  { routing, jobs }: { routing: RoutingProvider; jobs: JobSender },
): Promise<EnsuredPlan> {
  const parts = await fingerprintParts(tx, principal.companyId, routeRow, request.orderedPickupIds)
  const fingerprint = planFingerprint({
    provider: routing.name,
    profile: DEFAULT_PROFILE,
    solver: request.solver,
    depot: parts.depot,
    station: parts.station,
    stops: parts.stops,
  })
  const matches = await plansMatching(tx, { companyId: principal.companyId, routeId: routeRow.id, fingerprint })
  const ready = matches.find((match) => match.status === "ready")
  if (ready !== undefined) {
    await activatePlan(tx, { companyId: principal.companyId, routeId: routeRow.id, planId: ready.id })
    return { planId: ready.id, created: false }
  }
  const calculating = matches.find((match) => match.status === "calculating")
  if (calculating !== undefined) return { planId: calculating.id, created: false }
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
  const data: RoutingJobData = { planId, companyId: principal.companyId }
  try {
    await sendInTransaction(jobs.send, tx, request.solver === "optimiser" ? ROUTING_OPTIMISE_QUEUE : ROUTING_MEASURE_QUEUE, data, { singletonKey: fingerprint })
  } catch (error) {
    if (error instanceof QueueMissing) throw problem(503, { detail: ROUTING_QUEUE_MISSING })
    throw error
  }
  return { planId, created: true }
}
