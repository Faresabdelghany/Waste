// The outbox relay (Issue #104 part C, §6): the job that moves what the API
// wrote into `outbox_event` onto pg-boss's queues for the consumers, and
// stamps each row published in the same transaction as the send, so an event
// is published exactly once or not yet — never twice, never stamped and lost.
//
// One tick is one sweep and then one transaction per company. The sweep is
// the second cross-tenant statement in the system after #97's plan-ahead and
// the reason `wms_worker` has BYPASSRLS: the unpublished rows in id order,
// capped per company — `select id, company_id from (select id, company_id,
// row_number() over (partition by company_id order by id) as rank from
// outbox_event where published_at is null) ranked where rank <= 100 order by
// company_id, id` on the worker role's pool, over the partial index
// `outbox_event_id_idx` (the one index without the tenant, made for this
// read). The cap is per company and not across them on purpose: a company
// whose transaction fails every tick — a queue for a kind this worker does
// not know yet, mid-deploy, or any error of its own — keeps its unpublished
// rows, and under a cap across companies its backlog, once a hundred rows
// deep, would be the whole of every sweep and no other company's event would
// ever be published again; partitioned, each company's oldest hundred are
// swept whatever the others hold, and the failing one starves only itself.
// It takes no lock — a role with no write right holds no row lock worth
// having, and a sweep that locked would hold nothing past its own statement
// anyway. The lock is taken where the write is: for each company of the
// sweep, `withCompany(api.db, companyId, …)` opens the fenced transaction as
// `wms_api`, re-reads the company's rows among the swept ids that are still
// unpublished with `for update skip locked`, in id order, stamps
// `published_at = now()` on exactly those rows in one statement whose
// `returning` is the instant the payload then carries, and sends each to
// `outbox.<kind>` (outbox/subscribe.ts spells the queue and the payload) with
// pg-boss's `send` on that same transaction — `{ db: fromDrizzle(tx, sql) }`,
// pg-boss's own adapter over a Drizzle transaction.
// Stamp and sends commit together or roll back together, which is the
// whole point of an outbox; and a second relay running at the same moment
// (two workers, a deploy overlapping the old process, a test) skips the rows
// the first has locked and takes the rest, so neither publishes a row twice
// and neither waits. A row the first relay is still holding is left for the
// next tick, which is where `skip locked` keeps the promise "exactly once" and
// not merely "at least once".
//
// The stamp is written as `wms_api` under `withCompany`, not as `wms_worker`
// and not by a grant: the skeleton's rule is that the worker role writes
// nothing (a write as it is 42501, packages/db's worker.test.ts) and every
// write runs fenced by the tenant, and the relay is the first job to show that
// rule working — the sweep sees every company, the write sees one. A grant of
// `UPDATE (published_at)` to `wms_worker` would have been narrower on paper
// and a migration with no number reserved for it, and would have made the
// relay the one writer in the system outside the fence.
//
// One door for a consumer, one spelling, `outbox.<kind>`, written in the
// row's transaction: a job `send` to the queue of that name. The relay owns
// these queues (`publishes: [OUTBOX_DEAD, ...OUTBOX_QUEUES]` has the wiring
// create the dead-letter queue and then one queue per kind of the vocabulary
// before any worker starts; the dead-letter queue first, since a consumer's
// queue names it and pg-boss refuses a `deadLetter` that does not exist), so
// a job waits there under pg-boss's retention for whoever works it, and a
// consumer is one entry per kind in the registry through
// `defineOutboxConsumer`, working the queue. The relay does not `publish` as
// well: pg-boss's fan-out delivers only to the queues subscribed at publish
// time, so an event relayed before a consumer's first start would reach no
// subscriber, where the kind's queue keeps it — and a second door would hand
// a consumer that took both every event twice. Which kinds exist is the
// domain's `OUTBOX_KINDS`; a kind added there is a queue here with nothing
// else to change. `outbox.dead` is where a consumer's job goes when it has
// failed past its retries (outbox/subscribe.ts says how and how it comes
// back); the relay itself never sends there.
//
// The tick. pg-boss's schedule is minute-granular (its cron pass runs once a
// minute and a six-field expression is refused by the registry, boss.ts), and
// the issue asked for seconds; so the relay is scheduled every minute as the
// backstop and each tick, once its batch is done, sends its own successor
// with `startAfter: RELAY_INTERVAL_SECONDS` (5) through the context's `send`,
// which is how a five-second cadence lives on a one-minute cron. The queue's
// policy is `short` — one job queued at a time — so the successor and the
// schedule's occurrence collapse into one row instead of two chains
// racing, and a relay that fell over (a failed handler sends no successor) is
// picked up by the schedule within the minute; `missed: "skip"` keeps a
// worker down for an hour from ticking sixty times when it is back. A tick
// that found a batch's worth (BATCH_SIZE rows or more across companies: some
// company may be at its cap) sends its successor at once, so a backlog drains
// at the pace of the database and not five seconds a hundred.
// The successor is sent after the batch and outside its transactions: a
// double tick is harmless (an empty sweep, or `skip locked`), a lost one is
// the schedule's to replace.
//
// What fails, and how. A send that throws (a queue missing, the connection
// gone) rolls back that company's transaction: no row of the company is
// stamped, the rows of the other companies of the tick are published in their
// own transactions before or after, the handler throws once every company
// has been tried so the tick is a failed job the readiness count sees, and
// the next tick takes the unpublished rows again. A row with `published_at`
// null for longer than `OUTBOX_STALE_MS` (an hour) is a poison event or a
// relay that has not run; `staleOutboxCount(worker)` counts them for whoever
// asks (the probe, #97 B's docs slice), and the count is information and not
// a failure, since an event nobody could publish is still an event.
//
// The payload on the wire is `RelayedEvent` (outbox/subscribe.ts): the
// contracts' `OutboxEvent` as the API would answer the row — instants as ISO
// strings, `publishedAt` the instant this transaction stamps — plus
// `companyId`, since a consumer opens its own writes with `withCompany` and no
// request carries the claim for it. Which the consumer parses with the
// contracts, so a drift between the row and the wire fails there and loudly.
import { OutboxAggregate, OutboxKind } from "@waste/contracts/execution"
import type { Database, Tx } from "@waste/db/client"
import { outboxEvent } from "@waste/db/schema/execution"
import { withCompany } from "@waste/db/tenant"
import { and, asc, eq, inArray, isNull, lt, lte, sql } from "drizzle-orm"
import { fromDrizzle, type SendOptions } from "pg-boss"

import { OUTBOX_DEAD, OUTBOX_QUEUES, outboxQueue, type RelayedEvent } from "../outbox/subscribe"
import { defineJob, type JobContext } from "./definition"

/** The relay's own queue. */
export const RELAY_QUEUE = "execution.relay-outbox"
/** How many unpublished rows one tick takes of each company, oldest first: the cap is per company, so one company's backlog never crowds another's rows out of the sweep. */
export const BATCH_SIZE = 100
/** How long a tick waits before its successor when the sweep came back short; the cadence the issue asked for. */
export const RELAY_INTERVAL_SECONDS = 5
/** After this long unpublished, a row is stale: a poison event, or a relay that has not run. An hour. */
export const OUTBOX_STALE_MS = 60 * 60 * 1_000

export type RelayOutboxData = {
  /** Where the tick came from: the minute's schedule, the previous tick, or a caller who sent one by hand. */
  source: "schedule" | "successor" | "manual"
}

/** What one tick did, the job's output: how many unpublished rows the sweep found (at most `BATCH_SIZE` of each company), and how many it published and stamped, across companies. A tick that failed for any company has no output; it throws, and the readiness count sees it. */
export type RelayOutcome = {
  swept: number
  published: number
}

/** The stamped row as a queue carries it: `RelayedEvent`, the contracts' `OutboxEvent` with the tenant. */
function toRelayed(row: typeof outboxEvent.$inferSelect, stamp: { publishedAt: Date; updatedAt: Date }): RelayedEvent {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    kind: OutboxKind.parse(row.kind),
    aggregateKind: OutboxAggregate.parse(row.aggregateKind),
    aggregateId: row.aggregateId,
    occurredAt: row.occurredAt.toISOString(),
    // The column is jsonb, read back as the JSON the API wrote; the consumer parses it with its kind's schema.
    payload: row.payload as RelayedEvent["payload"],
    publishedAt: stamp.publishedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: stamp.updatedAt.toISOString(),
  }
}

/** How `send` enqueues on the transaction the stamp runs in: pg-boss's adapter over the Drizzle transaction. */
const onTransaction = (tx: Tx): SendOptions => ({ db: fromDrizzle(tx, sql) })

/**
 * One company's part of a tick, in its fenced transaction: the swept rows
 * still unpublished and not held by another relay, locked in id order; then
 * stamped `published_at = now()` in one statement whose `returning` is the
 * instant the payload carries; then each sent to its kind's queue, in id
 * order, on this same transaction. Stamp and sends commit together or not at
 * all. Answers how many.
 */
export async function relayCompany(context: Pick<JobContext, "api" | "send">, companyId: string, ids: readonly string[]): Promise<number> {
  return withCompany(context.api.db, companyId, async (tx) => {
    const rows = await tx
      .select()
      .from(outboxEvent)
      .where(and(eq(outboxEvent.companyId, companyId), inArray(outboxEvent.id, [...ids]), isNull(outboxEvent.publishedAt)))
      .orderBy(asc(outboxEvent.id))
      .for("update", { skipLocked: true })
    if (rows.length === 0) return 0
    const stamped = await tx
      .update(outboxEvent)
      .set({ publishedAt: sql`now()` })
      .where(
        and(
          eq(outboxEvent.companyId, companyId),
          inArray(
            outboxEvent.id,
            rows.map((row) => row.id),
          ),
        ),
      )
      .returning({ id: outboxEvent.id, publishedAt: outboxEvent.publishedAt, updatedAt: outboxEvent.updatedAt })
    const stamps = new Map(stamped.map((row) => [row.id, { publishedAt: row.publishedAt!, updatedAt: row.updatedAt }]))
    const options = onTransaction(tx)
    for (const row of rows) {
      const stamp = stamps.get(row.id)
      if (!stamp) throw new Error(`execution.relay-outbox: row ${row.id} was locked and not stamped`)
      const event = toRelayed(row, stamp)
      // One door, one transaction: the job on the kind's own queue, which the consumer of that kind works.
      await context.send(outboxQueue(event.kind), event, options)
    }
    return rows.length
  })
}

/**
 * One tick: the cross-tenant sweep as the worker role, then each company's
 * rows published and stamped as the API role under `withCompany`. The sweep
 * takes each company's oldest `BATCH_SIZE` unpublished rows — a window
 * partitioned by company, so a company with a thousand rows nobody can
 * publish still leaves every other company its turn — in company then id
 * order. A company whose transaction fails is counted, logged and left for
 * the next tick; the others are not held up by it. Throws after every
 * company has been tried when any failed, so the tick is a failed job.
 */
export async function relayOnce(context: Pick<JobContext, "api" | "worker" | "send" | "log">): Promise<RelayOutcome> {
  const ranked = context.worker.db
    .select({
      id: outboxEvent.id,
      companyId: outboxEvent.companyId,
      rank: sql<number>`row_number() over (partition by ${outboxEvent.companyId} order by ${outboxEvent.id})`.as("rank"),
    })
    .from(outboxEvent)
    .where(isNull(outboxEvent.publishedAt))
    .as("ranked")
  const swept = await context.worker.db
    .select({ id: ranked.id, companyId: ranked.companyId })
    .from(ranked)
    .where(lte(ranked.rank, BATCH_SIZE))
    .orderBy(asc(ranked.companyId), asc(ranked.id))
  const byCompany = new Map<string, string[]>()
  for (const row of swept) {
    const ids = byCompany.get(row.companyId)
    if (ids) ids.push(row.id)
    else byCompany.set(row.companyId, [row.id])
  }
  let published = 0
  const failures: { companyId: string; error: unknown }[] = []
  for (const [companyId, ids] of byCompany) {
    try {
      published += await relayCompany(context, companyId, ids)
    } catch (error) {
      failures.push({ companyId, error })
      context.log(`execution.relay-outbox: company ${companyId}: ${ids.length} ${ids.length === 1 ? "row" : "rows"} left unpublished: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(`execution.relay-outbox: ${failures.length} of ${byCompany.size} ${byCompany.size === 1 ? "company" : "companies"} failed to publish; ${published} ${published === 1 ? "row" : "rows"} published`, { cause: failures.map((failure) => failure.error) })
  }
  return { swept: swept.length, published }
}

/**
 * How many rows have waited unpublished longer than `OUTBOX_STALE_MS`: poison
 * events, or a relay that has not run. Read across companies as the worker
 * role; a count for a probe or an operator, never a failure.
 */
export async function staleOutboxCount(worker: Database, now: Date, staleMs = OUTBOX_STALE_MS): Promise<number> {
  const before = new Date(now.getTime() - staleMs)
  const [row] = await worker.db
    .select({ count: sql<number>`count(*)::int` })
    .from(outboxEvent)
    .where(and(isNull(outboxEvent.publishedAt), lt(outboxEvent.createdAt, before)))
  return row?.count ?? 0
}

export const relayOutbox = defineJob<RelayOutboxData>({
  queue: RELAY_QUEUE,
  description: "Publishes every unpublished outbox event to its kind's queue and stamps it in the same transaction, every five seconds, one tick at a time.",
  schedule: "* * * * *",
  scheduleData: { source: "schedule" },
  scheduleOptions: { tz: "UTC", missed: "skip" },
  // `short`: one tick queued at a time, so the schedule's occurrence and the tick's own successor are one row and not two chains. No retry: the next tick is the retry. Kept an hour: a tick every five seconds is seven hundred rows an hour, and a failed one shows on /readyz for that hour.
  queueOptions: { policy: "short", retryLimit: 0, deleteAfterSeconds: 60 * 60 },
  // Polled every second, so a successor due in five seconds runs in five and not in up to seven.
  workOptions: { pollingIntervalSeconds: 1 },
  // The dead-letter queue first: a consumer's queue names it, and pg-boss refuses a dead letter that does not exist yet.
  publishes: [OUTBOX_DEAD, ...OUTBOX_QUEUES],
  handler: async (jobs, context) => {
    const tick = await relayOnce(context).then(
      (outcome) => ({ outcome }),
      (error: unknown) => ({ error }),
    )
    // The successor, whatever the tick did: a tick that failed is tried again after the interval, a batch's worth (some company at its cap, or as many rows across companies) is followed at once. `short` drops the send when one is already queued.
    const startAfter = "outcome" in tick && tick.outcome.swept >= BATCH_SIZE ? 0 : RELAY_INTERVAL_SECONDS
    await context.send(RELAY_QUEUE, { source: "successor" } satisfies RelayOutboxData, { startAfter })
    if ("error" in tick) throw tick.error
    const { published } = tick.outcome
    if (published > 0) {
      context.log(`execution.relay-outbox: ${published} ${published === 1 ? "event" : "events"} published (${jobs.map((job) => job.data.source).join(", ")})`)
    }
    return tick.outcome
  },
})
