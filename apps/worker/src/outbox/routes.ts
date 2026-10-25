// Where the relay sends each kind (#339): the outbox's consumers, and the
// queues their entries work, by kind. A consumer is listed here once and
// spread into `JOBS` (jobs/index.ts); the registry test holds the two to the
// same entries, so a consumer the relay does not send to cannot be added.
import { OutboxKind } from "@waste/contracts/execution"

import type { AnyJob } from "../jobs/definition"
import { openTickets } from "../jobs/open-tickets"
import { recordBillableEvents } from "../jobs/record-billable-events"
import { outboxQueue } from "./subscribe"

/** Every outbox consumer's entries, one per kind it takes: Resolution's, then Finance's. */
export const OUTBOX_CONSUMERS: readonly AnyJob[] = [...openTickets, ...recordBillableEvents]

/** Each kind's consumers' queues, in the consumers' order, read off the entries: an entry inherits its kind's own queue (`outbox.<kind>`). */
export function routesOf(consumers: readonly AnyJob[], kinds: readonly OutboxKind[]): Map<OutboxKind, string[]> {
  const routes = new Map<OutboxKind, string[]>()
  for (const kind of kinds) {
    const queues = consumers.filter((job) => job.inherits === outboxQueue(kind)).map((job) => job.queue)
    if (queues.length > 0) routes.set(kind, queues)
  }
  return routes
}

/** What the relay sends by: each consumed kind's consumers' queues; a kind not here goes to its own queue to wait for one. */
export const OUTBOX_ROUTES: ReadonlyMap<OutboxKind, readonly string[]> = routesOf(OUTBOX_CONSUMERS, OutboxKind.options)
