// How an outbox event reaches a consumer's queue, as two consumer branches
// assumed it before the relay (Issue #104 part C) landed beside them — kept
// through the merge and removed by the reconciliation that follows, which
// puts both consumers on `../outbox/subscribe.ts`, the relay's own seam.
//
// Resolution's assumption (#109 part B): the relay publishes every
// `outbox_event` row as a pg-boss event named `outbox.<kind>`
// (`outboxQueue(kind)`), whose data is the contracts' `OutboxEvent` row with
// `companyId` beside it (`OutboxJob`), and a consumer `subscribe`s its own
// queue to the events it wants.
//
// Finance's assumption (#112 part B): the same, but the event name is the
// kind bare (`outboxEventName(kind)`), and the job's data is parsed with
// `PublishedEvent` before a field is read.
import { Id } from "@waste/contracts/ids"
import { OutboxEvent } from "@waste/contracts/outbox"
import type { OutboxKind } from "@waste/domain/execution/vocabulary"
import * as z from "zod"

/** The pg-boss event Resolution's consumer subscribes to per kind: `outbox.<kind>`, the relay's spelling. */
export const outboxQueue = (kind: OutboxKind): `outbox.${OutboxKind}` => `outbox.${kind}`

/** What Resolution's consumer's job carries: the outbox row as the contracts spell it, and the tenant it belongs to. */
export type OutboxJob = z.infer<typeof OutboxEvent> & { companyId: string }

/** The event Finance's consumer subscribes to per kind: the kind's own name — not the relay's spelling. */
export const outboxEventName = (kind: OutboxKind): string => kind

/** What the relay publishes onto a subscribed queue as the job's data, as Finance's consumer parses it: the outbox row on the wire, with its tenant. */
export const PublishedEvent = OutboxEvent.extend({
  /** The company the row belongs to: what `withCompany` fences the consumer's writes by. */
  companyId: Id,
})
export type PublishedEvent = z.infer<typeof PublishedEvent>
