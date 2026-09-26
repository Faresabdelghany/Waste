// pg-boss as this process runs it: one instance on the worker role's
// connection, started with `migrate: false` against the schema the owner
// installed in migration 0011 (`PGBOSS_SCHEMA` from `@waste/db/sql/pgboss`),
// and every job of the registry given its queue, its worker and its
// schedule. `migrate: false` is the whole reason the schema is a migration:
// pg-boss's own installer runs as whoever connects, and `wms_worker` owns
// nothing and may create nothing, so `start()` here checks the installed
// version against the one the library expects and refuses to run on any
// other — a pg-boss upgrade that moves its schema version is a new migration
// (`getMigrationPlans`), and the worker refusing to start is what says so
// before a deploy.
//
// The connection must be a session: pg-boss keeps state on it (advisory locks
// for its maintenance and its cron pass, the schedule's clock skew reading)
// that a transaction pooler would spread over backends, so a URL on
// Supabase's port 6543 is refused by env.ts before anything dials. pg-boss
// dials its own pool through `pg`, not postgres.js; the two application pools
// (`@waste/db/client`) are the jobs', not pg-boss's, and the process holds
// three pools in all.
//
// Registration is idempotent by construction, so a restart converges on the
// registry: `createQueue` is a no-op on a queue that exists, `updateQueue`
// then writes the job's queue options over it, `schedule` upserts by queue
// name, a queue that lost its `schedule` in the registry is unscheduled, and
// the queue's `subscriptions` are converged the same way — each event named
// is `subscribe`d (an upsert on `pgboss.subscription`), and an event the
// queue was subscribed to and no longer names is `unsubscribe`d, read off the
// table first (`subscribedEvents`), since pg-boss keeps the table and offers
// no read of it. Queues no job names any more are left alone: their rows are
// evidence and pg-boss's retention removes them in time; an operator deletes
// the queue.
//
// pg-boss's maintenance runs here with what the grants allow: `supervise` on
// (expiring, retrying and deleting jobs, the stats the readiness count
// reads), `reindex` off (REINDEX needs the index's owner, which is the
// migrator), persisted queue statistics off (their daily partitions are
// tables, which the role may not create), warnings not persisted (the same),
// and `useListenNotify` off (polling is enough for a handful of queues, and
// the listener is a fourth connection).
import { PGBOSS_SCHEMA } from "@waste/db/sql/pgboss"
import { PgBoss } from "pg-boss"

import type { AnyJob, JobContext } from "./jobs/definition"

export type BossOptions = {
  /** The worker role's URL, a session connection; env.ts has refused the transaction pooler. */
  url: string
  /** pg-boss's pool size; three is one for the poll, one for a cron pass and one for maintenance. */
  max?: number
  /** Where pg-boss's own errors and warnings go; console.error unless a test wants to look. */
  log?: (line: string) => void
  /** How often pg-boss looks at the clock for schedules, in seconds: 60 in production, less in a test that waits for a beat. */
  cronWorkerIntervalSeconds?: number
  /** How often the queues' counts (the failed count /readyz reads) are refreshed, in seconds. */
  monitorIntervalSeconds?: number
}

/** pg-boss as the process holds it: the instance, and what was registered on it. */
export type Boss = {
  boss: PgBoss
  /** The queues registered, in registry order. */
  queues: readonly string[]
  /** Stops the workers, lets handlers in flight finish within `timeoutMs`, and closes the pool. Idempotent. */
  stop: (timeoutMs?: number) => Promise<void>
}

/** How long stop() lets a handler in flight finish before it is failed and the pool closed. */
export const STOP_TIMEOUT_MS = 10_000

export function createBoss({ url, max = 3, log = (line) => console.error(line), cronWorkerIntervalSeconds, monitorIntervalSeconds }: BossOptions): PgBoss {
  const boss = new PgBoss({
    connectionString: url,
    schema: PGBOSS_SCHEMA,
    application_name: "waste-worker",
    max,
    migrate: false,
    supervise: true,
    schedule: true,
    reindex: false,
    persistQueueStats: false,
    persistWarnings: false,
    useListenNotify: false,
    ...(cronWorkerIntervalSeconds === undefined ? {} : { cronWorkerIntervalSeconds }),
    ...(monitorIntervalSeconds === undefined ? {} : { monitorIntervalSeconds }),
  })
  // An `error` with no listener would throw out of pg-boss's event emitter and end the process; a connection dropped mid-poll is one such error, and pg-boss reconnects on the next poll.
  boss.on("error", (error) => log(`pg-boss: ${error instanceof Error ? error.message : String(error)}`))
  boss.on("warning", (warning) => log(`pg-boss warning: ${JSON.stringify(warning)}`))
  return boss
}

/**
 * Starts pg-boss and registers every job: the queue created or brought to
 * the job's options, the worker with the job's handler over the context, the
 * schedule set or removed, and the subscriptions converged. The registry
 * test has already held the list to unique queues, valid cron expressions
 * and each subscription named once, so what fails here is the database: the
 * schema missing or at another version (`start()` says which), or the role
 * unable to reach it.
 */
export async function startBoss(boss: PgBoss, jobs: readonly AnyJob[], context: JobContext): Promise<Boss> {
  await boss.start()
  const queues: string[] = []
  for (const job of jobs) {
    await boss.createQueue(job.queue, job.queueOptions)
    if (job.queueOptions) await boss.updateQueue(job.queue, job.queueOptions)
    await boss.work(job.queue, job.workOptions ?? {}, (batch) => job.handler(batch, context))
    if (job.schedule !== undefined) {
      await boss.schedule(job.queue, job.schedule, job.scheduleData ?? null, job.scheduleOptions)
    } else {
      await boss.unschedule(job.queue)
    }
    const wanted = job.subscriptions ?? []
    for (const event of await subscribedEvents(boss, job.queue)) {
      if (!wanted.includes(event)) await boss.unsubscribe(event, job.queue)
    }
    for (const event of wanted) await boss.subscribe(event, job.queue)
    queues.push(job.queue)
  }
  let stopping: Promise<void> | undefined
  return {
    boss,
    queues,
    stop: (timeoutMs = STOP_TIMEOUT_MS) => (stopping ??= boss.stop({ graceful: true, timeout: timeoutMs, close: true })),
  }
}

/** The events a queue is subscribed to, off pg-boss's own table: the read pg-boss keeps the table for and does not offer. */
export async function subscribedEvents(boss: Pick<PgBoss, "getDb">, queue: string): Promise<string[]> {
  const { rows } = await boss.getDb().executeSql(`select event from ${PGBOSS_SCHEMA}.subscription where name = $1 order by event`, [queue])
  return (rows as { event: string }[]).map((row) => row.event)
}

/**
 * Whether an expression is one the registry accepts as a schedule: five
 * whitespace-separated fields (minute, hour, day of month, month, day of
 * week) that pg-boss's scheduler parses. pg-boss's parser is more lenient —
 * it takes a sixth field for seconds, or four fields, or none — and the
 * registry is not: a schedule is read by a person, and five fields is the
 * cron a person reads. The registry test asks, and a job file may.
 */
export function isCronExpression(expression: string): boolean {
  if (expression.trim().split(/\s+/).length !== 5) return false
  try {
    // An instance that is never started: previewSchedule is pure arithmetic over the expression, and nothing dials.
    new PgBoss({ connectionString: "postgresql://nobody@127.0.0.1:1/none", schema: PGBOSS_SCHEMA }).previewSchedule(expression, { count: 1 })
    return true
  } catch {
    return false
  }
}
