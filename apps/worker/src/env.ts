// The process environment, read once at startup and never again. Four
// variables: where to listen for the host's probes, and the two database
// URLs — the worker role's, which pg-boss runs on and the sweeps read
// through, and the API role's, which every job's writes run fenced on. Every
// value arrives as a string, so the schemas do the reading. An empty variable
// counts as not set, applied once in parseEnv for every variable, so a new
// field is a plain schema with a default, or without one when the process
// cannot run without it. Anything else in the environment is dropped, not
// carried around.
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

export const Env = z.object({
  HOST: Host,
  PORT: Port,
  WORKER_DATABASE_URL: WorkerDatabaseUrl,
  DATABASE_URL: DatabaseUrl,
  /** The routing provider's name (#169, #131): unset means the fake; the one validator of the value is `providerFromEnv` (@waste/routing/select), so the refusal has one spelling. */
  ROUTING_PROVIDER: z.string().optional(),
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
