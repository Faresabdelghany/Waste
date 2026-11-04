// The outbox's queues, spelled once for both sides (Issue #104 part C): the
// relay (jobs/relay-outbox.ts) sends every published `outbox_event` to the
// queue of each consumer of its kind, and a consumer — Resolution's (#109
// part B), Finance's (#112 part B), the e-conomic export's one day — works its
// own queue of each kind it wants and never reads the table. Nothing here
// dials anything: it is names, one schema and one function that turns a
// consumer into registry entries.
//
// A kind fans out (#339): each consumer has a queue of its own per kind,
// `outbox.<kind>.<consumer>` (`outbox.pickup-failed.resolution`,
// `outbox.pickup-failed.finance`), so two contexts hear one event and a
// failure of one never holds the other's job. The kind's own queue,
// `outbox.<kind>`, holds an event no consumer takes yet, and it is where every
// event went before the fan-out: a consumer's queue `inherits` it, so at
// every start, before any worker runs, what waits there is copied to each
// consumer of the kind and completed (boss.ts, `drainInherited`). That is the
// cut-over — a job the old relay sent before the deploy is worked once, by
// the consumers it was meant for — and the way a consumer added later starts
// from the events held for it. A job's data is `RelayedEvent`: the contracts' `OutboxEvent` — the
// row as the API would answer it, `publishedAt` stamped, `payload` the wire
// resource as the write left it — plus `companyId`, the tenant, since a
// consumer opens its writes with `withCompany(context.api.db, event.companyId,
// …)` and no request carries the claim for it. A consumer parses `payload`
// with the schema its kind promises (`PickupDetail` for a stop's events, the
// `Route` with `proofs` for a problem on the route alone, `DriverCommandReceipt`
// for `command-rejected`, `Unload`, `Ticket`, `InvoiceDetail`; #104 §6, #109
// §5, #112 §5), and is idempotent by `event.id`: pg-boss delivers at least
// once, and a job that fails is retried under the queue's policy and then
// failed, where `/readyz` counts it.
//
// A queue is a queue and not a topic: pg-boss hands each job to one worker,
// so each consumer has its own, and the registry test holds every queue to one
// job — one queue per kind and consumer. The relay owns the kinds' queues
// (`OUTBOX_QUEUES`, created before any worker starts), where an event no
// consumer takes waits for one under the queue's retention: ninety days
// (`UNCONSUMED_RETENTION_SECONDS`), since the consumer a
// kind is waiting for — the e-conomic export on `invoice-issued`, the
// settlement component on `settlement-closed` — starts from the queue and not
// from the table, and a fortnight would have it start blind to every invoice
// issued more than two weeks before it shipped; fourteen days, pg-boss's own,
// on a queue a consumer works (`CONSUMED_RETENTION_SECONDS`), where a job
// waits only for the next poll and a fortnight already says the worker was
// down. Either way the stamped outbox row is the record once the job is gone,
// and a consumer that must catch up further than its queue reaches reads the
// source table. This is the one door: the relay does not `publish` as well,
// since pg-boss's fan-out delivers only to the queues subscribed when the
// relay ran, so an event before a consumer's first start would be stamped and
// lost, and a consumer that took both doors would hear every event twice.
// Delivery order is pg-boss's — `created_on`, then unordered within one
// company's batch, which the relay writes in one transaction — so a consumer
// relies on `id` and on its own rows, never on one event arriving before
// another; the outbox table is the ordered record.
//
// The queue's retry policy is `OUTBOX_QUEUE_OPTIONS`, set by the relay when it
// creates the queue; a consumer that names `queueOptions` of its own has them
// written over it at every start, since the wiring updates a job's queue after
// the published queues (boss.ts), and a policy (`short`, `singleton`, …) cannot
// be changed after creation, so none is set here. Under a consumer's own
// options the seam writes `CONSUMED_OUTBOX_QUEUE_OPTIONS` on every queue it
// works: the fortnight's retention, and `deadLetter: "outbox.dead"`. A job
// that fails past its retries — a payload that will never parse, a row the
// event names that is not there — is a failed row on its queue for
// `/readyz.failedJobs` to count until `deleteAfterSeconds` removes it, and
// without a dead letter that is the end of it: the outbox row was stamped
// when the relay sent it, nothing resends it, and the event is gone with the
// row. So pg-boss copies the failed job to `OUTBOX_DEAD_QUEUE` (the relay
// `publishes` it, `DEAD_LETTER_QUEUE_OPTIONS`: kept ninety days, worked by
// nobody), data and output intact and `sourceName`/`sourceId` naming where it
// came from; `/readyz` carries the queue's waiting count as `deadLetters`,
// information and never a 503, and the redrive is pg-boss's own: `await
// boss.previewRedrive("outbox.dead")` to see where the jobs would go, `await
// boss.redrive("outbox.dead", { ids })` (or `{ sourceName:
// "outbox.<kind>.<consumer>" }`, or no filter for all of them) to re-create
// each as a fresh job on the queue it failed on — the one consumer's, never
// its kind's other consumers' — once the cause is fixed; a job that fails again is
// dead-lettered again, so a redrive is never a loss. The seam sets the dead
// letter and not each consumer, so a consumer added later cannot forget it.
import { Id } from "@waste/contracts/ids"
import { OutboxKind } from "@waste/contracts/execution"
import { OutboxEvent } from "@waste/contracts/outbox"
import type { WorkOptions } from "pg-boss"
import * as z from "zod"

import type { JobContext, JobDefinition, JobQueueOptions, PublishedQueue } from "../jobs/definition"

/** The kind's own queue, `outbox.<kind>`: where an event no consumer takes waits for one, and where every event went before the fan-out (#339). */
export const outboxQueue = <Kind extends OutboxKind>(kind: Kind): `outbox.${Kind}` => `outbox.${kind}`

/** A consumer's own queue of a kind, `outbox.<kind>.<consumer>`: what the relay sends the kind's events to for that consumer (#339). */
export const consumerQueue = <Kind extends OutboxKind, Name extends string>(kind: Kind, consumer: Name): `outbox.${Kind}.${Name}` => `outbox.${kind}.${consumer}`

/** A consumer's name as its queues spell it: lowercase letters and hyphens, the context it belongs to. */
export const CONSUMER_NAME = /^[a-z]+(?:-[a-z]+)*$/

/** The dead-letter queue every consumer's queue names: where a job that failed past its retries is copied, data intact, for an operator to redrive. */
export const OUTBOX_DEAD_QUEUE = "outbox.dead"

/** What a job on an `outbox.<kind>` queue carries: the contracts' `OutboxEvent`, stamped, with the tenant it belongs to. */
export const RelayedEvent = OutboxEvent.extend({
  /** The company whose event this is: what a consumer opens `withCompany` on. */
  companyId: Id,
})
export type RelayedEvent<Kind extends OutboxKind = OutboxKind> = Omit<z.infer<typeof RelayedEvent>, "kind"> & { kind: Kind }

/** How long a job waits on a queue no consumer works yet: ninety days, so the consumer a kind is waiting for starts from the queue and not blind. */
export const UNCONSUMED_RETENTION_SECONDS = 90 * 24 * 60 * 60
/** How long a job waits on a queue a consumer works: pg-boss's fourteen days, a fortnight already saying the worker was down. */
export const CONSUMED_RETENTION_SECONDS = 14 * 24 * 60 * 60
/** How long a dead letter waits for a redrive: ninety days, as an unconsumed job does. */
export const DEAD_LETTER_RETENTION_SECONDS = 90 * 24 * 60 * 60

/**
 * How a consumer's job fails and retries: three retries ten seconds apart
 * and doubling (10 s, 20 s, 40 s), for the lock, the dropped connection and
 * the rows a moment behind, and then a failed job the readiness count sees;
 * and the ninety days a job waits on a queue nobody works yet. Everything
 * else is pg-boss's default: fifteen minutes to run, a finished job kept
 * seven days.
 */
export const OUTBOX_QUEUE_OPTIONS: JobQueueOptions = { retryLimit: 3, retryDelay: 10, retryBackoff: true, retentionSeconds: UNCONSUMED_RETENTION_SECONDS }

/** What the seam writes under every consumer's own options on the queues it works: the fortnight's retention, and the dead letter. */
export const CONSUMED_OUTBOX_QUEUE_OPTIONS: JobQueueOptions = { retentionSeconds: CONSUMED_RETENTION_SECONDS, deadLetter: OUTBOX_DEAD_QUEUE }

/** The dead-letter queue's own options: no retry (nobody works it), a dead letter kept ninety days for a redrive. */
export const DEAD_LETTER_QUEUE_OPTIONS: JobQueueOptions = { retryLimit: 0, retentionSeconds: DEAD_LETTER_RETENTION_SECONDS }

/** Every outbox queue, one per kind, as the relay publishes them (`publishes` in its definition). */
export const OUTBOX_QUEUES: readonly PublishedQueue[] = OutboxKind.options.map((kind) => ({ queue: outboxQueue(kind), queueOptions: OUTBOX_QUEUE_OPTIONS }))

/** The dead-letter queue as the relay publishes it: first, so it exists before any consumer's queue names it. */
export const OUTBOX_DEAD: PublishedQueue = { queue: OUTBOX_DEAD_QUEUE, queueOptions: DEAD_LETTER_QUEUE_OPTIONS }

export type OutboxConsumer<Kind extends OutboxKind> = {
  /** Who it is, as its queues spell it (`CONSUMER_NAME`): `resolution`, `finance`. */
  name: string
  /** The kinds the consumer takes, a queue of its own each. */
  kinds: readonly Kind[]
  /** What the consumer does with an event, one sentence; each queue's description is this and its kind. */
  description: string
  /**
   * Runs once per event with the job's data parsed as `RelayedEvent` and the
   * process's context; throw to fail the job, which pg-boss retries under the
   * queue's policy and then fails for `/readyz` to count and copies to
   * `outbox.dead` for an operator to redrive. A job whose data does not parse,
   * or names another kind than its queue, fails the same way without reaching
   * here: a relay that drifted from this schema is a bug to see, not a fact to
   * swallow.
   */
  handler: (event: RelayedEvent<Kind>, context: JobContext) => Promise<unknown>
  /** Written over `OUTBOX_QUEUE_OPTIONS` on the consumer's queues at every start, over `CONSUMED_OUTBOX_QUEUE_OPTIONS` (the fortnight, the dead letter), which the seam writes whatever a consumer names; the relay's stand otherwise. */
  queueOptions?: JobQueueOptions
  /** Polling and concurrency of this process's worker on each queue; pg-boss's defaults otherwise. */
  workOptions?: WorkOptions
  /** Takes none of the kind's backlog: only the events relayed once the consumer runs, never those that waited on the kind's own queue before it existed (`JobDefinition.startsFresh`). */
  startsFresh?: true
}

/**
 * A consumer as registry entries: one `JobDefinition` per kind, its queue
 * `outbox.<kind>.<name>`, inheriting the kind's own queue, each spread into
 * `JOBS` in jobs/index.ts and listed in `OUTBOX_CONSUMERS` (routes.ts),
 * which the relay sends by —
 *
 *     export const openTickets = defineOutboxConsumer({
 *       name: "resolution",
 *       kinds: ["pickup-failed", "pickup-skipped", "pickup-problem-reported", "command-rejected"],
 *       description: "Opens a ticket where nobody decided about the address.",
 *       handler: async (event, { api }) => withCompany(api.db, event.companyId, (tx) => ...),
 *     })
 *     export const JOBS: readonly AnyJob[] = [heartbeat, relayOutbox, ...openTickets]
 *
 * — so the wiring creates or updates each queue, moves what waits on the
 * kind's own queue onto it, works it with the handler and schedules nothing,
 * exactly as for any other job. Every entry's `queueOptions` are the outbox's
 * retry policy and `CONSUMED_OUTBOX_QUEUE_OPTIONS` under the consumer's own,
 * since the consumer's queue is its own to create.
 */
export function defineOutboxConsumer<const Kind extends OutboxKind>({ name, kinds, description, handler, queueOptions, workOptions, startsFresh }: OutboxConsumer<Kind>): JobDefinition<RelayedEvent>[] {
  if (!CONSUMER_NAME.test(name)) throw new Error(`an outbox consumer's name is lowercase words joined by hyphens: ${JSON.stringify(name)}`)
  return kinds.map((kind) => ({
    queue: consumerQueue(kind, name),
    inherits: outboxQueue(kind),
    description: `${description} (${kind})`,
    queueOptions: { ...OUTBOX_QUEUE_OPTIONS, ...CONSUMED_OUTBOX_QUEUE_OPTIONS, ...queueOptions },
    ...(workOptions === undefined ? {} : { workOptions }),
    ...(startsFresh === undefined ? {} : { startsFresh }),
    handler: async (jobs, context) => {
      const events: string[] = []
      for (const job of jobs) {
        const event = RelayedEvent.parse(job.data)
        if (event.kind !== kind) {
          throw new Error(`${consumerQueue(kind, name)}: job ${job.id} carries a ${event.kind} event (${event.id}); the relay sends each kind to its own consumers' queues`)
        }
        await handler(event as RelayedEvent<Kind>, context)
        events.push(event.id)
      }
      return { events }
    },
  }))
}
