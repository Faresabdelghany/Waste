// How an outbox event reaches a consumer's queue: the one assumption this
// package makes about the relay (#104 part C), spelled in one place so the
// relay's own module and this one reconcile here and nowhere else.
//
// The relay publishes each `outbox_event` once — `boss.publish(kind, event)`
// in pg-boss's fan-out, where a consumer `subscribe`s its queue to the kinds
// it wants and the relay knows no consumer by name (#104 §6). What `publish`
// sends to each subscribed queue is the job's `data`, and here that is the
// contracts' `OutboxEvent` whole: the row as the wire spells it (`id`,
// `projectId`, `kind`, `aggregateKind`, `aggregateId`, `occurredAt`,
// `payload`, the stamps) with `companyId` beside it, since the fence needs
// the tenant and the wire resource does not carry one. A consumer parses the
// data with `PublishedEvent` before it reads a field, so a relay that sends
// another shape fails the job with the reason and never writes a row from a
// half-read event.
//
// The event name a consumer subscribes to is `outboxEventName(kind)` — the
// kind itself, `pickup-completed` — since pg-boss's `subscription` table keys
// on `(event, name)` and the kind is the one word both sides already have. A
// queue subscribes to a kind once (`subscribe` upserts), and unsubscribing is
// the registry's business when a job stops naming a kind.
import { Id } from "@waste/contracts/ids"
import { OutboxEvent } from "@waste/contracts/outbox"
import type { OutboxKind } from "@waste/domain/execution/vocabulary"
import * as z from "zod"

/** The event a consumer's queue is subscribed to, per outbox kind: the kind's own name. */
export const outboxEventName = (kind: OutboxKind): string => kind

/** What the relay publishes onto a subscribed queue as the job's data: the outbox row on the wire, with its tenant. */
export const PublishedEvent = OutboxEvent.extend({
  /** The company the row belongs to: what `withCompany` fences the consumer's writes by. */
  companyId: Id,
})
export type PublishedEvent = z.infer<typeof PublishedEvent>
