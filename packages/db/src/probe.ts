// The readiness probe's database check: does the database answer? `select 1`
// through a pool, bounded, so the probe answers in time whatever the database
// does: a refused dial rejects at once, a dial or a query that hangs is
// overtaken by the timer. Two answers and no third, "ok" or "unreachable";
// why it was unreachable is not the probe's to say, a balancer reads the
// status and an operator reads the database's own logs. The contracts types
// (ReadinessResponse, WorkerReadinessResponse) spell the same two words on
// the wire.
//
// A probe the bound overtook is left to settle on its own, never cancelled.
// postgres.js's cancel is unsafe here in both of its paths: cancelling a query
// that is still a connection's startup query rejects the query but leaves the
// connection stranded in its connecting queue until its lifetime ends, one
// pool connection lost per slow start; and cancelling a query already sent
// dials a second connection to carry the cancel request and drops that
// dial's promise, so when the database that stalled also refuses the cancel
// dial, the rejection is unhandled and Node exits, the process a 503 was
// supposed to keep alive. The late settlement costs nothing: the bound
// absorbs it.
//
// Because hung probes therefore run their course, they get a pool of their
// own (probePoolOptions, which each composition root hands to createDb): one
// connection, so probes never take a request's or a job's connection and a
// stack of them is a queue behind one dial; a connect timeout equal to the
// bound, so a hung dial ends with the probe rather than after postgres.js's
// 30 s; and a fixed one-second wait before the next dial after a failure, so
// a database that comes back is seen within a second, where postgres.js's own
// backoff would grow towards 20 s over an outage. Readiness is then about the
// database as seen from this process now, not about another pool's mood.
import { bounded, CHECK_TIMEOUT_MS, type CheckOptions } from "@waste/process/readiness"

import type { ClientOptions, Database } from "./client"

export type DatabaseCheck = "ok" | "unreachable"

/** The pool a probe runs on: one connection, a dial that gives up with the bound, a short fixed backoff. */
export function probePoolOptions(timeoutMs = CHECK_TIMEOUT_MS): ClientOptions {
  return { max: 1, connectTimeoutSeconds: timeoutMs / 1_000, backoffSeconds: 1 }
}

export async function checkDatabase(sql: Database["sql"], { timeoutMs = CHECK_TIMEOUT_MS }: CheckOptions = {}): Promise<DatabaseCheck> {
  // A postgres.js query runs when first awaited (or `.then`'d): here, inside the race, with the timer already armed.
  return bounded(
    Promise.resolve().then(() => sql`select 1`.then(() => "ok" as const)),
    "unreachable",
    timeoutMs,
  )
}
