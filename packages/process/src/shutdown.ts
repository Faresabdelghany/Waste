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
