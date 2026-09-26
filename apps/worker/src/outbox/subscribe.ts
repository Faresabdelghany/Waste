// The outbox's queues, spelled once for both sides (Issue #104 part C): the
// relay (jobs/relay-outbox.ts) sends every published `outbox_event` to the
// queue of its kind, and a consumer — Resolution's (#109 part B), Finance's
// (#112 part B), the e-conomic export's one day — works the queues of the
// kinds it wants and never reads the table. Nothing here dials anything: it is
// names, one schema and one function that turns a consumer into registry
// entries.
//
// The queue is `outbox.<kind>`, one per member of the contracts' `OutboxKind`
// (`outbox.pickup-failed`, `outbox.pickup-completed`, `outbox.ticket-completed`,
// …), and its job's data is `RelayedEvent`: the contracts' `OutboxEvent` — the
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
// so one consumer takes a kind through this door. Resolution's four and
// Finance's three do not meet, and the registry test holds every queue to one
// job, so a second consumer of a kind is a failing test that asks for a
// decision and not a silent halving of the events. The relay owns the queues
// (`OUTBOX_QUEUES`, created before any worker starts) and a job waits for
// whoever works it, under pg-boss's retention (fourteen days for a job nobody
// took, after which the row is dropped and the stamped outbox row is the
// record). The relay also `publish`es every event under the same name,
// pg-boss's own fan-out, so a consumer that would rather `subscribe` a queue
// of its own to `outbox.<kind>` (`boss.subscribe("outbox.pickup-failed",
// "resolution.open-tickets")`) receives a copy there — a copy, so a consumer
// takes one door and not both; and the fan-out delivers only to the queues
// subscribed when the relay ran, so an event before a consumer's first start
// reaches it through the kind's queue and not this way. Delivery order is
// pg-boss's — `created_on`, then unordered within one company's batch, which
// the relay writes in one transaction — so a consumer relies on `id` and on
// its own rows, never on one event arriving before another; the outbox table
// is the ordered record.
//
// The queue's retry policy is `OUTBOX_QUEUE_OPTIONS`, set by the relay when it
// creates the queue; a consumer that names `queueOptions` of its own has them
// written over it at every start, since the wiring updates a job's queue after
// the published queues (boss.ts), and a policy (`short`, `singleton`, …) cannot
// be changed after creation, so none is set here.
import { Id } from "@waste/contracts/ids"
import { OutboxKind } from "@waste/contracts/execution"
import { OutboxEvent } from "@waste/contracts/outbox"
import type { QueueOptions, WorkOptions } from "pg-boss"
import * as z from "zod"

import type { JobContext, JobDefinition, PublishedQueue } from "../jobs/definition"

/** The queue an event of this kind is published to: `outbox.<kind>`. */
export const outboxQueue = <Kind extends OutboxKind>(kind: Kind): `outbox.${Kind}` => `outbox.${kind}`

/** What a job on an `outbox.<kind>` queue carries: the contracts' `OutboxEvent`, stamped, with the tenant it belongs to. */
export const RelayedEvent = OutboxEvent.extend({
  /** The company whose event this is: what a consumer opens `withCompany` on. */
  companyId: Id,
})
export type RelayedEvent<Kind extends OutboxKind = OutboxKind> = Omit<z.infer<typeof RelayedEvent>, "kind"> & { kind: Kind }

/**
 * How a consumer's job fails and retries: three retries ten seconds apart
 * and doubling (10 s, 20 s, 40 s), for the lock, the dropped connection and
 * the rows a moment behind, and then a failed job the readiness count sees.
 * Everything else is pg-boss's default: fifteen minutes to run, a job nobody
 * took kept fourteen days, a finished one seven.
 */
export const OUTBOX_QUEUE_OPTIONS: QueueOptions = { retryLimit: 3, retryDelay: 10, retryBackoff: true }

/** Every outbox queue, one per kind, as the relay publishes them (`publishes` in its definition). */
export const OUTBOX_QUEUES: readonly PublishedQueue[] = OutboxKind.options.map((kind) => ({ queue: outboxQueue(kind), queueOptions: OUTBOX_QUEUE_OPTIONS }))

export type OutboxConsumer<Kind extends OutboxKind> = {
  /** The kinds the consumer takes, one queue each. */
  kinds: readonly Kind[]
  /** What the consumer does with an event, one sentence; each queue's description is this and its kind. */
  description: string
  /**
   * Runs once per event with the job's data parsed as `RelayedEvent` and the
   * process's context; throw to fail the job, which pg-boss retries under the
   * queue's policy and then fails for `/readyz` to count. A job whose data
   * does not parse, or names another kind than its queue, fails the same way
   * without reaching here: a relay that drifted from this schema is a bug to
   * see, not a fact to swallow.
   */
  handler: (event: RelayedEvent<Kind>, context: JobContext) => Promise<unknown>
  /** Written over `OUTBOX_QUEUE_OPTIONS` on the consumer's queues at every start; the relay's stand otherwise. */
  queueOptions?: QueueOptions
  /** Polling and concurrency of this process's worker on each queue; pg-boss's defaults otherwise. */
  workOptions?: WorkOptions
}

/**
 * A consumer as registry entries: one `JobDefinition` per kind, its queue
 * `outbox.<kind>`, each spread into `JOBS` in jobs/index.ts —
 *
 *     export const openTickets = defineOutboxConsumer({
 *       kinds: ["pickup-failed", "pickup-skipped", "pickup-problem-reported", "command-rejected"],
 *       description: "Opens a ticket where nobody decided about the address.",
 *       handler: async (event, { api }) => withCompany(api.db, event.companyId, (tx) => ...),
 *     })
 *     export const JOBS: readonly AnyJob[] = [heartbeat, relayOutbox, ...openTickets]
 *
 * — so the wiring creates or updates each queue, works it with the handler
 * and schedules nothing, exactly as for any other job.
 */
export function defineOutboxConsumer<const Kind extends OutboxKind>({ kinds, description, handler, queueOptions, workOptions }: OutboxConsumer<Kind>): JobDefinition<RelayedEvent>[] {
  return kinds.map((kind) => ({
    queue: outboxQueue(kind),
    description: `${description} (${kind})`,
    ...(queueOptions === undefined ? {} : { queueOptions }),
    ...(workOptions === undefined ? {} : { workOptions }),
    handler: async (jobs, context) => {
      const events: string[] = []
      for (const job of jobs) {
        const event = RelayedEvent.parse(job.data)
        if (event.kind !== kind) {
          throw new Error(`${outboxQueue(kind)}: job ${job.id} carries a ${event.kind} event (${event.id}); the relay publishes each kind to its own queue`)
        }
        await handler(event as RelayedEvent<Kind>, context)
        events.push(event.id)
      }
      return { events }
    },
  }))
}
