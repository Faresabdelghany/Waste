// The pure half of the outbox's second consumer (Issue #112 §3, ADR-0003,
// ADR-0005): which outbox event becomes which Billable Event. The worker
// (part B) parses the job's event with the contracts, reads the facts beside
// the payload in one statement each under `withCompany` — the route and its
// scheme's planning area, the container's type, the placement valid on the
// service date with its subscription, agreement and product, the list the
// agreement is priced under and its rows on the day, the pickup's live event
// and whether an invoice line names it, a ticket's agreement — hands the
// plain facts here, and does what this answers: records the draft, cancels
// the live event, records the reversal, or nothing. Every rule of the table
// in §3 is decided here and nowhere else, so it is a table test without a
// database.
//
// The rules in a few sentences. A `pickup-completed` under a per-pickup
// product is a `pickup` event of quantity one, priced by the resolver on the
// route's service date — the identity day, on which the agreement and the
// placement are judged (ADR-0005), so a collection shifted by a holiday is
// priced as the service it was — or blocked with the reason the office can
// act on: `no-subscription` when no placement was valid that day. Under a
// `month` product it is nothing: the collection is inside a recurring charge
// the recurring issue bills, and a zero-priced row would say nothing
// (§7.10). A `pickup-corrected` to `completed` is the same, when the pickup
// has no live event; to `skipped` or `failed` it cancels the live event with
// `pickup-corrected` and no person when nothing invoiced it, and records a
// `reversal` when a line did — the original's amounts copied and negated,
// the original's service date, the original named — so the next run puts a
// negative line on the payer's next invoice; nothing when there is no live
// event. A `ticket-completed` with `recollected` or `serviced` is a `ticket`
// event with no product and `no-product` for the office to price through
// `reprice`, on the day the ticket closed on the project's clock — the worker
// renders the day, since this module has no clock and no timezone — when an
// agreement is reachable through the ticket or its pickup's placement, and
// nothing otherwise: a ticket about nothing billable makes no money row.
// `answered`, `no-action` and `duplicate`, the route's events, the other
// pickup events, the unload and the two Finance publishes are nothing here.
// A credit for a missed collection is never the consumer's (§7.11).
//
// What the draft does not carry is the writer's: `createdBy` null,
// `sourceEventId` the event's id (`billable_event_origin_shape` ties the two),
// the stamps, and the row's own id.
import type { OutboxKind, PickupOutcome } from "../execution/vocabulary"
import type { AgreementStatus, CustomerKind, ProductUnit } from "../registry/vocabulary"
import type { TicketResolution } from "../resolution/vocabulary"
import { priceOccurrence, type PriceLabels, type PricedAmounts, type PricedList, type PriceRow } from "./pricing"
import type { BillableEventKind, BlockReason, CancelReason } from "./vocabulary"

/** The events about a pickup that Finance reads. */
export const PICKUP_EVENT_KINDS = ["pickup-completed", "pickup-corrected"] as const satisfies readonly OutboxKind[]
export type PickupEventKind = (typeof PICKUP_EVENT_KINDS)[number]

/** The placement valid on the service date, with what it reaches: the subscription, the agreement it runs under, and the product it delivers. */
export type PlacementFacts<Row extends PriceRow = PriceRow> = {
  subscriptionId: string
  agreement: {
    id: string
    status: AgreementStatus
    /** The agreement's customer's kind: the prototype's Customer type. */
    customerKind: CustomerKind
    customerId: string
  }
  product: { id: string; unit: ProductUnit; vatPercent: number | null }
  /** The list the agreement is priced under — its own or the project's default, `priceListIdFor` — with its rows valid on the day; null when neither names one. */
  priceList: PricedList<Row> | null
}

/** The pickup's live `pickup` event — not cancelled, not reversed — as the worker read it, with whether an invoice line names it. */
export type LiveEventFacts = {
  id: string
  agreementId: string
  subscriptionId: string | null
  productId: string
  quantity: number
  /** The frozen price, or null while the event is blocked. */
  price: PricedAmounts | null
  serviceDate: string
  invoiced: boolean
}

/** A pickup's event as the worker reads it: the payload's fields, the outcome a correction gave, and what it read beside them. */
export type PickupEventFacts<Row extends PriceRow = PriceRow> = {
  kind: PickupEventKind
  routeId: string
  pickupId: string
  /** The route's service date, `YYYY-MM-DD`: the identity day, never the operating date. */
  serviceDate: string
  /** The route's scheme's planning area, the price row's zone; null for a scheme without one. */
  planningAreaId: string | null
  containerTypeId: string
  /** The pickup's fraction on the day. */
  wasteFractionId: string
  /** The pickup's status after the event: `completed` on a completion, the outcome on a correction. */
  outcome: PickupOutcome
  /** The placement of the container valid on the service date, or null when none was. */
  placement: PlacementFacts<Row> | null
  /** The pickup's live event, or null when it has none. */
  liveEvent: LiveEventFacts | null
}

/** A completed ticket as the worker reads it: what it ended in, the agreement it reaches, and the day it closed on the project's clock. */
export type TicketCompletedFacts = {
  kind: "ticket-completed"
  ticketId: string
  resolution: TicketResolution
  /** The ticket's own agreement, or the one its pickup's placement ran under on the route's service date, with that placement's subscription; null when none is reachable. */
  agreement: { id: string; subscriptionId: string | null } | null
  /** The ticket's `closedAt` rendered as a `YYYY-MM-DD` day in the project's timezone by the worker: this module has no clock and no timezone. */
  closedOn: string
}

/** Every other event, which this module reads the kind of and nothing else. */
export type OtherEventFacts = { kind: Exclude<OutboxKind, PickupEventKind | "ticket-completed"> }

/** An outbox event as the worker hands it here: the kind, and the plain facts that kind's payload and the reads beside it give. */
export type EventFacts<Row extends PriceRow = PriceRow> = PickupEventFacts<Row> | TicketCompletedFacts | OtherEventFacts

/** What a billable event links to: the ids the event named, each null where it named none. */
export type BillableEventLinks = {
  routeId: string | null
  pickupId: string | null
  ticketId: string | null
  reversesEventId: string | null
}

/** The event the consumer records: what the writer takes from the draft, the rest being the outbox event's. */
export type BillableEventDraft = {
  kind: BillableEventKind
  serviceDate: string
  agreementId: string | null
  subscriptionId: string | null
  productId: string | null
  quantity: number
  /** The price as resolved and frozen, or null while blocked. */
  price: PricedAmounts | null
  blockReason: BlockReason | null
  links: BillableEventLinks
}

/** What the consumer does with an event: records a draft, cancels the live event, or records a reversal of it. */
export type BillableAction =
  | { action: "record"; draft: BillableEventDraft }
  | { action: "cancel"; eventId: string; reason: CancelReason }
  | { action: "reverse"; eventId: string; draft: BillableEventDraft }

/** The resolutions whose completion is billable: a re-collection arranged, or the request fulfilled. */
export const BILLABLE_RESOLUTIONS = ["recollected", "serviced"] as const satisfies readonly TicketResolution[]

/** Whether a completed ticket's resolution is one the office may charge for: the list's membership, never a table's keys, so a stray string finds nothing. */
export const isBillableResolution = (resolution: TicketResolution): boolean => (BILLABLE_RESOLUTIONS as readonly string[]).includes(resolution)

const NO_LINKS: BillableEventLinks = { routeId: null, pickupId: null, ticketId: null, reversesEventId: null }

/** A completed pickup's event: blocked with `no-subscription` where no placement was valid, nothing under a `month` product, otherwise priced by the resolver or blocked with the reason that stood in the way. */
function pickupDraft<Row extends PriceRow>(facts: PickupEventFacts<Row>, labels: PriceLabels): BillableEventDraft | undefined {
  const links: BillableEventLinks = { ...NO_LINKS, routeId: facts.routeId, pickupId: facts.pickupId }
  const base = { kind: "pickup" as const, serviceDate: facts.serviceDate, quantity: 1, links }
  const placement = facts.placement
  if (placement === null) return { ...base, agreementId: null, subscriptionId: null, productId: null, price: null, blockReason: "no-subscription" }
  // The collection is inside a recurring charge, which the recurring issue bills; a `job` is one event like a `pickup`.
  if (placement.product.unit === "month") return undefined
  const outcome = priceOccurrence(
    {
      agreement: { status: placement.agreement.status },
      priceList: placement.priceList,
      product: placement.product,
      quantity: 1,
      input: {
        on: facts.serviceDate,
        planningAreaId: facts.planningAreaId,
        customerKind: placement.agreement.customerKind,
        containerTypeId: facts.containerTypeId,
        wasteFractionId: facts.wasteFractionId,
        customerId: placement.agreement.customerId,
      },
    },
    labels,
  )
  return { ...base, agreementId: placement.agreement.id, subscriptionId: placement.subscriptionId, productId: placement.product.id, price: outcome.price, blockReason: outcome.blockReason }
}

/** An amount negated, a zero staying the zero it is and never `-0`. */
const negated = (minor: number): number => -minor || 0

/** The reversal of an invoiced event: its agreement, product, quantity, unit price, rate and currency copied, the net and the VAT negated, the original named, on the original's service date, with no row of its own. */
export function reversalOf(original: LiveEventFacts): BillableEventDraft {
  if (original.price === null) throw new Error(`reversalOf: event ${original.id} carries no price; a blocked event is cancelled, never reversed`)
  const { price } = original
  return {
    kind: "reversal",
    serviceDate: original.serviceDate,
    agreementId: original.agreementId,
    subscriptionId: original.subscriptionId,
    productId: original.productId,
    quantity: original.quantity,
    price: { ...price, priceListRowId: null, netMinor: negated(price.netMinor), vatMinor: negated(price.vatMinor) },
    blockReason: null,
    links: { ...NO_LINKS, reversesEventId: original.id },
  }
}

/** What a corrected pickup does to its live event: nothing without one; a cancellation with the consumer's reason when no line names it; a reversal when one does. */
function correctionOf(live: LiveEventFacts | null): BillableAction | undefined {
  if (live === null) return undefined
  if (!live.invoiced) return { action: "cancel", eventId: live.id, reason: "pickup-corrected" }
  return { action: "reverse", eventId: live.id, draft: reversalOf(live) }
}

/** The action an event is worth, or undefined for an event that is news and not money. */
export function billableFor<Row extends PriceRow>(event: EventFacts<Row>, labels: PriceLabels = {}): BillableAction | undefined {
  switch (event.kind) {
    case "pickup-completed": {
      const draft = pickupDraft(event, labels)
      return draft === undefined ? undefined : { action: "record", draft }
    }
    case "pickup-corrected": {
      if (event.outcome === "completed") {
        // A pickup with a live event is already charged for; one without gets its event as a completion would.
        if (event.liveEvent !== null) return undefined
        const draft = pickupDraft(event, labels)
        return draft === undefined ? undefined : { action: "record", draft }
      }
      return correctionOf(event.liveEvent)
    }
    case "ticket-completed": {
      if (!isBillableResolution(event.resolution) || event.agreement === null) return undefined
      return {
        action: "record",
        draft: {
          kind: "ticket",
          serviceDate: event.closedOn,
          agreementId: event.agreement.id,
          subscriptionId: event.agreement.subscriptionId,
          productId: null,
          quantity: 1,
          price: null,
          blockReason: "no-product",
          links: { ...NO_LINKS, ticketId: event.ticketId },
        },
      }
    }
    default:
      return undefined
  }
}
