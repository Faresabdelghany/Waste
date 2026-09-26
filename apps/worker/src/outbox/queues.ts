// How an outbox event reaches a consumer's queue: the one assumption this
// process makes about the relay (Issue #104 part C, `execution.relay-outbox`),
// spelled in one file so the day the relay lands the two agree in one place
// or disagree in one place.
//
// The assumption. The relay publishes every `outbox_event` row as a pg-boss
// event named for its kind — `outbox.pickup-failed`, `outbox.command-rejected`
// — through `boss.publish(outboxQueue(kind), event)`, and pg-boss's fan-out
// (`pgboss.subscription`, `subscribe(event, queue)`) delivers one job per
// subscribed queue with the row as its data: the contracts' `OutboxEvent`,
// the row as `GET` would answer it if anything did — `id`, `projectId`,
// `kind`, `aggregateKind`, `aggregateId`, `occurredAt`, `payload`,
// `publishedAt`, the two stamps — with `companyId` beside it, since the
// consumer's every write runs under `withCompany` and the row's tenant is
// what it opens the transaction with (`OutboxJob`). A consumer therefore
// `subscribe`s its own queue to the events it wants at start and never
// reads the outbox table: `published_at` is the relay's alone (#109 §3).
//
// Why an event name and not the kind bare: pg-boss's `publish(event)` and
// `send(queue)` share no namespace but do share a table of names, and a
// kind spelled bare (`pickup-failed`) would read like a queue of its own
// beside `resolution.open-tickets`; the `outbox.` prefix says what the name
// is. Should the relay publish under another spelling, this function and
// `OutboxJob` change and nothing else in the consumer does.
import type { OutboxEvent } from "@waste/contracts/outbox"
import type { OutboxKind } from "@waste/domain/execution/vocabulary"

/** The pg-boss event the relay publishes an outbox row of this kind under. */
export const outboxQueue = (kind: OutboxKind): `outbox.${OutboxKind}` => `outbox.${kind}`

/** What a consumer's job carries: the outbox row as the contracts spell it, and the tenant it belongs to. */
export type OutboxJob = OutboxEvent & { companyId: string }
