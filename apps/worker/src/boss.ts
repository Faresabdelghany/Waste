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
//
// The Pilot's knobs (#149, measured in #134) reach pg-boss here and nowhere
// else. `pollingIntervalSeconds` raises every interval that polls the
// database more often than it — each queue's poll (`workOptionsUnder`), and
// pg-boss's cron pass, cron worker and flow poll — never lowers one, and
// stops where pg-boss caps one (45 s for the two cron intervals); the
// schedules themselves are untouched. The supervise and queue-cache knobs are
// pg-boss's own intervals passed through, the supervise knob also setting the
// monitor pass unless a caller names it. The idle-timeout knob is pg-pool's,
// which pg-boss hands its whole configuration to: pg-pool closes an idle
// connection after 10 s by default, so at a 30 s poll every poll reopened one
// — a TLS handshake and a startup through the pooler each time, most of the
// idle egress gate 2 metered. Absent, every one of them is pg-boss's default.
import { PGBOSS_SCHEMA } from "@waste/db/sql/pgboss"
import { PgBoss, type ConstructorOptions, type WorkOptions } from "pg-boss"

import { updatableOptions, type AnyJob, type JobContext, type JobQueueOptions } from "./jobs/definition"

/** The knobs and the intervals a caller may name, all optional. */
export type BossIntervals = {
  /** How often pg-boss's cron pass runs — reads the clock and sends the occurrences due — in seconds: pg-boss's 30 in production, 1 in a test that waits for a beat. */
  cronMonitorIntervalSeconds?: number
  /** How often the worker that forwards a due occurrence onto its queue polls, in seconds: pg-boss's 5 in production, 1 in a test that waits for a beat. */
  cronWorkerIntervalSeconds?: number
  /** How often the queues' counts (the failed count /readyz reads) are refreshed, in seconds; the supervise knob unless named, pg-boss's 60 without either. */
  monitorIntervalSeconds?: number
  /** WORKER_POLLING_INTERVAL_SECONDS: the floor under every poll. */
  pollingIntervalSeconds?: number
  /** WORKER_SUPERVISE_INTERVAL_SECONDS: pg-boss's supervise pass, and its monitor pass unless named. */
  superviseIntervalSeconds?: number
  /** WORKER_QUEUE_CACHE_INTERVAL_SECONDS: pg-boss's queue-cache refresh. */
  queueCacheIntervalSeconds?: number
  /** WORKER_BOSS_IDLE_TIMEOUT_SECONDS: pg-pool's idle timeout on pg-boss's pool, 0 for never. */
  idleTimeoutSeconds?: number
}

export type BossOptions = BossIntervals & {
  /** The worker role's URL, a session connection; env.ts has refused the transaction pooler. */
  url: string
  /** pg-boss's pool size; three is one for the poll, one for a cron pass and one for maintenance. */
  max?: number
  /** Where pg-boss's own errors and warnings go; console.error unless a test wants to look. */
  log?: (line: string) => void
}

/** pg-boss's own defaults for the intervals the polling knob may raise, and its cap on the two cron ones. */
const PGBOSS = { cronMonitorSeconds: 30, cronWorkerSeconds: 5, flowSeconds: 5, cronCapSeconds: 45, workPollSeconds: 2 }

/** An interval raised to the knob where it polls more often than the knob, never lowered, capped where pg-boss caps it; undefined without the knob. */
const raised = (defaultSeconds: number, knob: number | undefined, cap = Number.POSITIVE_INFINITY): number | undefined =>
  knob === undefined ? undefined : Math.min(Math.max(defaultSeconds, knob), cap)

const named = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> => (value === undefined ? {} : ({ [key]: value } as Record<K, V>))

/** What pg-boss is constructed with for its intervals, and pg-pool's idle timeout, which pg-boss's own types leave out though it hands its whole configuration to `new pg.Pool` (its db.ts). */
export type BossSettings = Pick<ConstructorOptions, "cronMonitorIntervalSeconds" | "cronWorkerIntervalSeconds" | "flowIntervalSeconds" | "superviseIntervalSeconds" | "monitorIntervalSeconds" | "queueCacheIntervalSeconds"> & {
  idleTimeoutMillis?: number
}

/** The interval settings pg-boss is constructed with, from the knobs and the intervals a caller names: nothing where nothing is set. Pure. */
export function bossIntervals({
  cronMonitorIntervalSeconds,
  cronWorkerIntervalSeconds,
  monitorIntervalSeconds,
  pollingIntervalSeconds,
  superviseIntervalSeconds,
  queueCacheIntervalSeconds,
  idleTimeoutSeconds,
}: BossIntervals): BossSettings {
  return {
    ...named("cronMonitorIntervalSeconds", cronMonitorIntervalSeconds ?? raised(PGBOSS.cronMonitorSeconds, pollingIntervalSeconds, PGBOSS.cronCapSeconds)),
    ...named("cronWorkerIntervalSeconds", cronWorkerIntervalSeconds ?? raised(PGBOSS.cronWorkerSeconds, pollingIntervalSeconds, PGBOSS.cronCapSeconds)),
    ...named("flowIntervalSeconds", raised(PGBOSS.flowSeconds, pollingIntervalSeconds)),
    ...named("superviseIntervalSeconds", superviseIntervalSeconds),
    ...named("monitorIntervalSeconds", monitorIntervalSeconds ?? superviseIntervalSeconds),
    ...named("queueCacheIntervalSeconds", queueCacheIntervalSeconds),
    ...named("idleTimeoutMillis", idleTimeoutSeconds === undefined ? undefined : idleTimeoutSeconds * 1000),
  }
}

/** A job's work options under the polling knob: its poll raised to the knob where it polls more often (pg-boss's 2 s where it names none), the rest as the job wrote them. Pure. */
export function workOptionsUnder(options: WorkOptions | undefined, pollingIntervalSeconds: number | undefined): WorkOptions {
  const polling = raised(options?.pollingIntervalSeconds ?? PGBOSS.workPollSeconds, pollingIntervalSeconds)
  return { ...options, ...named("pollingIntervalSeconds", polling) }
}

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

export function createBoss({ url, max = 3, log = (line) => console.error(line), ...intervals }: BossOptions): PgBoss {
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
    ...bossIntervals(intervals),
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
 * (`start()` says which), or the role unable to reach it. Every queue's poll
 * is raised to the context's polling knob (`workOptionsUnder`), so one knob
 * governs every poll this process makes.
 */
export async function startBoss(boss: PgBoss, jobs: readonly AnyJob[], context: JobContext): Promise<Boss> {
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
    await boss.work(job.queue, workOptionsUnder(job.workOptions, context.pollingIntervalSeconds), (batch) => job.handler(batch, context))
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
