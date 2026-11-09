// The process environment, declared with @waste/server/env's pieces: where
// to listen for the host's probes, and the two database URLs — the worker
// role's, which pg-boss runs on and the sweeps read through, and the API
// role's, which every job's writes run fenced on. Then the knobs (#149): the
// sizes of the two pools and the intervals the Pilot runs at, each absent
// unless set, and absent meaning the code's own defaults — no Pilot value is
// a default here; the Pilot's are its host's environment
// (apps/pilot/README.md). The routing provider, its key and the quota
// engine's reserves and pace (#171) are read here too, the reserves and the
// pace absent meaning the Standard plan's own figures (@waste/routing/quota).
// The keys of `Env` are the variables turbo.json hands `@waste/worker#dev`,
// exactly.
import type { Environment } from "@waste/process/environment"
import { WORKER_PORT } from "@waste/process/ports"
import { Host, parseEnvironment, Port, SessionUrl, wholeNumber } from "@waste/server/env"
import * as z from "zod"

/**
 * The database as the worker role `wms_worker` (see .env.example at the
 * repository root; through Supabase's pooler the user is
 * `wms_worker.<project-ref>`). pg-boss runs on it — its polling, its
 * schedules, its maintenance — and the cross-tenant sweeps read through it.
 * The transaction pooler is refused, as the migrator refuses it: pg-boss's
 * session state, its advisory locks and the `search_path` the client sends
 * need one backend for the connection, and the pooler forwards none of them
 * in transaction mode.
 */
const WorkerDatabaseUrl = SessionUrl("the worker role's connection string", "pg-boss needs")

/**
 * The database as the API role `wms_api`: the pool every job writes on, under
 * `withCompany`, so a job's rows are fenced by the tenant exactly as a
 * request's are (the worker role may write nothing, by grant). The same URL
 * the API reads. Refused on the transaction pooler for the same reason: a
 * job that `send`s its successor inside its own transaction (#97's
 * generation) does so through pg-boss over this pool, and one URL shape for
 * both pools is the rule ADR-0007 states.
 */
const DatabaseUrl = SessionUrl("the API role's connection string", "the worker's pools need")

const PoolMax = wholeNumber(1, " of connections, at least 1")
const Seconds = wholeNumber(1, " of seconds, at least 1")

export const Env = z.object({
  HOST: Host,
  PORT: Port(WORKER_PORT),
  WORKER_DATABASE_URL: WorkerDatabaseUrl,
  DATABASE_URL: DatabaseUrl,
  /** The routing provider's name (#169, #131): unset means the fake; the one validator of the value is `providerFromEnv` (@waste/routing/select), so the refusal has one spelling. */
  ROUTING_PROVIDER: z.string().optional(),
  /** The messaging provider's name (#291 C15): unset or `log` means the log-only sender, which sends nothing; the one validator is `messagingProviderFromEnv` (messaging/select.ts). */
  MESSAGING_PROVIDER: z.string().optional(),
  /** The API role's pool, on which every job writes; postgres.js's 10 unless set. Named for its process, since in the Pilot's container both children read one environment. */
  WORKER_API_POOL_MAX: PoolMax,
  /** The worker role's pool, on which the sweeps read; postgres.js's 10 unless set. pg-boss's own pool stays at 3 (runtime/boss.ts). */
  WORKER_POOL_MAX: PoolMax,
  /** How often every queue is polled, in seconds: each queue's poll, the relay's successor delay and pg-boss's cron and flow intervals raised to it, never lowered (runtime/boss.ts); pg-boss's and the jobs' own unless set. Never a `schedule` cron: the 03:00 plan-ahead, the monthly billing run and the heartbeat's minute stay. */
  WORKER_POLLING_INTERVAL_SECONDS: Seconds,
  /** pg-boss's supervise pass (maintenance, and the monitor pass that refreshes the counts /readyz reads), in seconds; pg-boss's 60 unless set. */
  WORKER_SUPERVISE_INTERVAL_SECONDS: Seconds,
  /** pg-boss's queue-cache refresh, in seconds; pg-boss's 60 unless set. */
  WORKER_QUEUE_CACHE_INTERVAL_SECONDS: Seconds,
  /** How long pg-boss's pool keeps an idle connection, in seconds, 0 for ever; pg-pool's 10 unless set. At or above the longest interval that uses the pool, or every poll reopens a connection through the pooler (#134, gate 2). */
  WORKER_BOSS_IDLE_TIMEOUT_SECONDS: wholeNumber(0, " of seconds, 0 for never"),
  /** OpenRouteService's key (#171), when ROUTING_PROVIDER names it: one person's, server-side only, never logged; `providerFromEnv` refuses the provider without it. */
  OPENROUTESERVICE_API_KEY: z.string().optional(),
  /** The Supabase project's URL and its service-role key (O1 of #290): the purge removes old photos and signatures from Storage with them, server-side only, never logged. Both, or the purge removes nothing. */
  SUPABASE_URL: z.url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  /** How many days a photo or a signature is kept before the nightly purge removes it, unless an open ticket names its stop; a Pilot setting (apps/pilot/README.md), unset means no purge. */
  PROOF_RETENTION_DAYS: wholeNumber(1, " of days, at least 1"),
  /** Where batch routing work stops, per family (#132 §1): the remaining it leaves for the office's own calls; the Standard plan's 500 directions and 100 optimisations unless set. */
  ROUTING_DIRECTIONS_RESERVE: wholeNumber(0, " of requests"),
  ROUTING_OPTIMISATION_RESERVE: wholeNumber(0, " of requests"),
  /** How many calls a minute each routing family makes, under the provider's own limit; the Standard plan's 30 (under its 40) unless set. */
  ROUTING_CALLS_PER_MINUTE: wholeNumber(1, " of calls a minute, at least 1"),
})
export type Env = z.infer<typeof Env>

/** Reads the environment, or throws one error naming every bad variable. */
export const parseEnv = (source: Environment): Env => parseEnvironment(Env, source)
