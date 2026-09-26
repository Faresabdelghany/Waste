// What a job is to this process, so the registry (index.ts) and the wiring
// (../boss.ts) agree without either reading the other's files. One job is one
// file under this directory exporting one `JobDefinition`, and one line in
// index.ts; the wiring gives every job of the list its queue (created with the
// job's own options), a worker, and, where it has a `schedule`, a cron
// schedule on the queue, and takes the schedule away when the job stops
// naming one. Nothing here knows pg-boss's connection: a handler gets what it
// needs from the context, so a test runs it with pools of its own.
import type { Database } from "@waste/db/client"
import type { Job, Queue, ScheduleOptions, SendOptions, WorkOptions } from "pg-boss"

/** What a handler runs with. Built once per process by main.ts, handed to every job; a test builds its own. */
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
   * transaction passes `{ db: inTransaction(tx) }` in the options
   * (./transaction.ts, pg-boss's own Drizzle adapter), as the plan-ahead
   * sweep does for the run and its job.
   */
  send: (name: string, data: object | null, options?: SendOptions) => Promise<string | null>
}

/**
 * One job. `queue` is its name in pg-boss (`<context>.<verb>`:
 * `planning.generate-routes`, `execution.relay-outbox`, `resolution.open-tickets`),
 * unique across the registry, which the registry test holds. `handler`
 * receives the batch pg-boss fetched (one job unless `workOptions.batchSize`
 * says otherwise) and the context, and throws to fail them all; what it
 * returns is the jobs' output. `queueOptions` are what `createQueue` is given
 * the first time and `updateQueue` every start after, so a retry policy
 * changed in the file is the policy in the database. `schedule` is a cron
 * expression (five fields, UTC unless `scheduleOptions.tz` says otherwise)
 * that sends the job with `scheduleData` on every occurrence; a job without
 * one is sent by someone — the API, another job.
 */
export type JobDefinition<Data extends object = object> = {
  queue: string
  /** What the job is for, one sentence, for the person reading the registry. */
  description: string
  handler: (jobs: Job<Data>[], context: JobContext) => Promise<unknown>
  /** Retry, expiry and retention of the queue, and its `policy` (`standard` unless said; `exclusive` for one job per key queued or active); pg-boss's defaults otherwise (two retries, 15 minutes to run, kept 7 days once done). The policy is set when the queue is created and never changed after, which pg-boss refuses. */
  queueOptions?: Omit<Queue, "name">
  /** Polling and concurrency of this process's worker on the queue; pg-boss's defaults otherwise (one job at a time, polled every two seconds). */
  workOptions?: WorkOptions
  /** A cron expression; the job recurs on it. */
  schedule?: string
  /** The payload every scheduled occurrence carries. */
  scheduleData?: Data
  /** `tz`, `key`, `missed` and the send options of a scheduled occurrence. */
  scheduleOptions?: ScheduleOptions
}

/** Spells a job with its data type inferred from the handler, and nothing else: `export const someJob = defineJob({ ... })`. */
export const defineJob = <Data extends object>(definition: JobDefinition<Data>): JobDefinition<Data> => definition

/** The registry's element type: a job whose data is some object, which is what the wiring needs and all it needs. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the registry holds jobs of different data types; the wiring never reads the data, pg-boss hands each handler its own.
export type AnyJob = JobDefinition<any>
