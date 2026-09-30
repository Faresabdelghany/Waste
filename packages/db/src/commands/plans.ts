// What the two processes share of routing's jobs (#170, decided on #124 and
// #132): the two queue names, what a routing job carries, and the Plan writes
// every sender makes. A Plan is asked for from the office twice over —
// `POST /routes/:id/optimise` and the reorder that becomes a `manual` Plan
// (apps/api) — and, from #172 on, by generation and the horizon sweep
// (apps/worker); each sender asks through `ensurePlan`, which writes the
// `plan` row (a known sequence's stops with it, #124 §1) and sends the job in
// the sender's transaction, so the names, the payload, the fingerprint and
// the writes are spelled here, once, rather than in two apps that cannot
// import each other — the office's Plans and the horizon's meet in one cache.
//
// Both queues are `exclusive` and every send carries the Plan's id as
// `singletonKey` (the worker's registry creates the queues so): one Plan never
// holds two live jobs, and a lost one is re-sent after `routingJobHeld` says
// so. Two requests for one result collapse earlier, at the cache, whose key is
// the fingerprint (#132 §3): `plansMatching` answers the route's Plans of one
// fingerprint, newest first, and the caller re-activates a `ready` match
// instead of asking the provider again (#124 §4), enqueues nothing beside a
// `calculating` one, and retries a `failed` one with a new Plan. Every job
// carries its `class` (#132 §1), set by its sender — the office's requests
// `interactive`, the horizon's `batch` — and its priority follows from the
// class and the route's operating date (`routingSendOptions`), the first send
// and a deferral's re-send alike, so a deferred job keeps its place.
import type { Point } from "@waste/contracts/geojson"
import { planFingerprint, type FingerprintPosition } from "@waste/domain/routing/fingerprint"
import { routingJobPriority } from "@waste/domain/routing/jobs"
import { activeOnCreation, tripOf } from "@waste/domain/routing/plans"
import { SUPERSEDED, type PlanSolver, type PlanTrip, type RoutingJobClass } from "@waste/domain/routing/vocabulary"
import { asc, eq, and, desc, inArray, lt, ne, sql } from "drizzle-orm"

import type { Tx } from "../client"
import { jobHeld, sendInTransaction, type Send, type SendInTransactionOptions } from "../jobs"
import { property, sharedCollectionPoint } from "../schema/customers"
import { pickup, route } from "../schema/execution"
import { depot, unloadingStation } from "../schema/places"
import { plan, planStop } from "../schema/routing"

/** The queue a `baseline` or `manual` Plan's measurement is sent to and worked on. */
export const ROUTING_MEASURE_QUEUE = "routing.measure"

/** The queue an `optimiser` Plan is sent to; its worker arrives with #171 (S3), and a job waits until it does. */
export const ROUTING_OPTIMISE_QUEUE = "routing.optimise"

/** The queue a Plan of this solver is worked on: the optimiser's own, or the measurement's for a known sequence. */
export const routingQueueOf = (solver: PlanSolver): string => (solver === "optimiser" ? ROUTING_OPTIMISE_QUEUE : ROUTING_MEASURE_QUEUE)

/** What a routing job carries, on either queue. */
export type RoutingJobData = {
  /** The `calculating` Plan the sender wrote. */
  planId: string
  /** The Plan's company, so the handler opens the fenced transaction without a cross-tenant read. */
  companyId: string
  /** Who waits on it (#132 §1): the quota engine spends an interactive job's calls down to zero and stops a batch job at the reserve. Absent on a job sent before #171, which only the office sent. */
  class?: RoutingJobClass
}

/** The class a job's data carries; a job sent before #171 was the office's, so interactive. */
export const classOf = (data: RoutingJobData): RoutingJobClass => data.class ?? "interactive"

/**
 * How every routing job is sent: under its Plan's id as the singleton key,
 * at the priority its class and the route's operating date give it
 * (@waste/domain/routing/jobs), and, for a deferral, not before `startAfter`.
 */
export function routingSendOptions({ data, operatingDate, startAfter }: { data: RoutingJobData; operatingDate: string; startAfter?: Date }): SendInTransactionOptions & { singletonKey: string } {
  return {
    singletonKey: data.planId,
    priority: routingJobPriority({ class: classOf(data), operatingDate }),
    ...(startAfter === undefined ? {} : { startAfter }),
  }
}

/** Sends a Plan's job inside `tx`; null when pg-boss refused it because the Plan's job is already live. */
export function sendRoutingJob(send: Send, tx: Tx, queue: string, data: RoutingJobData, route: { operatingDate: string }): Promise<string | null> {
  return sendInTransaction(send, tx, queue, data, routingSendOptions({ data, operatingDate: route.operatingDate }))
}

export type NewPlan = {
  companyId: string
  projectId: string
  routeId: string
  solver: "optimiser" | "manual" | "baseline"
  trip: "full" | "stops-only"
  provider: string
  fingerprint: string
  /** The known sequence, written at creation for `manual` and `baseline` (#124 §1); an `optimiser` Plan has none until it is solved. */
  stops?: readonly string[]
}

/** Writes the Plan `calculating` with its creation-time stops, and answers its id. */
export async function createPlan(tx: Tx, input: NewPlan): Promise<string> {
  const [created] = await tx
    .insert(plan)
    .values({
      companyId: input.companyId,
      projectId: input.projectId,
      routeId: input.routeId,
      solver: input.solver,
      status: "calculating",
      trip: input.trip,
      provider: input.provider,
      fingerprint: input.fingerprint,
    })
    .returning({ id: plan.id })
  const stops = input.stops ?? []
  if (stops.length > 0) {
    await tx.insert(planStop).values(
      stops.map((pickupId, index) => ({
        companyId: input.companyId,
        projectId: input.projectId,
        routeId: input.routeId,
        planId: created.id,
        pickupId,
        position: index + 1,
      })),
    )
  }
  return created.id
}

// Making a Plan active supersedes the optimisations it overtakes (#171,
// amending #124 §2; ADR-0009): a later order wins, so an optimiser's answer
// to an earlier request is never made active over it, and the waiting ones
// are failed `superseded` where the activation is written rather than left
// reading `calculating` until their jobs wake. Two ways, one each for who
// activates: a request overtakes every optimisation waiting on the route
// (`activatePlan`); an optimiser's answer only those asked for before it
// (`activateSolved`), since an answer supersedes no request made after it.

/** The route's optimisations still waiting, of those `which` names, failed as superseded. */
async function supersedeWaiting(tx: Tx, keys: { companyId: string; routeId: string; planId: string }, which: "every other" | "older"): Promise<void> {
  await tx
    .update(plan)
    .set({ status: "failed", failureReason: SUPERSEDED, deferredUntil: null })
    .where(
      and(
        eq(plan.companyId, keys.companyId),
        eq(plan.routeId, keys.routeId),
        eq(plan.solver, "optimiser"),
        eq(plan.status, "calculating"),
        // Plan ids are UUIDv7: an older Plan is a lesser id.
        which === "older" ? lt(plan.id, keys.planId) : ne(plan.id, keys.planId),
      ),
    )
}

const setActive = (tx: Tx, keys: { companyId: string; routeId: string; planId: string }) =>
  tx
    .update(route)
    .set({ activePlanId: keys.planId })
    .where(and(eq(route.companyId, keys.companyId), eq(route.id, keys.routeId)))

/** Makes the Plan the route's active one at a request's word — a `manual` or `baseline` Plan at creation (#124 §2), a cached order re-activated — and fails every optimisation waiting on the route. */
export async function activatePlan(tx: Tx, keys: { companyId: string; routeId: string; planId: string }): Promise<void> {
  await setActive(tx, keys)
  await supersedeWaiting(tx, keys, "every other")
}

/** Makes an optimiser's answer the route's active Plan on `ready` (#124 §2), and fails the optimisations waiting on the route that were asked for before it. */
export async function activateSolved(tx: Tx, keys: { companyId: string; routeId: string; planId: string }): Promise<void> {
  await setActive(tx, keys)
  await supersedeWaiting(tx, keys, "older")
}

/** The route's Plans of one fingerprint, newest first: the cache and deduplication lookup (#124 §4). */
export async function plansMatching(tx: Tx, keys: { companyId: string; routeId: string; fingerprint: string }): Promise<{ id: string; status: string }[]> {
  return await tx
    .select({ id: plan.id, status: plan.status })
    .from(plan)
    .where(and(eq(plan.companyId, keys.companyId), eq(plan.routeId, keys.routeId), eq(plan.fingerprint, keys.fingerprint)))
    .orderBy(desc(plan.id))
}

/**
 * Whether a routing job for this Plan is still pg-boss's to run: a live row
 * (created, retry or active) on the queue under the Plan's singleton key —
 * `jobHeld` (../jobs.ts) asked by the plan's id. A `calculating` match whose
 * job pg-boss lost (retries exhausted, the row archived) is re-sent by the
 * caller rather than answered as on its way forever (#187's hardening, held
 * here too).
 */
export async function routingJobHeld(tx: Tx, queue: string, planId: string): Promise<boolean> {
  const rows = await tx.execute<{ held: boolean }>(sql`select ${jobHeld({ queue, singletonKey: planId })} as held`)
  return rows[0]?.held === true
}

/** One Plan's stops in its order: the pickup ids position 1..n. */
export async function planStopIds(tx: Tx, keys: { companyId: string; planId: string }): Promise<string[]> {
  const rows = await tx
    .select({ pickupId: planStop.pickupId })
    .from(planStop)
    .where(and(eq(planStop.companyId, keys.companyId), eq(planStop.planId, keys.planId)))
    .orderBy(asc(planStop.position))
  return rows.map((row) => row.pickupId)
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

/**
 * What a request over the route keys on: its trip, and its fingerprint over
 * the ends the result depends on and each stop's place (#124 §4, corrected by
 * #132 §6). The one spelling the cache lookup below and the horizon's
 * question — does the active Plan still answer the route? — share.
 */
export async function planKey(
  tx: Tx,
  companyId: string,
  routeRow: { id: string; depotId: string | null; unloadingStationId: string | null },
  request: { solver: PlanSolver; orderedPickupIds: readonly string[] },
  routing: { name: string; profile: string },
): Promise<{ trip: PlanTrip; fingerprint: string }> {
  const parts = await fingerprintParts(tx, companyId, routeRow, request.solver, request.orderedPickupIds)
  const fingerprint = planFingerprint({
    provider: routing.name,
    profile: routing.profile,
    solver: request.solver,
    depot: parts.depot,
    station: parts.station,
    stops: parts.stops,
  })
  return { trip: parts.trip, fingerprint }
}

export type EnsuredPlan = { planId: string; created: boolean }

/**
 * The one door a Plan is asked for through: fingerprint, cache, create,
 * activate, enqueue — all in the caller's transaction, the provider never
 * called (#124 §4: the call is the job's, outside any transaction). A `ready`
 * match is re-activated and consumes no call; a `calculating` one is answered
 * as it stands (its job held, or re-sent, under the Plan-id singleton); a `failed` one is
 * retried with a new Plan. The office asks through it `interactive` (apps/api,
 * routes/plan-shapes.ts), the horizon `batch` (apps/worker, #172). A queue no
 * worker has made throws `QueueMissing` from the send, for the caller to answer.
 */
export async function ensurePlan(
  tx: Tx,
  companyId: string,
  routeRow: { id: string; projectId: string; operatingDate: string; depotId: string | null; unloadingStationId: string | null },
  request: { solver: PlanSolver; orderedPickupIds: readonly string[]; class: RoutingJobClass },
  { routing, send: sendJob }: { routing: { name: string; profile: string }; send: Send },
): Promise<EnsuredPlan> {
  const { trip, fingerprint } = await planKey(tx, companyId, routeRow, request, routing)
  // A match is reusable only when its stops are the request's very pickups: the
  // fingerprint keys coordinates, and regeneration re-mints ids at the same
  // places — replaying such a Plan would answer the baseline while claiming the
  // order. An optimiser Plan still calculating has no stops to compare and its
  // solver reads the route's stops when it runs, so it is reused as it stands.
  const sameStops = async (matchId: string): Promise<boolean> => {
    const named = await planStopIds(tx, { companyId, planId: matchId })
    return named.length === request.orderedPickupIds.length && new Set(named).size === new Set([...named, ...request.orderedPickupIds]).size
  }
  const queue = routingQueueOf(request.solver)
  const send = async (planId: string) => {
    // The Plan's id keys the singleton: one live job per Plan, and Plans of one (route, fingerprint) are already
    // deduplicated above — a queue-wide fingerprint key would let another route's identical trip swallow this send.
    await sendRoutingJob(sendJob, tx, queue, { planId, companyId, class: request.class }, routeRow)
  }
  const matches = await plansMatching(tx, { companyId, routeId: routeRow.id, fingerprint })
  const ready = matches.find((match) => match.status === "ready")
  if (ready !== undefined && (await sameStops(ready.id))) {
    await activatePlan(tx, { companyId, routeId: routeRow.id, planId: ready.id })
    return { planId: ready.id, created: false }
  }
  const calculating = matches.find((match) => match.status === "calculating")
  if (calculating !== undefined && (request.solver === "optimiser" || (await sameStops(calculating.id)))) {
    // The order is applied, not merely acknowledged: a manual or baseline match becomes the active Plan again.
    if (activeOnCreation(request.solver)) await activatePlan(tx, { companyId, routeId: routeRow.id, planId: calculating.id })
    // And its job may be gone (retries exhausted, the row archived): re-send under the same key, #187's hardening.
    if (!(await routingJobHeld(tx, queue, calculating.id))) await send(calculating.id)
    return { planId: calculating.id, created: false }
  }
  const planId = await createPlan(tx, {
    companyId,
    projectId: routeRow.projectId,
    routeId: routeRow.id,
    solver: request.solver,
    trip,
    provider: routing.name,
    fingerprint,
    stops: request.solver === "optimiser" ? [] : request.orderedPickupIds,
  })
  if (activeOnCreation(request.solver)) await activatePlan(tx, { companyId, routeId: routeRow.id, planId })
  await send(planId)
  return { planId, created: true }
}
