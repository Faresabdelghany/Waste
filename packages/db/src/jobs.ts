// Enqueueing a pg-boss job inside a transaction, spelled once for both
// processes (Issue #97 part B, Issue #168). The worker runs pg-boss; the API
// runs none and must still hand it one job, the office's generation
// (`POST /route-schemes/:id/generate`), written in the request's transaction
// beside the `generation_run` it carries, so a run without a job or a job
// without its run is not a state the database can be left in — the rule the
// nightly plan-ahead sweep already follows. What the job is called and what
// it carries are `commands/generation.ts`'s; what is here is how a job is
// sent, so the two spell it the same:
//
//   the adapter    — pg-boss's own `fromDrizzle(tx, sql)`: its `IDatabase`
//                    is one method, `executeSql(text, values)`, whose text
//                    carries `pg`'s numbered placeholders, and the adapter
//                    binds each as a Drizzle parameter through the `sql` tag
//                    it is handed. `send(name, data, { db })` then writes the
//                    job row through the transaction and nothing else;
//   the sender     — pg-boss's `send` for a process that runs no pg-boss: an
//                    instance built once and never started, supervising
//                    nothing and scheduling nothing, whose own database is
//                    a pool handed in through the same adapter. `send`
//                    reads the queue's policy and table through that pool,
//                    once per queue name per process, and inserts through
//                    the `db` each call names — pg-boss takes the insert's
//                    connection from the option and the queue's from the
//                    instance (manager.js, `createJob`). Nothing dials on
//                    construction, nothing is started or stopped per
//                    request, and no connection is held beyond the pool's;
//   the generation — the one job the API sends, under the scheme's id as
//                    `singletonKey`, which pg-boss answers null for instead
//                    of a second job while one of the scheme is queued or
//                    active (`policy: "exclusive"` on the queue,
//                    generate-routes.ts); and the question a sender asks
//                    afterwards, whether a run's job is still pg-boss's to
//                    run, spelled here beside the states that mean so.
//
// What this needs of the database is what migration 0011 granted: `USAGE` on
// `pgboss`, `SELECT, INSERT, UPDATE, DELETE` on its tables and `EXECUTE` on
// its functions to `wms_api` and `wms_worker` (migrations/README.md names
// the narrower set a send really needs); `src/__tests__/jobs.test.ts` proves
// the send as `wms_api` against the local stack.
import { sql, type SQL } from "drizzle-orm"
import { fromDrizzle, PgBoss, type Db, type SendOptions } from "pg-boss"

import type { Database, Tx } from "./client"
import { GENERATE_ROUTES_QUEUE, type GenerateRoutesData } from "./commands/generation"
import { PGBOSS_SCHEMA } from "./sql/pgboss"

/** `boss.send(name, data, options)`: the worker's is its started instance's, the API's a sender's below. */
export type Send = (name: string, data: object | null, options?: SendOptions) => Promise<string | null>

/** The options of a send that names no connection of its own: the transaction is this module's to pass. */
export type SendInTransactionOptions = Omit<SendOptions, "db">

/** pg-boss's database over the transaction: `send(name, data, { db: inTransaction(tx) })` enqueues inside it. */
export const inTransaction = (tx: Tx): Db => fromDrizzle(tx, sql)

/** Enqueues inside `tx`: the job row commits or rolls back with the caller's rows. Null when the queue's policy refused a second job under the same `singletonKey`. */
export function sendInTransaction(send: Send, tx: Tx, name: string, data: object | null, options: SendInTransactionOptions = {}): Promise<string | null> {
  return send(name, data, { ...options, db: inTransaction(tx) })
}

/** `boss.complete(name, id, undefined, options)` as the worker's instance has it: one job settled through the `db` it names. */
export type Complete = (name: string, id: string, options: { db: Db }) => Promise<unknown>

/**
 * A running job hands its place to its successor inside `tx` (#171, #132
 * §4's deferral): the job completed and the successor sent under the same
 * singleton key, both through the caller's transaction, so they commit with
 * the caller's rows — the Plan's `deferred_until` — or not at all. On an
 * `exclusive` queue the running job itself holds its key until it is
 * settled, which is why the relay's successor pattern (a `short` queue,
 * where only a queued job counts) cannot be spelled as a plain send here;
 * pg-boss settles a job through `{ db }` by design, and its own completion
 * after the handler finds the job no longer active and updates nothing. Null
 * when pg-boss still refused the successor, which only another job of the
 * same key could cause.
 */
export async function succeedInTransaction(complete: Complete, send: Send, tx: Tx, running: { queue: string; id: string }, data: object, options: SendInTransactionOptions & { singletonKey: string }): Promise<string | null> {
  const db = inTransaction(tx)
  await complete(running.queue, running.id, { db })
  return send(running.queue, data, { ...options, db })
}

/** A process's way of sending jobs without running pg-boss: the API's. */
export type JobSender = {
  /** pg-boss's `send`, over the pool the sender was built on; use `inTransaction` for the `db` option, or `sendInTransaction`. Throws `QueueMissing` for a queue no worker has made. */
  send: Send
}

/**
 * The queue is the worker's, made at its boot (apps/worker/src/boss.ts), so
 * a database no worker has started on has none and pg-boss refuses the send
 * by name. Told apart here, where pg-boss is known, so a caller asks
 * `instanceof` and never reads the library's sentence: the deployment's
 * order is the caller's to say something about (the API answers 503).
 */
export class QueueMissing extends Error {
  readonly queue: string

  constructor(queue: string) {
    super(`No queue ${queue} on this database: the worker that makes it has not started here`)
    this.name = "QueueMissing"
    this.queue = queue
  }
}

/** pg-boss's own sentence for it (manager.js, `getQueueCache`); src/__tests__/jobs.test.ts holds the pinned library to it. */
const QUEUE_DOES_NOT_EXIST = /^Queue \S+ does not exist$/

/**
 * pg-boss's `send` for a process that runs no pg-boss, over `pool`. The
 * instance is built and never started: no pool of its own, no maintenance,
 * no cron pass, no listener; its one read is the queue's row, once per
 * queue name, through `pool`, and its writes go through the `db` each
 * `send` names. `pool` must not be the pool whose connections the callers
 * hold while they send — a request that sends inside its transaction holds
 * one, and `max` such requests on a cold cache would each wait for a
 * connection none of them can free — so the API hands its one-connection
 * probe pool, never its request pool.
 */
export function createJobSender(pool: Database): JobSender {
  const boss = new PgBoss({
    db: fromDrizzle(pool.db, sql),
    schema: PGBOSS_SCHEMA,
    migrate: false,
    supervise: false,
    schedule: false,
    reindex: false,
    persistQueueStats: false,
    persistWarnings: false,
    useListenNotify: false,
  })
  return {
    send: async (name, data, options) => {
      try {
        return await boss.send(name, data, options ?? {})
      } catch (error) {
        if (error instanceof Error && QUEUE_DOES_NOT_EXIST.test(error.message)) throw new QueueMissing(name)
        throw error
      }
    },
  }
}

/**
 * Sends the generation of one run inside `tx`, under the scheme's id as
 * `singletonKey`: null when a job of that scheme is already queued or
 * active, in which case the caller writes no run — the run whose job pg-boss
 * holds covers it.
 */
export function sendGenerateRoutes(send: Send, tx: Tx, run: GenerateRoutesData & { routeSchemeId: string }): Promise<string | null> {
  const data: GenerateRoutesData = { generationRunId: run.generationRunId, companyId: run.companyId }
  return sendInTransaction(send, tx, GENERATE_ROUTES_QUEUE, data, { singletonKey: run.routeSchemeId })
}

/**
 * The states a job is in while pg-boss still means to run it, or is running
 * it (pg-boss's `states`): a run whose job is in none of these has no job
 * coming for it, whatever its own status says.
 */
export const LIVE_JOB_STATES = ["created", "retry", "active"] as const

/**
 * Whether a job is still pg-boss's to run: a row of `queue` in a live state,
 * named by its id — a column or a value, as text: the generation run's job —
 * or by its singleton key: a Plan's routing job (#170, #171). The API role
 * reads pg-boss's schema by migration 0011's grant; the queue's table is
 * partitioned by name, so the name is asked first. The one place outside
 * pg-boss that knows the job table's shape.
 */
export function jobHeld(job: { queue: string } & ({ id: SQL } | { singletonKey: string })): SQL {
  const states = sql.join(
    LIVE_JOB_STATES.map((state) => sql`${state}`),
    sql`, `,
  )
  const which = "id" in job ? sql`j.id::text = ${job.id}` : sql`j.singleton_key = ${job.singletonKey}`
  return sql`exists (select 1 from ${sql.raw(PGBOSS_SCHEMA)}.job j where j.name = ${job.queue} and ${which} and j.state in (${states}))`
}
