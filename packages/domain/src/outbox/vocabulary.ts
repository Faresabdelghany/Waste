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
// that aggregate itself. One kind is about either of two: a problem the driver
// reports is about its stop, or about the route alone where it names no stop,
// and Resolution's consumer reads which from the event's aggregate.

/** Each kind of news and the aggregates an event of it may be about; every kind but a reported problem is about one. */
export const OUTBOX_EVENTS = {
  "route-dispatched": ["route"],
  "route-started": ["route"],
  "route-completed": ["route"],
  "route-cancelled": ["route"],
  "route-reassigned": ["route"],
  "pickup-completed": ["pickup"],
  "pickup-failed": ["pickup"],
  "pickup-skipped": ["pickup"],
  "pickup-problem-reported": ["pickup", "route"],
  "pickup-corrected": ["pickup"],
  "unload-recorded": ["unload"],
  "command-rejected": ["command"],
  "ticket-opened": ["ticket"],
  "ticket-completed": ["ticket"],
  "ticket-rejected": ["ticket"],
  "invoice-issued": ["invoice"],
  "settlement-closed": ["settlement"],
  "application-decided": ["application"],
  "site-visit-recorded": ["site-visit"],
  "site-visit-voided": ["site-visit"],
  "alert-raised": ["alert"],
  "ticket-assigned": ["ticket"],
  "bulky-booking-booked": ["bulky-booking"],
  "bulky-booking-cancelled": ["bulky-booking"],
  "ticket-replied": ["ticket"],
  "weight-reviewed": ["unload"],
  "scale-ticket-completed": ["scale-ticket"],
  "scale-ticket-voided": ["scale-ticket"],
} as const satisfies Record<string, readonly [string, ...string[]]>

export type OutboxKind = keyof typeof OUTBOX_EVENTS
/** What an event of the kind may be about. */
export type AggregateOf<K extends OutboxKind> = (typeof OUTBOX_EVENTS)[K][number]
export type OutboxAggregate = AggregateOf<OutboxKind>
/** The kinds about one aggregate alone, which an event of them never names. */
export type SoleAggregateKind = { [K in OutboxKind]: (typeof OUTBOX_EVENTS)[K] extends readonly [string] ? K : never }[OutboxKind]

/** Every kind, in the table's order: what the outbox's kind column holds. */
export const OUTBOX_KINDS = Object.keys(OUTBOX_EVENTS) as [OutboxKind, ...OutboxKind[]]
/** Every aggregate, in the order the table first names it: what the outbox's aggregate column holds. */
export const OUTBOX_AGGREGATES = [...new Set(Object.values(OUTBOX_EVENTS).flat())] as [OutboxAggregate, ...OutboxAggregate[]]

/** An event's kind with an aggregate it may be about and that aggregate's id: one pair of the table. */
export type OutboxSubject<K extends OutboxKind = OutboxKind> = K extends OutboxKind ? { [A in AggregateOf<K>]: { kind: K; aggregate: A; aggregateId: string } }[AggregateOf<K>] : never

/** The subject of an event of a kind about one aggregate: the kind, that aggregate, its id. */
export const subjectOf = <K extends SoleAggregateKind>(kind: K, aggregateId: string): OutboxSubject<K> => ({ kind, aggregate: aggregateOf(kind), aggregateId }) as OutboxSubject<K>

/** The aggregate an event of the kind is about: the kind's own where it is about one, else the one its writer names, which must be one of the kind's. */
export function aggregateOf<K extends OutboxKind>(kind: K, named?: OutboxAggregate): AggregateOf<K> {
  const about: readonly OutboxAggregate[] = OUTBOX_EVENTS[kind]
  if (named === undefined) {
    if (about.length !== 1) throw new Error(`a ${kind} event names what it is about: one of ${about.join(", ")}`)
    return about[0] as AggregateOf<K>
  }
  if (!about.includes(named)) throw new Error(`a ${kind} event is about ${about.join(" or ")}, never a ${named}`)
  return named as AggregateOf<K>
}

/** Every list of this module by its name. */
export const OUTBOX_VOCABULARIES = { OUTBOX_KINDS, OUTBOX_AGGREGATES } as const satisfies Record<string, readonly [string, ...string[]]>
