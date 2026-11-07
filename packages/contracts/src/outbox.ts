// The outbox on the wire (Issue #104, §6): one event a context writes in the
// request's transaction after the rows it describes, for the relay (part C)
// to publish and stamp. Not a route's resource — nothing answers it over HTTP
// — but the relay and its test read rows of this shape, and a consumer reads
// `payload`, which is the wire resource as the write left it.
//
// Which resource that is depends on the kind and the aggregate the event is
// about (@waste/domain/outbox/vocabulary), so `OutboxEvent` carries it as
// JSON and `OUTBOX_PAYLOADS` says, kind by kind, what it is: the writer's
// `emit` takes that schema's input, and a consumer reads the event's payload
// through the same schema. A payload outlives the release that wrote it — an
// event waits on its queue until a consumer works it — so a field a resource
// gains later is read with a default where the payload may lack it (the
// Pickup's own, and the route's hold and cancel reason here).
import { aggregateOf, OUTBOX_AGGREGATES, OUTBOX_KINDS, type AggregateOf, type OutboxKind as Kind } from "@waste/domain/outbox/vocabulary"
import * as z from "zod"

import { Alert } from "./alerts"
import { Application } from "./applications"
import { BulkyBooking } from "./bulky"
import { IsoDateTime } from "./dates"
import { DriverCommandReceipt } from "./driver-commands"
import { Id } from "./ids"
import { InvoiceDetail } from "./invoices"
import { Pickup } from "./pickups"
import { ProofOfService } from "./proofs"
import { stamped } from "./resource"
import { routeFields } from "./routes"
import { ScaleTicket } from "./scale-house"
import { SettlementDetail } from "./settlements"
import { SiteVisit } from "./site-visits"
import { Ticket, TicketEvent } from "./tickets"
import { Unload } from "./unloads"
import { WeightReview } from "./weight-control"

/** What the outbox tells the other contexts, every context's news. */
export const OutboxKind = z.enum(OUTBOX_KINDS)
export type OutboxKind = z.infer<typeof OutboxKind>

/** What an outbox event is about. */
export const OutboxAggregate = z.enum(OUTBOX_AGGREGATES)
export type OutboxAggregate = z.infer<typeof OutboxAggregate>

export const OutboxEvent = z.object({
  ...stamped,
  projectId: Id,
  kind: OutboxKind,
  aggregateKind: OutboxAggregate,
  /** The route, pickup, unload or command the event is about; a soft id. */
  aggregateId: Id,
  /** The command's instant, not the request's. */
  occurredAt: IsoDateTime,
  /** The wire resource as the write left it: what it is, `OUTBOX_PAYLOADS` says by the kind and the aggregate. */
  payload: z.json(),
  /** Stamped by the relay; null until it is. */
  publishedAt: IsoDateTime.nullable(),
})
export type OutboxEvent = z.infer<typeof OutboxEvent>

/** A route's fields as an event carries them: the hold arrived on the wire with #209 and the cancel's reason code with O5 of #290, so an event taken before either reads as a route the scheme's, cancelled for no code given. */
const routeEventFields = { ...routeFields, heldAt: routeFields.heldAt.default(null), cancelReasonCode: routeFields.cancelReasonCode.default(null) }

/** The `Route` as a route's event carries it. */
export const RouteEvent = z.object(routeEventFields)
export type RouteEvent = z.infer<typeof RouteEvent>

/** A problem reported on the route alone: the `Route` with the problem proof the command made. */
export const RouteProblem = z.object({ ...routeEventFields, proofs: z.array(ProofOfService) })
export type RouteProblem = z.infer<typeof RouteProblem>

/** The `Pickup` as a stop's event carries it: with the proofs the command made, where the door wrote one; a route's cancel closes its stops with none. */
export const PickupEvent = Pickup.extend({ proofs: z.array(ProofOfService).optional() })
export type PickupEvent = z.infer<typeof PickupEvent>

/** Each kind's payload by the aggregate its event is about: that aggregate's wire resource as the write left it. */
export const OUTBOX_PAYLOADS = {
  "route-dispatched": { route: RouteEvent },
  "route-started": { route: RouteEvent },
  "route-completed": { route: RouteEvent },
  "route-cancelled": { route: RouteEvent },
  "route-reassigned": { route: RouteEvent },
  "pickup-completed": { pickup: PickupEvent },
  "pickup-failed": { pickup: PickupEvent },
  "pickup-skipped": { pickup: PickupEvent },
  "pickup-problem-reported": { pickup: PickupEvent, route: RouteProblem },
  "pickup-corrected": { pickup: PickupEvent },
  "unload-recorded": { unload: Unload },
  "command-rejected": { command: DriverCommandReceipt },
  "ticket-opened": { ticket: Ticket },
  "ticket-completed": { ticket: Ticket },
  "ticket-rejected": { ticket: Ticket },
  "invoice-issued": { invoice: InvoiceDetail },
  "settlement-closed": { settlement: SettlementDetail },
  "application-decided": { application: Application },
  "site-visit-recorded": { "site-visit": SiteVisit },
  "site-visit-voided": { "site-visit": SiteVisit },
  "alert-raised": { alert: Alert },
  "ticket-assigned": { ticket: Ticket },
  "bulky-booking-booked": { "bulky-booking": BulkyBooking },
  "bulky-booking-cancelled": { "bulky-booking": BulkyBooking },
  "ticket-replied": { ticket: TicketEvent },
  "weight-reviewed": { unload: WeightReview },
  "scale-ticket-completed": { "scale-ticket": ScaleTicket },
  "scale-ticket-voided": { "scale-ticket": ScaleTicket },
} as const satisfies { [K in Kind]: { [A in AggregateOf<K>]: z.ZodType } }

type PayloadSchema<K extends Kind, A extends AggregateOf<K>> = A extends keyof (typeof OUTBOX_PAYLOADS)[K] ? (typeof OUTBOX_PAYLOADS)[K][A] : never

/** What an event of the kind about the aggregate carries, as a consumer reads it. */
export type OutboxPayload<K extends Kind, A extends AggregateOf<K> = AggregateOf<K>> = z.output<PayloadSchema<K, A>>
/** What an event of the kind about the aggregate carries, as its writer hands it in. */
export type OutboxPayloadInput<K extends Kind, A extends AggregateOf<K> = AggregateOf<K>> = z.input<PayloadSchema<K, A>>

/** An event's payload read through its kind's schema for the aggregate it is about; throws where it is not that resource. */
export function outboxPayloadOf<K extends Kind, A extends AggregateOf<K>>(kind: K, aggregate: A, payload: unknown): OutboxPayload<K, A> {
  const schemas: Readonly<Record<string, z.ZodType>> = OUTBOX_PAYLOADS[kind]
  return schemas[aggregateOf(kind, aggregate)].parse(payload) as OutboxPayload<K, A>
}
