// The readiness probe's one check: does the database answer? `select 1`
// through the pool, so the answer covers the network, the credentials and a
// free connection, bounded so the probe answers in time whatever the database
// does. A refused connection rejects at once; a connection that hangs (a
// database mid-restart, a pooler that accepts and stalls) would otherwise sit
// in postgres.js's connect timeout (30 s) far past any balancer's patience.
// When the bound passes the probe is cancelled, not abandoned: a queued query
// is dropped from the pool's queue and a sent one is cancelled server-side,
// so a database that stays down does not accumulate one pending probe per
// check interval until the pool is full of them.
//
// Two answers and no third: "ok" or "unreachable". Why it was unreachable is
// not the probe's to say; a balancer reads the status and an operator reads
// the database's own logs. The contracts type (ReadinessResponse) spells the
// same two words on the wire.
import type { Database } from "@waste/db/client"

/**
 * How long the probe waits for the database. Two seconds is under the check
 * interval and timeout of every common balancer and orchestrator default
 * (Kubernetes probes 1 s timeout at 10 s intervals as shipped, most balancers
 * 5 s), so an instance is judged on this answer, not on a probe that timed
 * out on the caller's side.
 */
export const DATABASE_CHECK_TIMEOUT_MS = 2_000

export type DatabaseCheck = "ok" | "unreachable"

export type CheckOptions = {
  timeoutMs?: number
}

export async function checkDatabase(sql: Database["sql"], { timeoutMs = DATABASE_CHECK_TIMEOUT_MS }: CheckOptions = {}): Promise<DatabaseCheck> {
  // A postgres.js query runs when first awaited (or `.then`'d), so the probe
  // starts below, inside the race, and not before the timer is armed.
  const probe = sql`select 1`
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<DatabaseCheck>((resolve) => {
    timer = setTimeout(() => {
      probe.cancel()
      resolve("unreachable")
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      probe.then(
        () => "ok" as const,
        () => "unreachable" as const,
      ),
      bound,
    ])
  } finally {
    clearTimeout(timer)
  }
}
