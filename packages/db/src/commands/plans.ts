// What the two processes share of routing's jobs (#170, decided on #124 and
// #132): the two queue names, what a routing job carries, and the Plan writes
// every sender makes. A Plan is asked for from the office twice over —
// `POST /routes/:id/optimise` and the reorder that becomes a `manual` Plan
// (apps/api) — and, from #172 on, by generation and the horizon sweep
// (apps/worker); each sender writes the `plan` row (a known sequence's stops
// with it, #124 §1) and sends the job in one transaction, so the names, the
// payload and the writes are spelled here, once, rather than in two apps that
// cannot import each other.
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
import { routingJobPriority } from "@waste/domain/routing/jobs"
import { SUPERSEDED, type RoutingJobClass } from "@waste/domain/routing/vocabulary"
import { asc, eq, and, desc, lt, ne, sql } from "drizzle-orm"

import type { Tx } from "../client"
import { jobHeld, sendInTransaction, type Send, type SendInTransactionOptions } from "../jobs"
import { route } from "../schema/execution"
import { plan, planStop } from "../schema/routing"

/** The queue a `baseline` or `manual` Plan's measurement is sent to and worked on. */
export const ROUTING_MEASURE_QUEUE = "routing.measure"

/** The queue an `optimiser` Plan is sent to; its worker arrives with #171 (S3), and a job waits until it does. */
export const ROUTING_OPTIMISE_QUEUE = "routing.optimise"

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
