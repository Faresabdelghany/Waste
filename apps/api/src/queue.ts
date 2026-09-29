// The API's one door to the worker's queues (Issue #97 part B, #128): a job
// sent inside the request's transaction, so it commits or rolls back with the
// rows that asked for it. The office's generation button is the first route
// that needs one — it writes a `generation_run` and sends
// `planning.generate-routes` for it, and a run without its job, or a job
// without its run, is not a state the database can be left in — which is why
// the send rides the request's `tx` and not a pool of its own: pg-boss's
// `send` takes a `{ db }` adapter, and `fromDrizzle(tx, sql)`, pg-boss's own
// (the worker's `inTransaction`, apps/worker/src/jobs/transaction.ts), binds
// its statements onto the transaction. The API runs no worker, no cron and no
// maintenance: it is a sender only.
//
// pg-boss answers a `send` only from an instance that has started, and a
// start reads the schema's version and the queues, so that a send knows the
// queue's table and policy. Those reads run on the transaction too: one
// instance per send, over the request's `tx`, stopped before the answer and
// never kept across requests, since its adapter is bound to one transaction.
// That is four small statements before the insert, and #128 accepts a minute
// from the click to the run started, not a millisecond. The queue must exist:
// the worker creates every queue of its registry when it starts
// (apps/worker/src/boss.ts), and a send to one that does not is pg-boss's
// "Queue … does not exist", a 500 — the worker has never started against this
// database.
//
// The role: `wms_api` holds `USAGE` on `pgboss` and the rights on its tables
// that migration 0011 granted it (packages/db's `sql/pgboss.ts`). A send needs
// `SELECT` on `pgboss.version` and `pgboss.queue` and `INSERT` with
// `SELECT (id)` on `pgboss.job_common`, the partition its insert lands in and
// returns the id from; the narrowing 0011 owes a later file
// (packages/db/migrations/README.md) keeps those.
import type { Tx } from "@waste/db/client"
import { PGBOSS_SCHEMA } from "@waste/db/sql/pgboss"
import { sql } from "drizzle-orm"
import { fromDrizzle, PgBoss, type SendOptions } from "pg-boss"

/**
 * Sends a job for `queue` carrying `data` inside `tx`: pg-boss's id, or null
 * when the queue's policy kept it out (an `exclusive` queue already holding a
 * job of the same `singletonKey`). The instance is started with nothing of its
 * own to run and stopped without touching the transaction it borrowed.
 */
export async function sendInTransaction(tx: Tx, queue: string, data: object, options: Omit<SendOptions, "db"> = {}): Promise<string | null> {
  const boss = new PgBoss({ db: fromDrizzle(tx, sql), schema: PGBOSS_SCHEMA, migrate: false, supervise: false, schedule: false })
  // Only pg-boss's own timers emit `error`, and an emitter with no listener
  // throws it out of the timer and takes the process down; a sender's timers
  // are cleared before they fire, and a failed send is thrown to the route.
  boss.on("error", () => undefined)
  try {
    await boss.start()
    return await boss.send(queue, data, options)
  } finally {
    // After a start that threw part-way too: stop clears whatever timers it had set.
    await boss.stop({ graceful: false, close: false })
  }
}
