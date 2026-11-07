// What routing's two jobs share (#171): one runner (`definePlanJob`) that a
// job hands what it reads, what it calls and what it writes. Each job reads
// in one fenced transaction, calls the provider through the engine outside
// any transaction (#124 §4), and writes in a second one that re-reads the
// Plan under its row lock, so a replay or a Plan that moved meanwhile writes
// nothing. What cannot be asked is final, the way #132 §4 has it: the Plan
// `failed` with the sentence and the job complete.
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
// §4: final, without retry). A transient failure — a second 429 running, the
// network — is thrown and retried.
import type { Point, Position2D } from "@waste/contracts/geojson"
import type { Tx } from "@waste/db/client"
import { classOf, routingSendOptions, type RoutingJobData } from "@waste/db/commands/plans"
import { recordQuota, type QuotaRow } from "@waste/db/commands/routing-quota"
import { succeedInTransaction } from "@waste/db/jobs"
import { plan } from "@waste/db/schema/routing"
import { withCompany } from "@waste/db/tenant"
import { samePosition } from "@waste/domain/geo"
import type { RoutingJobClass } from "@waste/domain/routing/vocabulary"
import type { QuotaFamily, RoutedLeg } from "@waste/routing/provider"
import type { Outcome, QuotaEngine } from "@waste/routing/quota"
import { eq } from "drizzle-orm"
import type { Job } from "pg-boss"

import { defineJob, type JobContext, type JobDefinition, type JobQueueOptions } from "../runtime/definition"
import type { RoutingContext } from "./engine"

/** How pg-boss settles a job of these queues. */
export type Disposition = { id: string; status: "completed" | "deadletter" }

export const positionOf = (location: Point | null): Position2D | null => (location ? [location.coordinates[0], location.coordinates[1]] : null)

/**
 * The legs within the trip from its `first` to its `last` point, both
 * indices into `trip` as asked for, from legs the provider answered one per
 * consecutive pair of distinct points (provider.ts; the rule is
 * `distinctConsecutive`, @waste/domain/geo, and `samePosition` below):
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
function adoptRows(engine: QuotaEngine, rows: readonly QuotaRow[]): void {
  for (const { family, updatedAt, ...standing } of rows) engine.adopt(family, { ...standing, observedAt: updatedAt })
}

/** When the engine last learned something of the family: compared before and after a job to tell whether the row is owed a write. */
const learnedAt = (engine: QuotaEngine, family: QuotaFamily): number | null => engine.state(family).observedAt?.getTime() ?? null

/**
 * Writes the family's row for the company when the job taught the engine
 * something (#132 §5: after every provider response), in a transaction of
 * its own. Bookkeeping, not the job's work: a write that fails is a line in
 * the log, never the job's failure, and the next job writes the reading
 * again, the engine holding it meanwhile.
 */
async function recordLearned(context: Pick<RoutingContext, "api" | "log" | "routing">, companyId: string, family: QuotaFamily, before: number | null): Promise<void> {
  const engine = context.routing
  if (learnedAt(engine, family) === before) return
  try {
    await withCompany(context.api.db, companyId, (tx: Tx) => recordQuota(tx, { companyId, provider: engine.name, family }, engine.state(family)))
  } catch (error) {
    context.log(`routing: the ${family} reading was not stored (${error instanceof Error ? error.message : String(error)}); the next job stores it`)
  }
}

/** The Plan a write holds under its row lock, still waiting on this job. */
export type LockedPlan = { projectId: string; routeId: string }

/** Locks the Plan and answers it while it still waits on this job — `calculating`, and there — or logs that it moved and answers undefined. */
async function lockCalculating(tx: Tx, planId: string, log: (message: string) => void, queue: string): Promise<LockedPlan | undefined> {
  const [locked] = await tx.select({ status: plan.status, projectId: plan.projectId, routeId: plan.routeId }).from(plan).where(eq(plan.id, planId)).for("update")
  if (locked?.status === "calculating") return { projectId: locked.projectId, routeId: locked.routeId }
  log(`${queue}: plan ${planId} moved to ${locked?.status ?? "nowhere"} meanwhile; this run writes nothing`)
  return undefined
}

/** Fails the Plan under its row lock: the provider's sentence, or the structured `superseded`; a Plan that moved meanwhile is left as it is. */
async function failPlan(tx: Tx, planId: string, sentence: string, log: (message: string) => void, queue: string): Promise<void> {
  if ((await lockCalculating(tx, planId, log, queue)) === undefined) return
  await tx.update(plan).set({ status: "failed", failureReason: sentence, deferredUntil: null }).where(eq(plan.id, planId))
}

/**
 * Defers the Plan to `until` (#132 §4): `deferred_until` written, the job
 * completed and re-sent — the same data, the same key, the priority its
 * class and the route's day give it — to start then, inside `tx`.
 */
async function deferPlan(tx: Tx, context: Pick<JobContext, "log" | "send" | "complete">, job: Job<RoutingJobData>, queue: string, { until, operatingDate }: { until: Date; operatingDate: string }): Promise<void> {
  if ((await lockCalculating(tx, job.data.planId, context.log, queue)) === undefined) return
  await tx.update(plan).set({ deferredUntil: until }).where(eq(plan.id, job.data.planId))
  const options = routingSendOptions({ data: job.data, operatingDate, startAfter: until })
  const successor = await succeedInTransaction(context.complete, context.send, tx, { queue, id: job.id }, job.data, options)
  if (successor === null) context.log(`${queue}: plan ${job.data.planId} already has a live job; the deferral leaves it to that one`)
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

/** Settled per job: a key refusal fails its job without a retry. */
export const ROUTING_WORK_OPTIONS = { perJobResults: true } as const

/** What a routing job's first transaction reads: what it asks the provider, or why it asks nothing — the Plan settled already (`done`), or one that cannot be asked (`refused`, final). */
export type Gathered<Ask> = { kind: "asks"; ask: Ask; operatingDate: string; quota: QuotaRow[] } | { kind: "refused"; sentence: string } | { kind: "done"; status: string }

/** What the write is handed: the Plan, what was asked, and the answer as `shape` kept it and as the provider gave it. */
export type PlanWrite<Ask, Answer, Solved> = {
  planId: string
  companyId: string
  ask: Ask
  solved: Solved
  answer: Answer
  /** Locks the Plan, after whatever the write locks before it in the office's order; undefined, and logged, where it moved meanwhile, and then the write writes nothing. */
  lockPlan: () => Promise<LockedPlan | undefined>
  log: (message: string) => void
}

/** One routing job: its queue, and the read, the call and the write around the provider. */
export type PlanJob<Ask, Answer, Solved> = {
  queue: string
  description: string
  /** The quota families the call may spend, whose readings are stored after it, in this order. */
  families: readonly QuotaFamily[]
  /** The first transaction: the Plan, and what its call asks. */
  gather: (tx: Tx, keys: { planId: string; companyId: string; provider: string }) => Promise<Gathered<Ask>>
  /** The call through the engine, outside any transaction. */
  call: (engine: QuotaEngine, ask: Ask, jobClass: RoutingJobClass) => Promise<Outcome<Answer>>
  /** The answer as the write keeps it, taken before anything is written; throws where it does not fit what was asked, which fails the Plan, since a retry would pay for the same answer again. */
  shape: (ask: Ask, answer: Answer) => Solved
  /** The second transaction's write of an answer. */
  write: (tx: Tx, write: PlanWrite<Ask, Answer, Solved>) => Promise<void>
}

async function runPlanJob<Ask, Answer, Solved>(spec: PlanJob<Ask, Answer, Solved>, job: Job<RoutingJobData>, context: RoutingContext): Promise<Disposition["status"]> {
  const { queue } = spec
  const { planId, companyId } = job.data
  const engine = context.routing
  const gathered = await withCompany(context.api.db, companyId, (tx: Tx) => spec.gather(tx, { planId, companyId, provider: engine.name }))
  if (gathered.kind === "done") {
    context.log(`${queue}: plan ${planId} is ${gathered.status}; this run writes nothing`)
    return "completed"
  }
  if (gathered.kind === "refused") {
    await withCompany(context.api.db, companyId, (tx: Tx) => failPlan(tx, planId, gathered.sentence, context.log, queue))
    context.log(`${queue}: plan ${planId} failed: ${gathered.sentence}`)
    return "completed"
  }
  adoptRows(engine, gathered.quota)
  const before = spec.families.map((family) => [family, learnedAt(engine, family)] as const)
  let outcome: Outcome<Answer>
  try {
    outcome = await spec.call(engine, gathered.ask, classOf(job.data))
  } finally {
    for (const [family, learned] of before) await recordLearned(context, companyId, family, learned)
  }
  let settled: Exclude<Outcome<Answer>, { kind: "answered" }> | { kind: "answered"; answer: Answer; solved: Solved }
  if (outcome.kind === "answered") {
    try {
      settled = { kind: "answered", answer: outcome.result, solved: spec.shape(gathered.ask, outcome.result) }
    } catch (error) {
      const sentence = `the provider's answer did not fit the trip: ${error instanceof Error ? error.message : String(error)}`
      await withCompany(context.api.db, companyId, (tx: Tx) => failPlan(tx, planId, sentence, context.log, queue))
      context.log(`${queue}: plan ${planId} failed: ${sentence}`)
      return "completed"
    }
  } else {
    settled = outcome
  }
  return withCompany(context.api.db, companyId, async (tx: Tx): Promise<Disposition["status"]> => {
    switch (settled.kind) {
      case "deferred":
        await deferPlan(tx, context, job, queue, { until: settled.until, operatingDate: gathered.operatingDate })
        context.log(`${queue}: plan ${planId} waits for the ${settled.family} quota (${settled.cause}) until ${settled.until.toISOString()}`)
        return "completed"
      case "refused":
        await failPlan(tx, planId, settled.sentence, context.log, queue)
        return "completed"
      case "key-refused":
        await failPlan(tx, planId, settled.sentence, context.log, queue)
        return "deadletter"
      case "answered":
        await spec.write(tx, { planId, companyId, ask: gathered.ask, solved: settled.solved, answer: settled.answer, lockPlan: () => lockCalculating(tx, planId, context.log, queue), log: context.log })
        return "completed"
    }
  })
}

/** A routing job as a registry entry: the routing queues' options, settled per job, each job of the batch run through the read, the call and the write. */
export function definePlanJob<Ask, Answer, Solved>(spec: PlanJob<Ask, Answer, Solved>): JobDefinition<RoutingJobData, RoutingContext> {
  return defineJob<RoutingJobData, RoutingContext>({
    queue: spec.queue,
    description: spec.description,
    queueOptions: ROUTING_QUEUE_OPTIONS,
    workOptions: ROUTING_WORK_OPTIONS,
    handler: async (jobs, context): Promise<Disposition[]> => {
      const settled: Disposition[] = []
      for (const job of jobs) settled.push({ id: job.id, status: await runPlanJob(spec, job, context) })
      return settled
    },
  })
}
