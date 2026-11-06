// What the API, the worker and the Pilot's supervisor agree on as processes.
// No import: the supervisor is the third process in a 256 MiB container and
// its bundle takes this module and nothing else of the package.

/** The API's port unless PORT says otherwise; the Pilot's container exposes it. */
export const API_PORT = 3001
/** The worker's probes' port unless PORT says otherwise, one above the API's; on the Pilot, loopback inside the container. */
export const WORKER_PORT = 3002

/** Supabase's transaction pooler: one backend per statement, no session state, so nothing that holds a lock or a `search_path` on its connection may run there. */
export const TRANSACTION_POOLER_PORT = "6543"

export type Environment = Readonly<Record<string, string | undefined>>

/** Set-but-empty is how a shell, or a placeholder line in .env, says "not set". */
export const withoutEmpty = (source: Environment): Record<string, string> =>
  Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ""))

// The shutdown budget. On SIGTERM each process lets its work finish within
// these ceilings, and the supervisor waits for a child longer than any of
// them can take before it kills it.

/** How long a listener's close() waits for requests in flight before cutting their connections. */
export const SHUTDOWN_GRACE_MS = 5_000
/** How long a pool's end waits for its queries before closing their connections. */
export const POOL_END_MS = 5_000
/** How long the worker's pg-boss stop lets a job in flight finish before failing it. */
export const JOB_STOP_MS = 10_000
/** How long the supervisor waits for a child after forwarding the signal before it kills it: every ceiling above in turn, more than either child's shutdown takes. */
export const KILL_AFTER_MS = JOB_STOP_MS + POOL_END_MS + SHUTDOWN_GRACE_MS
