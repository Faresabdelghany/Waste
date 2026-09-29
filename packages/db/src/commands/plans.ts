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
// Both queues are `exclusive` and every send carries the Plan's fingerprint
// as `singletonKey` (the worker's registry creates the queues so), so two
// requests for one result collapse into one job (#132 §3). The fingerprint is
// also the cache key: `plansMatching` answers the route's Plans of one
// fingerprint, newest first, and the caller re-activates a `ready` match
// instead of asking the provider again (#124 §4), enqueues nothing beside a
// `calculating` one, and retries a `failed` one with a new Plan.
import { asc, eq, and, desc } from "drizzle-orm"

import type { Tx } from "../client"
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

/** Makes the Plan the route's active one: what a `manual` or `baseline` Plan gets at creation and an `optimiser` one on `ready` (#124 §2). */
export async function activatePlan(tx: Tx, keys: { companyId: string; routeId: string; planId: string }): Promise<void> {
  await tx
    .update(route)
    .set({ activePlanId: keys.planId })
    .where(and(eq(route.companyId, keys.companyId), eq(route.id, keys.routeId)))
}

/** The route's Plans of one fingerprint, newest first: the cache and deduplication lookup (#124 §4). */
export async function plansMatching(tx: Tx, keys: { companyId: string; routeId: string; fingerprint: string }): Promise<{ id: string; status: string }[]> {
  return await tx
    .select({ id: plan.id, status: plan.status })
    .from(plan)
    .where(and(eq(plan.companyId, keys.companyId), eq(plan.routeId, keys.routeId), eq(plan.fingerprint, keys.fingerprint)))
    .orderBy(desc(plan.id))
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
