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
// then writes the job's queue options over it — each option the file names;
// pg-boss keeps a column the call leaves out, so an option a file once set
// and no longer names stays at its last value — `schedule` upserts by queue
// name, and a queue that lost its `schedule` in the registry is unscheduled.
// A queue a job `publishes` to without working it (the relay's `outbox.<kind>`
// queues and its `outbox.dead`) is created and brought to its options the
// same way, before any worker starts and in the order the job lists them, so
// a handler's send never meets a missing queue, a consumer's queue finds the
// dead-letter queue it names already there, and a consumer that registers
// later finds the rows already there; a consumer's own entries then work
// those queues, and their `queueOptions` are written over the relay's.
// pg-boss's fan-out (`subscribe`/`publish`) is not used: the relay's `send`
// to the kind's queue is the one door, and a consumer is a worker on it.
// Queues no job names any more are left alone: their rows are evidence and
// pg-boss's retention removes them in time; an operator deletes the queue.
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

import { updatableOptions, type AnyJob, type JobContext, type JobQueueOptions } from "./jobs/definition"

export type BossOptions = {
  /** The worker role's URL, a session connection; env.ts has refused the transaction pooler. */
  url: string
  /** pg-boss's pool size; three is one for the poll, one for a cron pass and one for maintenance. */
  max?: number
  /** Where pg-boss's own errors and warnings go; console.error unless a test wants to look. */
  log?: (line: string) => void
  /** How often pg-boss's cron pass runs — reads the clock and sends the occurrences due — in seconds: pg-boss's 30 in production, 1 in a test that waits for a beat. */
  cronMonitorIntervalSeconds?: number
  /** How often the worker that forwards a due occurrence onto its queue polls, in seconds: pg-boss's 5 in production, 1 in a test that waits for a beat. */
  cronWorkerIntervalSeconds?: number
  /** How often the queues' counts (the failed count /readyz reads) are refreshed, in seconds. */
  monitorIntervalSeconds?: number
  /** PROTOTYPE (#134): WORKER_POLLING_INTERVAL_SECONDS — raises pg-boss's cron worker, cron pass and flow poll to it where they poll more often (the cron two capped at pg-boss's 45); an interval already longer stays. */
  pollingIntervalSeconds?: number
}

/** PROTOTYPE (#134): an interval raised to the knob where it polls more often than the knob, never lowered, capped where pg-boss caps it. */
const raised = (defaultSeconds: number, knob: number | undefined, cap = Number.POSITIVE_INFINITY) =>
  knob === undefined ? undefined : Math.min(Math.max(defaultSeconds, knob), cap)

/** pg-boss as the process holds it: the instance, and what was registered on it. */
export type Boss = {
  boss: PgBoss
  /** The queues registered, in registry order. */
  queues: readonly string[]
  /** The queues the jobs publish to and none of them works, in registry order, each once. */
  published: readonly string[]
  /** Stops the workers, lets handlers in flight finish within `timeoutMs`, and closes the pool. Idempotent. */
  stop: (timeoutMs?: number) => Promise<void>
}

/** How long stop() lets a handler in flight finish before it is failed and the pool closed. */
export const STOP_TIMEOUT_MS = 10_000

export function createBoss({ url, max = 3, log = (line) => console.error(line), cronMonitorIntervalSeconds: cronMonitor, cronWorkerIntervalSeconds: cronWorker, monitorIntervalSeconds, pollingIntervalSeconds }: BossOptions): PgBoss {
  // PROTOTYPE (#134): pg-boss's defaults are 30 (cron pass), 5 (cron worker) and 5 (flow poll).
  const cronMonitorIntervalSeconds = cronMonitor ?? raised(30, pollingIntervalSeconds, 45)
  const cronWorkerIntervalSeconds = cronWorker ?? raised(5, pollingIntervalSeconds, 45)
  const flowIntervalSeconds = raised(5, pollingIntervalSeconds)
  // PROTOTYPE (#134, gate 2): pg-boss's supervise pass (maintenance deletes, the monitor) and its queue-cache refresh, both 60 s by default, from the environment; off when unset.
  const envSeconds = (name: string) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : undefined)
  const superviseIntervalSeconds = envSeconds("WORKER_SUPERVISE_INTERVAL_SECONDS")
  const queueCacheIntervalSeconds = envSeconds("WORKER_QUEUE_CACHE_INTERVAL_SECONDS")
  // PROTOTYPE (#134, gate 2): node-postgres's pool closes a connection idle for 10 s, so at a 30 s poll every poll reopens one — a TLS handshake and a startup through the pooler each time. pg-boss hands its whole config to `new pg.Pool`, so the pool's idle timeout comes from the environment; pg-pool's 10 s when unset.
  const bossIdleSeconds = envSeconds("WORKER_BOSS_IDLE_TIMEOUT_SECONDS")
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
    ...(cronMonitorIntervalSeconds === undefined ? {} : { cronMonitorIntervalSeconds }),
    ...(cronWorkerIntervalSeconds === undefined ? {} : { cronWorkerIntervalSeconds }),
    ...(monitorIntervalSeconds === undefined ? (superviseIntervalSeconds === undefined ? {} : { monitorIntervalSeconds: superviseIntervalSeconds }) : { monitorIntervalSeconds }),
    ...(flowIntervalSeconds === undefined ? {} : { flowIntervalSeconds }),
    ...(superviseIntervalSeconds === undefined ? {} : { superviseIntervalSeconds }),
    ...(queueCacheIntervalSeconds === undefined ? {} : { queueCacheIntervalSeconds }),
    ...(bossIdleSeconds === undefined ? {} : { idleTimeoutMillis: bossIdleSeconds * 1000 }),
  })
  // An `error` with no listener would throw out of pg-boss's event emitter and end the process; a connection dropped mid-poll is one such error, and pg-boss reconnects on the next poll.
  boss.on("error", (error) => log(`pg-boss: ${error instanceof Error ? error.message : String(error)}`))
  boss.on("warning", (warning) => log(`pg-boss warning: ${JSON.stringify(warning)}`))
  return boss
}

/**
 * Starts pg-boss and registers every job: the queues the jobs publish to
 * created or brought to their options first, then, per job, the queue
 * created or brought to the job's options, the worker with the job's handler
 * over the context, and the schedule set or removed. The registry test has
 * already held the list to unique queues and valid cron expressions, so what
 * fails here is the database: the schema missing or at another version
 * (`start()` says which), or the role unable to reach it.
 */
export async function startBoss(boss: PgBoss, jobs: readonly AnyJob[], context: JobContext, { pollingIntervalSeconds }: { pollingIntervalSeconds?: number } = {}): Promise<Boss> {
  await boss.start()
  const bring = async (queue: string, options: JobQueueOptions | undefined) => {
    await boss.createQueue(queue, options)
    if (options) {
      const updatable = updatableOptions(options)
      if (Object.keys(updatable).length > 0) await boss.updateQueue(queue, updatable)
    }
  }
  const published: string[] = []
  for (const job of jobs) {
    for (const target of job.publishes ?? []) {
      await bring(target.queue, target.queueOptions)
      if (!published.includes(target.queue)) published.push(target.queue)
    }
  }
  const queues: string[] = []
  for (const job of jobs) {
    await bring(job.queue, job.queueOptions)
    // PROTOTYPE (#134): every queue's poll raised to the knob; pg-boss's own default is 2 s, the relay's 1 s.
    const polling = raised(job.workOptions?.pollingIntervalSeconds ?? 2, pollingIntervalSeconds)
    await boss.work(job.queue, { ...job.workOptions, ...(polling === undefined ? {} : { pollingIntervalSeconds: polling }) }, (batch) => job.handler(batch, context))
    if (job.schedule !== undefined) {
      await boss.schedule(job.queue, job.schedule, job.scheduleData ?? null, job.scheduleOptions)
    } else {
      await boss.unschedule(job.queue)
    }
    queues.push(job.queue)
  }
  let stopping: Promise<void> | undefined
  return {
    boss,
    queues,
    published,
    stop: (timeoutMs = STOP_TIMEOUT_MS) => (stopping ??= boss.stop({ graceful: true, timeout: timeoutMs, close: true })),
  }
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
