// The process environment, read once at startup and never again. Four
// variables the process needs: where to listen for the host's probes, and
// the two database URLs — the worker role's, which pg-boss runs on and the
// sweeps read through, and the API role's, which every job's writes run
// fenced on. Then the knobs (#149): the sizes of the two pools and the
// intervals the Pilot runs at, each absent unless set, and absent meaning
// the code's own defaults — no Pilot value is a default here; the Pilot's
// are its host's environment (apps/pilot/README.md). Every value arrives as
// a string, so the schemas do the reading. An empty variable counts as not
// set, applied once in parseEnv for every variable, so a new field is a
// plain schema with a default, or without one when the process cannot run
// without it. Anything else in the environment is dropped, not carried
// around.
import * as z from "zod"

/** The address to bind the probes to. Loopback by default; a container sets `0.0.0.0`. */
const Host = z
  .string()
  .regex(/^[A-Za-z0-9._:-]+$/, {
    error: "must be an IP address or a host name: no spaces, brackets, scheme or IPv6 zone id",
  })
  .default("127.0.0.1")

/** A TCP port from a string of decimal digits, 1..65535. 3002: the API has 3001. */
const Port = z
  .string()
  .regex(/^\d+$/, { error: "must be a whole number" })
  .transform(Number)
  .pipe(z.int().min(1).max(65535))
  .default(3002)

/** Supabase's transaction pooler: one backend per statement, no session state; what pg-boss cannot run on (see the header of boss.ts). */
export const TRANSACTION_POOLER_PORT = "6543"

function isPostgresUrl(value: string): boolean {
  if (!/^postgres(ql)?:\/\//.test(value)) return false
  try {
    return new URL(value).hostname !== ""
  } catch {
    return false
  }
}

const isSessionUrl = (value: string): boolean => {
  try {
    return new URL(value).port !== TRANSACTION_POOLER_PORT
  } catch {
    // Not a URL at all: the shape refine above has already named the variable.
    return true
  }
}

/**
 * The database as the worker role `wms_worker` (see .env.example at the
 * repository root; through Supabase's pooler the user is
 * `wms_worker.<project-ref>`). pg-boss runs on it — its polling, its
 * schedules, its maintenance — and the cross-tenant sweeps read through it.
 * No default: a process without a database is not the worker, so it refuses
 * to start rather than answer 503 forever. The transaction pooler is refused
 * by its port, as the migrator refuses it: pg-boss's session state, its
 * advisory locks and the `search_path` the client sends need one backend for
 * the connection, and the pooler forwards none of them in transaction mode.
 * Whether the database answers is /readyz's question, asked on every probe.
 */
const WorkerDatabaseUrl = z
  .string()
  .refine(isPostgresUrl, { error: "must be a postgresql:// URL with a host, the worker role's connection string" })
  .refine(isSessionUrl, { error: `port ${TRANSACTION_POOLER_PORT} is the transaction pooler; pg-boss needs a session (the direct connection or the session pooler on port 5432)` })

/**
 * The database as the API role `wms_api`: the pool every job writes on, under
 * `withCompany`, so a job's rows are fenced by the tenant exactly as a
 * request's are (the worker role may write nothing, by grant). The same URL
 * the API reads. Refused on the transaction pooler for the same reason: a
 * job that `send`s its successor inside its own transaction (#97's
 * generation) does so through pg-boss over this pool, and one URL shape for
 * both pools is the rule ADR-0007 states.
 */
const DatabaseUrl = z
  .string()
  .refine(isPostgresUrl, { error: "must be a postgresql:// URL with a host, the API role's connection string" })
  .refine(isSessionUrl, { error: `port ${TRANSACTION_POOLER_PORT} is the transaction pooler; the worker's pools need a session (the direct connection or the session pooler on port 5432)` })

/** A whole number from a string of decimal digits, at least `min`; absent unless set. */
const wholeNumber = (min: number, what: string) =>
  z
    .string()
    .regex(/^\d+$/, { error: `must be a whole number${what}` })
    .transform(Number)
    .pipe(z.int().min(min))
    .optional()

/** A pool's size: one connection or more. */
const PoolMax = wholeNumber(1, " of connections, at least 1")
/** An interval in whole seconds, at least one. */
const Seconds = wholeNumber(1, " of seconds, at least 1")

export const Env = z.object({
  HOST: Host,
  PORT: Port,
  WORKER_DATABASE_URL: WorkerDatabaseUrl,
  DATABASE_URL: DatabaseUrl,
  /** The routing provider's name (#169, #131): unset means the fake; the one validator of the value is `providerFromEnv` (@waste/routing/select), so the refusal has one spelling. */
  ROUTING_PROVIDER: z.string().optional(),
  /** The API role's pool, on which every job writes; postgres.js's 10 unless set. Named for its process, since in the Pilot's container both children read one environment. */
  WORKER_API_POOL_MAX: PoolMax,
  /** The worker role's pool, on which the sweeps read; postgres.js's 10 unless set. pg-boss's own pool stays at 3 (boss.ts). */
  WORKER_POOL_MAX: PoolMax,
  /** How often every queue is polled, in seconds: each queue's poll, the relay's successor delay and pg-boss's cron and flow intervals raised to it, never lowered (boss.ts); pg-boss's and the jobs' own unless set. Never a `schedule` cron: the 03:00 plan-ahead, the monthly billing run and the heartbeat's minute stay. */
  WORKER_POLLING_INTERVAL_SECONDS: Seconds,
  /** pg-boss's supervise pass (maintenance, and the monitor pass that refreshes the counts /readyz reads), in seconds; pg-boss's 60 unless set. */
  WORKER_SUPERVISE_INTERVAL_SECONDS: Seconds,
  /** pg-boss's queue-cache refresh, in seconds; pg-boss's 60 unless set. */
  WORKER_QUEUE_CACHE_INTERVAL_SECONDS: Seconds,
  /** How long pg-boss's pool keeps an idle connection, in seconds, 0 for ever; pg-pool's 10 unless set. At or above the longest interval that uses the pool, or every poll reopens a connection through the pooler (#134, gate 2). */
  WORKER_BOSS_IDLE_TIMEOUT_SECONDS: wholeNumber(0, " of seconds, 0 for never"),
})
export type Env = z.infer<typeof Env>

/** Set-but-empty is how a shell says "not set". */
const withoutEmpty = (source: Readonly<Record<string, string | undefined>>) =>
  Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined && value !== ""))

/** Reads the environment, or throws one error naming every bad variable. */
export function parseEnv(source: Readonly<Record<string, string | undefined>>): Env {
  const result = Env.safeParse(withoutEmpty(source))
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`)
  }
  return result.data
}
