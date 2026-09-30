// What routing's two jobs share (#171): how a Plan fails, how it is deferred,
// what the quota engine is told before a job and what is stored after it,
// and how the answer is settled with pg-boss. Each job reads in one fenced
// transaction, calls the provider through the engine outside any transaction
// (#124 §4), and writes in a second one that re-reads the Plan under its row
// lock, so a replay or a Plan that moved meanwhile writes nothing.
//
// A deferral (#132 §4) is one transaction: `deferred_until` on the Plan, the
// job completed and the same job re-sent under the Plan's key for the reset
// (`succeedInTransaction`, @waste/db/jobs) — all three or none, so a
// deferral never leaves a Plan waiting on a job that is not there. The
// family's row (`routing_quota`) is written in a transaction of its own
// right after the calls, whatever became of them, whenever the job learned
// something of the family — so a job that then fails, to its retries or its
// Plan's write, still leaves the reading its paid calls taught — and a job
// reads the rows first so the engine of a fresh process adopts them.
//
// The handlers run with pg-boss's `perJobResults`: a job answers `completed`
// — a deferral's job included, which settled itself in its transaction and
// which pg-boss's own completion then finds already done — or `deadletter`
// for the key refused, which pg-boss fails at once, spending no retry (#132
// §4: final, without retry). A transient failure is thrown and retried.
import type { Point, Position2D } from "@waste/contracts/geojson"
import type { Tx } from "@waste/db/client"
import { routingSendOptions, type RoutingJobData } from "@waste/db/commands/plans"
import { recordQuota, type QuotaRow } from "@waste/db/commands/routing-quota"
import { succeedInTransaction } from "@waste/db/jobs"
import { plan } from "@waste/db/schema/routing"
import { withCompany } from "@waste/db/tenant"
import { samePosition } from "@waste/routing/geodesy"
import type { QuotaFamily, RoutedLeg } from "@waste/routing/provider"
import type { QuotaEngine } from "@waste/routing/quota"
import { eq } from "drizzle-orm"
import type { Job } from "pg-boss"

import type { JobContext } from "./definition"

/** How pg-boss settles a job of these queues. */
export type Disposition = { id: string; status: "completed" | "deadletter" }

export const positionOf = (location: Point | null): Position2D | null => (location ? [location.coordinates[0], location.coordinates[1]] : null)

/**
 * The legs within the trip from its `first` to its `last` point, both
 * indices into `trip` as asked for, from legs the provider answered one per
 * consecutive pair of distinct points (provider.ts; the rule is
 * `distinctConsecutive`, @waste/routing/geodesy, and `samePosition` below):
 * a stops-only Plan ordered from the depot keeps only the legs between its
 * stops.
 */
export function legsWithin(trip: readonly Position2D[], legs: readonly RoutedLeg[], first: number, last: number): RoutedLeg[] {
  const collapsed: number[] = []
  trip.forEach((point, index) => collapsed.push(index === 0 ? 0 : collapsed[index - 1] + (samePosition(point, trip[index - 1]) ? 0 : 1)))
  if (legs.length !== collapsed[collapsed.length - 1]) throw new Error(`routing: the provider answered ${legs.length} legs for a trip of ${collapsed[collapsed.length - 1] + 1} points`)
  return legs.slice(collapsed[first], collapsed[last])
}

/** Each stored row handed to the engine, which takes it where it is newer than what the process learned itself. */
export function adoptRows(engine: QuotaEngine, rows: readonly QuotaRow[]): void {
  for (const { family, updatedAt, ...standing } of rows) engine.adopt(family, { ...standing, observedAt: updatedAt })
}

/** When the engine last learned something of the family: compared before and after a job to tell whether the row is owed a write. */
export const learnedAt = (engine: QuotaEngine, family: QuotaFamily): number | null => engine.state(family).observedAt?.getTime() ?? null

/**
 * Writes the family's row for the company when the job taught the engine
 * something (#132 §5: after every provider response), in a transaction of
 * its own. Bookkeeping, not the job's work: a write that fails is a line in
 * the log, never the job's failure, and the next job writes the reading
 * again, the engine holding it meanwhile.
 */
export async function recordLearned(context: JobContext, companyId: string, family: QuotaFamily, before: number | null): Promise<void> {
  const engine = context.routing
  if (learnedAt(engine, family) === before) return
  try {
    await withCompany(context.api.db, companyId, (tx: Tx) => recordQuota(tx, { companyId, provider: engine.name, family }, engine.state(family)))
  } catch (error) {
    context.log(`routing: the ${family} reading was not stored (${error instanceof Error ? error.message : String(error)}); the next job stores it`)
  }
}

/** Locks the Plan and answers whether it still waits on this job: `calculating`, and there. */
async function stillCalculating(tx: Tx, planId: string, log: (message: string) => void, queue: string): Promise<boolean> {
  const [locked] = await tx.select({ status: plan.status }).from(plan).where(eq(plan.id, planId)).for("update")
  if (locked?.status === "calculating") return true
  log(`${queue}: plan ${planId} moved to ${locked?.status ?? "nowhere"} meanwhile; this run writes nothing`)
  return false
}

/** Fails the Plan under its row lock: the provider's sentence, or the structured `superseded`; a Plan that moved meanwhile is left as it is. */
export async function failPlan(tx: Tx, planId: string, sentence: string, log: (message: string) => void, queue: string): Promise<void> {
  if (!(await stillCalculating(tx, planId, log, queue))) return
  await tx.update(plan).set({ status: "failed", failureReason: sentence, deferredUntil: null }).where(eq(plan.id, planId))
}

/**
 * Defers the Plan to `until` (#132 §4): `deferred_until` written, the job
 * completed and re-sent — the same data, the same key, the priority its
 * class and the route's day give it — to start then, inside `tx`.
 */
export async function deferPlan(tx: Tx, context: JobContext, job: Job<RoutingJobData>, queue: string, { until, operatingDate }: { until: Date; operatingDate: string }): Promise<void> {
  if (!(await stillCalculating(tx, job.data.planId, context.log, queue))) return
  await tx.update(plan).set({ deferredUntil: until }).where(eq(plan.id, job.data.planId))
  const options = routingSendOptions({ data: job.data, operatingDate, startAfter: until })
  const successor = await succeedInTransaction(context.complete, context.send, tx, { queue, id: job.id }, job.data, options)
  if (successor === null) context.log(`${queue}: plan ${job.data.planId} already has a live job; the deferral leaves it to that one`)
}
