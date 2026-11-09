// The outbox's vocabulary (#104 §6, F2 of #574): every kind of news one
// context writes for the others, and the aggregate each is about. The table is
// Execution's, but its kinds are every context's — Resolution's, Finance's,
// the Registry's, the visits', the notices', the scale house's — so they live
// here, below all of them, and each context's own subset (`NOTIFICATION_EVENTS`,
// Finance's and Resolution's event kinds, the customer notices' kinds) is
// declared against `OutboxKind`, where a kind misspelt or removed fails the
// typecheck. The database's two CHECKs read `OUTBOX_KINDS` and
// `OUTBOX_AGGREGATES` in this order, so a reordering is a migration.
//
// A kind is about one aggregate, whose wire resource is its payload
// (@waste/contracts/outbox, `OUTBOX_PAYLOADS`), and an event of it never names
// that aggregate itself. A problem the driver reports is two kinds for that
// reason: about the stop it names, or about the route where it names none.

/** Each kind of news and the aggregate an event of it is about. */
export const OUTBOX_EVENTS = {
  "route-dispatched": "route",
  "route-started": "route",
  "route-completed": "route",
  "route-cancelled": "route",
  "route-reassigned": "route",
  "route-problem-reported": "route",
  "pickup-completed": "pickup",
  "pickup-failed": "pickup",
  "pickup-skipped": "pickup",
  "pickup-problem-reported": "pickup",
  "pickup-corrected": "pickup",
  "unload-recorded": "unload",
  "command-rejected": "command",
  "ticket-opened": "ticket",
  "ticket-completed": "ticket",
  "ticket-rejected": "ticket",
  "invoice-issued": "invoice",
  "settlement-closed": "settlement",
  "application-decided": "application",
  "site-visit-recorded": "site-visit",
  "site-visit-voided": "site-visit",
  "alert-raised": "alert",
  "ticket-assigned": "ticket",
  "bulky-booking-booked": "bulky-booking",
  "bulky-booking-cancelled": "bulky-booking",
  "ticket-replied": "ticket",
  "weight-reviewed": "unload",
  "scale-ticket-completed": "scale-ticket",
  "scale-ticket-voided": "scale-ticket",
} as const satisfies Record<string, string>

export type OutboxKind = keyof typeof OUTBOX_EVENTS
export type AggregateOf<K extends OutboxKind> = (typeof OUTBOX_EVENTS)[K]
export type OutboxAggregate = AggregateOf<OutboxKind>

/** Every kind, in the table's order: what the outbox's kind column holds. */
export const OUTBOX_KINDS = Object.keys(OUTBOX_EVENTS) as [OutboxKind, ...OutboxKind[]]
/** Every aggregate, in the order the table first names it: what the outbox's aggregate column holds. */
export const OUTBOX_AGGREGATES = [...new Set(Object.values(OUTBOX_EVENTS))] as [OutboxAggregate, ...OutboxAggregate[]]

export const aggregateOf = <K extends OutboxKind>(kind: K): AggregateOf<K> => OUTBOX_EVENTS[kind]

/** An event's kind with the aggregate it is about and that aggregate's id: one row of the table. */
export type OutboxSubject<K extends OutboxKind = OutboxKind> = K extends OutboxKind ? { kind: K; aggregate: AggregateOf<K>; aggregateId: string } : never

export const subjectOf = <K extends OutboxKind>(kind: K, aggregateId: string): OutboxSubject<K> => ({ kind, aggregate: aggregateOf(kind), aggregateId }) as OutboxSubject<K>

export const OUTBOX_VOCABULARIES = { OUTBOX_KINDS, OUTBOX_AGGREGATES } as const satisfies Record<string, readonly [string, ...string[]]>
