// What a job is to this process, so the registry (../jobs.ts) and the wiring
// (boss.ts) agree without either reading the other's files. One job is one
// file of its context (`src/<context>/`) exporting one `JobDefinition`, and
// one line in the registry; the wiring gives every job of the list its queue
// (created with the job's own options), a worker, and, where it has a
// `schedule`, a cron schedule on the queue, and takes the schedule away when
// the job stops naming one; a job that sends to queues of its own
// (`publishes`) has them created too, so a send never meets a queue that does
// not exist. Nothing here knows pg-boss's connection: a handler gets what it
// needs from the context, so a test runs it with pools of its own.
//
// The context is narrow: `JobContext` is what every handler has, and what a
// few jobs need beyond it — the routing engine, the messaging provider, the
// proofs' Storage — is a type of their own context's, which a job names as
// its definition's second parameter. The registry holds every job of its
// list to one context, `WorkerContext`, which main.ts builds, so a job that
// names a need the process does not meet fails the build there.
import type { Database } from "@waste/db/client"
import type { Complete, Send } from "@waste/db/jobs"
import type { Job, Queue, QueueOptions, ScheduleOptions, WorkOptions } from "pg-boss"

/** What every handler runs with. Built once per process by main.ts; a test builds its own (`../__tests__/context.ts`). */
export type JobContext = {
  /**
   * The API role's pool: every write a job makes runs on it under
   * `withCompany` (from `@waste/db/tenant`), so a job's rows are fenced by
   * the tenant exactly as a request's are. `wms_api` sees nothing with no
   * company set, so a handler that forgot the wrapper reads and writes
   * nothing, loudly.
   */
  api: Database
  /**
   * The worker role's pool, `wms_worker`: BYPASSRLS, SELECT on every wms
   * table and no write right on any. For the one kind of statement in the
   * system that reads across tenants — the sweep for work to do (#97's
   * plan-ahead, #104's relay) — and for nothing a company's own transaction
   * could answer. A write on it is 42501.
   */
  worker: Database
  /** The process's clock, for a handler that reads the time; a test pins it. */
  now: () => Date
  /** Where a handler's lines go; console.log unless a test wants to look. */
  log: (message: string) => void
  /**
   * `boss.send(name, data, options)` as this process is connected: how a
   * handler enqueues another job. A handler that must enqueue in its own
   * transaction goes through `sendInTransaction` (`@waste/db/jobs`, pg-boss's
   * own Drizzle adapter `fromDrizzle(tx, sql)` over the `db` option, the
   * spelling the API's generation trigger shares), as the plan-ahead sweep
   * does for the run and its job and the relay for the stamp and its sends —
   * so the job row commits with the handler's rows or not at all.
   */
  send: Send
  /**
   * `boss.complete(name, id, undefined, options)` as this process is
   * connected: how a routing job settles its own job inside its transaction
   * before sending its successor under the same singleton key
   * (`succeedInTransaction`, `@waste/db/jobs`) — a deferral (#171).
   */
  complete: Complete
}

/**
 * The Pilot's polling knob, `WORKER_POLLING_INTERVAL_SECONDS` (#149): the
 * floor under every poll this process makes — each queue's, which the wiring
 * raises to it (boss.ts), and a handler's own cadence where it has one (the
 * relay's successor delay). Undefined where the deployment leaves it unset:
 * the code's own defaults.
 */
export type PollingKnob = { pollingIntervalSeconds: number | undefined }

/**
 * One job. `queue` is its name in pg-boss (`<context>.<verb>`:
 * `planning.generate-routes`, `execution.relay-outbox`, `resolution.open-tickets`),
 * unique across the registry, which the registry test holds. `handler`
 * receives the batch pg-boss fetched (one job unless `workOptions.batchSize`
 * says otherwise) and the context, and throws to fail them all; what it
 * returns is the jobs' output. `queueOptions` are what `createQueue` is given
 * the first time and `updateQueue` every start after, so a retry policy
 * changed in the file is the policy in the database — for the options the
 * file still names: pg-boss's `updateQueue` keeps a column whose option the
 * call leaves out, so an option removed from a file stays in the database at
 * its last value until a file names it again. `schedule` is a cron
 * expression (five fields, UTC unless `scheduleOptions.tz` says otherwise)
 * that sends the job with `scheduleData` on every occurrence; a job without
 * one is sent by someone — the API, another job. `publishes` names the queues
 * the handler sends to that no job of the registry works — the relay's
 * `outbox.<kind>` queues, one per kind of `OUTBOX_KINDS`, and its dead-letter
 * queue `outbox.dead` — each created with its options at start, so a send
 * finds its queue whether or not a consumer has registered yet. A consumer of
 * the outbox is not a job of its own but a worker on one of those queues:
 * `defineOutboxConsumer` (outbox.ts) spells one `JobDefinition` per kind,
 * its `queue` `outbox.<kind>.<consumer>`, spread into the registry, so the
 * relay's `send` is the one door an event takes. `Context` is what the
 * handler reads: `JobContext`, or it and what the job's own context adds.
 */
export type JobDefinition<Data extends object = object, Context extends JobContext = JobContext> = {
  queue: string
  /** What the job is for, one sentence, for the person reading the registry. */
  description: string
  handler: (jobs: Job<Data>[], context: Context) => Promise<unknown>
  /**
   * Retry, expiry and retention of the queue, its `policy` (`standard`
   * unless said: the relay is `short`, one queued tick at a time) and its
   * `deadLetter` (the queue a job that failed past its retries is copied to,
   * data and all, for an operator to redrive; the consumers' queues name
   * `outbox.dead`); pg-boss's defaults otherwise (two retries, 15 minutes to
   * run, kept 7 days once done, no dead letter). The policy is set when the
   * queue is created and never rewritten — pg-boss refuses to change one —
   * so a policy changed in the file is an operator's `deleteQueue` first;
   * the dead letter is rewritten at every start like any other option, and
   * must name a queue that exists when the job's own is created, which is
   * why the relay `publishes` it before any consumer's queue is brought up.
   */
  queueOptions?: JobQueueOptions
  /** Polling and concurrency of this process's worker on the queue; pg-boss's defaults otherwise (one job at a time, polled every two seconds). */
  workOptions?: WorkOptions
  /** A cron expression; the job recurs on it. */
  schedule?: string
  /** The payload every scheduled occurrence carries. */
  scheduleData?: Data
  /** `tz`, `key`, `missed` and the send options of a scheduled occurrence. */
  scheduleOptions?: ScheduleOptions
  /** Queues the handler sends to and nobody in the registry works, created (and brought to their options) at start, in this order; `[]` and undefined mean none. */
  publishes?: readonly PublishedQueue[]
  /**
   * A queue whose waiting jobs this one takes over at every start, before any
   * worker runs: the queue its jobs were sent to before, or where they wait
   * for it — an outbox consumer's kind's own `outbox.<kind>` (#339). Each job
   * waiting there is copied to every queue that inherits it and completed
   * there, in one transaction (boss.ts, `drainInherited`).
   */
  inherits?: string
  /**
   * Takes none of what waits on `inherits`: the relay sends to this queue
   * from the start of the process that first runs it, and what waited there
   * before — an outbox kind's backlog, events emitted before the consumer
   * existed — stays for the heirs that drain it, or expires under its
   * retention. For a consumer whose effect must not reach back to news it
   * was never meant for: a granted pause's (M11 of #293), which would pause
   * a subscription, and change its charges, on a decision made months ago.
   */
  startsFresh?: true
}

/** What a queue is created with: pg-boss's `QueueOptions` and, optionally, the `policy` and the `deadLetter`. `partition` is not offered: the role may not create a partition. */
export type JobQueueOptions = QueueOptions & Pick<Queue, "policy" | "deadLetter">

/** A queue a job sends to without working it: its name and, like a job's own, the options it is created with and brought to. */
export type PublishedQueue = {
  queue: string
  queueOptions?: JobQueueOptions
}

/** The options `updateQueue` takes: everything but the policy, which pg-boss refuses to change after creation. */
export function updatableOptions({ policy: _policy, ...options }: JobQueueOptions): Omit<JobQueueOptions, "policy"> {
  return options
}

/** Spells a job, and nothing else: `export const someJob = defineJob<SomeData>({ ... })`, or `defineJob<SomeData, JobContext & RoutingEngine>` for a job that needs more than the core. */
export const defineJob = <Data extends object, Context extends JobContext = JobContext>(definition: JobDefinition<Data, Context>): JobDefinition<Data, Context> => definition

/**
 * A job of any data, run with the context `Context` has: what `startBoss`
 * registers. Without `Context`, a job whatever its context needs — what code
 * that reads the list and never runs a handler takes (the relay's routes, the
 * drain, the registry test).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the registry holds jobs of different data types; the wiring never reads the data, pg-boss hands each handler its own.
export type AnyJob<Context extends JobContext = never> = JobDefinition<any, Context>
