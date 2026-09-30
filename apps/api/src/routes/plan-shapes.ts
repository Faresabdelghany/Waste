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
import { ensurePlan as ensureCompanyPlan, planStopIds, type EnsuredPlan } from "@waste/db/commands/plans"
import { QueueMissing, type JobSender } from "@waste/db/jobs"
import { pickup } from "@waste/db/schema/execution"
import { plan, planLeg, planStop } from "@waste/db/schema/routing"
import type { PlanSolver, PlanStatus, PlanTrip } from "@waste/domain/routing/vocabulary"
import { executionOrder, planIsStale } from "@waste/domain/routing/plans"
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

/**
 * The office's door to a Plan (#170): `ensurePlan` of @waste/db/commands/plans
 * asked `interactive` — a dispatcher waits on it (#132 §1) — with a queue no
 * worker has made answered as the 503 it is.
 */
export async function ensurePlan(
  tx: Tx,
  principal: Principal,
  routeRow: { id: string; projectId: string; operatingDate: string; depotId: string | null; unloadingStationId: string | null },
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
