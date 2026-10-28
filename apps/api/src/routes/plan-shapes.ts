// What the routing reads and the two Plan-creating commands share (#170,
// decided on #124 and #132): the `plan` row on the wire, its legs, the
// `ActivePlan` reading a route's detail carries with the `sequence` each of
// its pickups gains — both computed on read, never stored — and `ensurePlan`,
// the door `POST /routes/:id/optimise` and the reorder go through: the one
// every sender shares (@waste/db/commands/plans, since #172 has generation
// and the horizon sweep ask through it too) — the fingerprint over the
// request's inputs, the cache that re-activates a `ready` match instead of
// asking the provider again (#124 §4), the Plan written `calculating` with a
// known sequence's stops, activation on creation for `manual` and `baseline`
// (#124 §2), the job sent in the request's transaction under the Plan-id
// singleton (#132 §3) — asked `interactive`, since a dispatcher waits on it
// (#132 §1), at the priority that class gives it.
import type { ActivePlan, Plan, PlanLeg } from "@waste/contracts/plans"
import type { Tx } from "@waste/db/client"
import { ensurePlan as ensureCompanyPlan, type EnsuredPlan, type PlanRoute } from "@waste/db/commands/plans"
import { QueueMissing, type JobSender } from "@waste/db/jobs"
import { pickup, route } from "@waste/db/schema/execution"
import { plan, planLeg, planStop } from "@waste/db/schema/routing"
import type { PlanSolver, PlanStatus, PlanStopWarning, PlanTrip } from "@waste/domain/routing/vocabulary"
import { executionOrder, planIsStale } from "@waste/domain/routing/plans"
import { DEFAULT_PROFILE, type RoutingIdentity } from "@waste/routing/provider"
import { and, asc, eq, inArray, isNotNull, type SQL } from "drizzle-orm"

import type { Principal } from "../auth/principal"
import { inProjects } from "../auth/projects"
import { reachesThroughRoute } from "../auth/provider"
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

/** The plans of this company, in the projects the caller works in: what a command's Plan is read through. */
export const planScope = (principal: Principal): SQL | undefined => and(eq(plan.companyId, principal.companyId), inProjects(plan.projectId, principal))

/** The plans of this company the caller reads: its projects' for an office account, the Plans of the routes its provider serves for a Service Provider's (`reachesThroughRoute`, #291 slice 23). */
export const planReach = (tx: Tx, principal: Principal): SQL | undefined => and(eq(plan.companyId, principal.companyId), reachesThroughRoute(tx, principal, plan))

/** One plan of this company by id, inside the caller's projects; undefined when it is neither. */
export async function findPlan(tx: Tx, principal: Principal, id: string): Promise<PlanRow | undefined> {
  const [row] = await tx
    .select(planColumns)
    .from(plan)
    .where(and(planScope(principal), eq(plan.id, id)))
    .limit(1)
  return row
}

/** One plan of this company by id that the caller reads (`planReach`); undefined when it is not one. */
export async function findReachedPlan(tx: Tx, principal: Principal, id: string): Promise<PlanRow | undefined> {
  const [row] = await tx
    .select(planColumns)
    .from(plan)
    .where(and(planReach(tx, principal), eq(plan.id, id)))
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

/** A Plan's stops held outside their window (O14 of #290), in its order. */
type StopWarnings = ActivePlan["stopWarnings"]

/** A Plan's stop as its readings take it: a pickup, or an unload visit on the way (O15 of #290). */
export type PlanStopRow = { planId: string; kind: string; pickupId: string | null; unloadingStationId: string | null; position: number; warning: string | null }

/** Each Plan's stops in its order, by its id. */
export async function planStopsByPlan(tx: Tx, companyId: string, planIds: readonly string[]): Promise<Map<string, PlanStopRow[]>> {
  if (planIds.length === 0) return new Map()
  const rows = await tx
    .select({ planId: planStop.planId, kind: planStop.kind, pickupId: planStop.pickupId, unloadingStationId: planStop.unloadingStationId, position: planStop.position, warning: planStop.windowWarning })
    .from(planStop)
    .where(and(eq(planStop.companyId, companyId), inArray(planStop.planId, [...planIds])))
    .orderBy(asc(planStop.position))
  return Map.groupBy(rows, (row) => row.planId)
}

/** What a Plan's stops say over the route's stops today. */
type PlanStopsReading = { named: string[]; stopWarnings: StopWarnings; unloads: ActivePlan["unloads"] }

/**
 * A Plan's pickups in its order; the ones it holds outside their window, each
 * at its place among the Plan's pickups; and the unload visits it makes on
 * the way, each after the last of the route's stops the Plan visits before it.
 * A visit with none of the route's stops before it says nothing, and is left.
 */
function planStopsReading(rows: readonly PlanStopRow[], present: ReadonlySet<string>): PlanStopsReading {
  const reading: PlanStopsReading = { named: [], stopWarnings: [], unloads: [] }
  let after: string | null = null
  for (const row of rows) {
    if (row.kind === "unload") {
      if (after !== null && row.unloadingStationId !== null) reading.unloads.push({ afterPickupId: after, unloadingStationId: row.unloadingStationId })
      continue
    }
    if (row.pickupId === null) continue
    reading.named.push(row.pickupId)
    if (row.warning !== null) reading.stopWarnings.push({ pickupId: row.pickupId, position: reading.named.length, warning: row.warning as PlanStopWarning })
    if (present.has(row.pickupId)) after = row.pickupId
  }
  return reading
}

/** The `ActivePlan` reading over its row and the route's stops today: `stale` is a reading, never a status (#124 §2). */
const activePlanOf = (row: PlanRow, stops: readonly SequencedStop[], { named, stopWarnings, unloads }: PlanStopsReading): ActivePlan => ({
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
  stopWarnings,
  unloads,
})

export type PlanContext = {
  activePlan: ActivePlan | null
  /** Each stop's place in the current execution order, 1..n: the active Plan's where there is one, the baseline's otherwise. */
  sequence: Map<string, number>
}

/** By position, ties by id in Postgres's order (`pickupsOfRoute`'s `position, id`): a lowercase id compares by its bytes, as pagination.ts says, and never by the locale's collation. */
const baselineIds = (stops: readonly Pick<SequencedStop, "id" | "position">[]): string[] =>
  [...stops].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((stop) => stop.id)

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
  const rows = (await planStopsByPlan(tx, companyId, [row.id])).get(row.id) ?? []
  const reading = planStopsReading(rows, new Set(stops.map((stop) => stop.id)))
  return { activePlan: activePlanOf(row, stops, reading), sequence: sequenceOver(executionOrder(baseline, reading.named)) }
}

/**
 * Each stop's `sequence` by pickup id, for every stop of the routes named
 * (#219): the ordinal a route's detail gives it (`planContextOf`), read in
 * two statements over the routes rather than one per route — every stop of
 * each, since the ordinal counts through the whole route and not only the
 * stops a page holds, and the stops the route's active Plan names, in its
 * order, through the route's own `active_plan_id` in the same statement. A
 * route without a Plan, or whose Plan names nothing, keeps its baseline.
 * Both statements carry the reach (`reachesThroughRoute`), the office's
 * projects or the routes a provider serves, so a stop a provider reads
 * carries the sequence the office reads for it.
 */
export async function sequencesOfRoutes(tx: Tx, principal: Principal, routeIds: readonly string[]): Promise<Map<string, number>> {
  const sequences = new Map<string, number>()
  const ids = [...new Set(routeIds)]
  if (ids.length === 0) return sequences
  const [stops, named] = await Promise.all([
    tx
      .select({ id: pickup.id, routeId: pickup.routeId, position: pickup.position })
      .from(pickup)
      .where(and(eq(pickup.companyId, principal.companyId), reachesThroughRoute(tx, principal, pickup), inArray(pickup.routeId, ids))),
    tx
      .select({ routeId: planStop.routeId, pickupId: planStop.pickupId })
      .from(planStop)
      .innerJoin(route, and(eq(route.companyId, planStop.companyId), eq(route.activePlanId, planStop.planId)))
      .where(and(eq(planStop.companyId, principal.companyId), reachesThroughRoute(tx, principal, planStop), inArray(route.id, ids), isNotNull(planStop.pickupId)))
      .orderBy(asc(planStop.position)),
  ])
  const stopsByRoute = Map.groupBy(stops, (stop) => stop.routeId)
  const namedByRoute = Map.groupBy(named, (stop) => stop.routeId)
  for (const routeId of ids) {
    const order = (namedByRoute.get(routeId) ?? []).flatMap((stop) => (stop.pickupId === null ? [] : [stop.pickupId]))
    for (const [id, ordinal] of sequenceOver(executionOrder(baselineIds(stopsByRoute.get(routeId) ?? []), order))) sequences.set(id, ordinal)
  }
  return sequences
}

/** A stop's ordinal out of `sequencesOfRoutes`, which read every stop of its route: one missing is a bug, never an answer without it. */
export function sequenceIn(sequences: ReadonlyMap<string, number>, stop: { id: string; routeId: string }): number {
  const sequence = sequences.get(stop.id)
  if (sequence === undefined) throw new Error(`pickup ${stop.id} has no place in route ${stop.routeId}'s order`)
  return sequence
}

/** The `ActivePlan` of every route asked for, by route, in three statements over the page's ids: what the live list carries beside each row. */
export async function activePlansByRoute(tx: Tx, companyId: string, rows: readonly { id: string; activePlanId: string | null }[]): Promise<Map<string, ActivePlan>> {
  const withPlans = rows.filter((row) => row.activePlanId !== null)
  if (withPlans.length === 0) return new Map()
  const planIds = withPlans.map((row) => row.activePlanId as string)
  const [plans, planStops, stops] = await Promise.all([
    tx.select(planColumns).from(plan).where(and(eq(plan.companyId, companyId), inArray(plan.id, planIds))),
    planStopsByPlan(tx, companyId, planIds),
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
    const routeStops = stopsByRoute.get(row.id) ?? []
    const reading = planStopsReading(planStops.get(planRow.id) ?? [], new Set(routeStops.map((stop) => stop.id)))
    readings.set(row.id, activePlanOf(planRow, routeStops, reading))
  }
  return readings
}

/**
 * The office's door to a Plan (#170): `ensurePlan` of @waste/db/commands/plans
 * asked `interactive` — a dispatcher waits on it (#132 §1) — with a queue no
 * worker has made answered as the 503 it is.
 */
export async function ensurePlan(
  tx: Tx,
  principal: Principal,
  routeRow: PlanRoute & { projectId: string },
  request: { solver: PlanSolver; orderedPickupIds: readonly string[] },
  { routing, jobs }: { routing: RoutingIdentity; jobs: JobSender },
): Promise<EnsuredPlan> {
  try {
    return await ensureCompanyPlan(tx, principal.companyId, routeRow, { ...request, class: "interactive" }, { routing: { name: routing.name, profile: DEFAULT_PROFILE }, send: jobs.send })
  } catch (error) {
    if (error instanceof QueueMissing) throw problem(503, { detail: WORKER_QUEUE_MISSING })
    throw error
  }
}
