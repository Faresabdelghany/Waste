// The readiness probe's two checks. `database`: does the API role's pool
// answer? Every job writes on it under `withCompany`, so a worker whose
// `DATABASE_URL` is wrong would fail every job while pg-boss hums along;
// `select 1` through the pool, bounded, the same probe the API runs (its
// `apps/api/src/readiness.ts` says at length why a probe the bound overtook
// is left to settle and never cancelled, and why it gets a pool of its own:
// one connection, a dial that gives up with the bound, a short fixed backoff;
// the same holds here). `boss`: is pg-boss started, and does its own
// connection answer a read of the registered queues within the bound? That
// read is also where the count of failed jobs comes from — the `failedCount`
// pg-boss keeps per queue, a rolling count of failures still retained under
// the queue's retention and not an all-time total, refreshed by pg-boss's own
// monitor pass once a supervise interval (a minute), so the number is up to a
// minute old and a probe costs one indexed read and never an aggregate over
// the job table — so a ready body carries it and an operator, or an alert,
// reads it off the probe. Three answers for
// the boss and no fourth: "ok", "stopped" (never started, or shut down: the
// process is starting up or going down, and nothing about the database is
// known) and "unreachable" (started, and the read did not answer). The
// contracts type (`WorkerReadinessResponse`) spells the same words on the wire.
// A third read rides beside the two checks and decides nothing: the relay's
// `staleOutboxCount` (jobs/relay-outbox.ts), the rows unpublished for longer
// than an hour across companies, handed in by the composition root and
// bounded like the checks; a ready body carries the number, and a count that
// did not answer in time is left out rather than made a 503, since an event
// nobody could publish is still an event and the probe is not the place to
// decide about it. A fourth rides on the boss check itself: `deadLetters`,
// the jobs waiting on `outbox.dead` (the consumers' dead-letter queue,
// outbox/subscribe.ts) — pg-boss's cached `queuedCount` on that queue's row,
// read in the same `getQueues` as the failed count when the queue is among
// the ones asked for — a job that failed past its retries and waits for an
// operator's redrive; information for the operator, never a reason for a 503.
import type { ClientOptions, Database } from "@waste/db/client"
import type { PgBoss } from "pg-boss"

/** How long a probe waits for its answer: under every common balancer's probe timeout, as the API's. */
export const CHECK_TIMEOUT_MS = 2_000

export type DatabaseCheck = "ok" | "unreachable"
export type BossCheck = { boss: "ok"; failedJobs: number; deadLetters?: number } | { boss: "stopped" } | { boss: "unreachable" }

export type CheckOptions = {
  timeoutMs?: number
}

/** The pool a probe runs on: one connection, a dial that gives up with the bound, a short fixed backoff. */
export function probePoolOptions(timeoutMs = CHECK_TIMEOUT_MS): ClientOptions {
  return { max: 1, connectTimeoutSeconds: timeoutMs / 1_000, backoffSeconds: 1 }
}

/** Races a probe against the bound; the probe's own failure is the second answer, the bound the third. */
async function bounded<T>(probe: Promise<T>, failed: T, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<T>((resolve) => {
    timer = setTimeout(resolve, timeoutMs, failed)
  })
  try {
    return await Promise.race([probe.then((value) => value, () => failed), bound])
  } finally {
    clearTimeout(timer)
  }
}

/** The stale count, bounded: the number, or undefined where the read failed or the bound overtook it, so a ready body carries nothing rather than a guess. */
export async function countStale(count: () => Promise<number>, { timeoutMs = CHECK_TIMEOUT_MS }: CheckOptions = {}): Promise<number | undefined> {
  return bounded<number | undefined>(
    Promise.resolve().then(() => count()),
    undefined,
    timeoutMs,
  )
}

export async function checkDatabase(sql: Database["sql"], { timeoutMs = CHECK_TIMEOUT_MS }: CheckOptions = {}): Promise<DatabaseCheck> {
  // A postgres.js query runs when first awaited (or `.then`'d): here, inside the race, with the timer already armed.
  return bounded(
    Promise.resolve().then(() => sql`select 1`.then(() => "ok" as const)),
    "unreachable",
    timeoutMs,
  )
}

/** What the boss probe reads: the instance, the queues the registry put on it, whether the process has it started right now, and, where the worker has one, the dead-letter queue whose waiting jobs a ready body carries as `deadLetters`. */
export type BossProbe = {
  boss: Pick<PgBoss, "getQueues">
  queues: readonly string[]
  isStarted: () => boolean
  /** The consumers' dead-letter queue (`outbox.dead`); its waiting count rides on the ready body when named, nothing rides when not. */
  deadLetterQueue?: string
}

export async function checkBoss({ boss, queues, isStarted, deadLetterQueue }: BossProbe, { timeoutMs = CHECK_TIMEOUT_MS }: CheckOptions = {}): Promise<BossCheck> {
  if (!isStarted()) return { boss: "stopped" }
  return bounded<BossCheck>(
    Promise.resolve().then(async () => {
      // One read: the registered queues and, where named, the dead-letter queue beside them (once, should a job ever list it among its own).
      const asked = deadLetterQueue === undefined || queues.includes(deadLetterQueue) ? [...queues] : [...queues, deadLetterQueue]
      const rows = await boss.getQueues(asked)
      const failedJobs = rows.filter((queue) => queues.includes(queue.name)).reduce((count, queue) => count + queue.failedCount, 0)
      const dead = deadLetterQueue === undefined ? undefined : rows.find((queue) => queue.name === deadLetterQueue)
      // A dead-letter queue named and not there yet (a first start before the relay published it) carries nothing rather than a zero it cannot vouch for.
      return dead === undefined ? { boss: "ok", failedJobs } : { boss: "ok", failedJobs, deadLetters: dead.queuedCount }
    }),
    { boss: "unreachable" },
    timeoutMs,
  )
}
