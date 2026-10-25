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
// event on the day the ticket closed on the project's clock — the worker
// renders the day, since this module has no clock and no timezone — when an
// agreement is reachable through the ticket or its pickup's placement, and
// nothing otherwise: a ticket about nothing billable makes no money row; and
// nothing again for a ticket `reopen`ed since — its resolution and closing
// day cleared, the completion stale news, its next completion its own event.
// Its product (#291 C3) is the one the completion named, else the project's
// for the ticket's kind while that one is offered — a retired one is the
// office's to replace, never a silent charge — and never one sold by the
// month, which is a recurring charge (`chargesTicketWork`); priced by the
// resolver as a pickup is, by the customer's conditions alone, since a
// ticket's event names no zone, container type or fraction and `reprice`
// prices it the same way; with none, `no-product` for the office to price.
// `answered`, `no-action` and `duplicate`, the route's events, the other
// pickup events, the unload and the two Finance publishes are nothing here.
// A credit for a missed collection is never the consumer's (§7.11), and a
// stop the office added (#111, `origin = office`) — a re-collection, a
// container put on a route by hand, an address-only stop — is no pickup
// charge either: its completion and its correction to `completed` are
// nothing here, the extra collection's billable event being a follow-up's.
// A work order the office booked (M14 of #293: a delivery, a removal, a swap,
// a repair, a wash) is a `job` event where its project names a product for
// the service (`work_order_product`), charged to the container's agreement —
// a delivery's the stop's subscription's — and priced as a pickup is; nothing
// where the project names none, as before; never where the stop was booked to
// answer a ticket (O3c of #290), whose completion the ticket's charge (#291 C3)
// already is; and blocked where the product is retired or not sold by the job
// (`no-product`) or no agreement is reachable (`no-subscription`), for the
// office to act on rather than a silent charge or a silent nothing.
//
// Two of the facts are the table's word and not the payload's, because
// pg-boss delivers at least once and in no promised order (part B): the
// `outcome` is the pickup's status as the worker read it beside the payload,
// and `liveEvent` is read for a completion as for a correction. So a
// `pickup-completed` whose pickup no longer stands `completed` — a correction
// has moved it since, and that correction's own event decides — is stale news
// and records nothing, and a completion of a pickup that already has a live
// event is nothing too: the pickup is charged for once, whichever of its
// events arrives first or twice.
//
// A pickup's event is worth two charges since #293 M5: its collection, as
// above, and its Pickup Exception — a stop missed for a reason the customer
// caused, or collected but tagged with a contaminant code — which its
// project's rules may charge (execution/pickup-exceptions.ts judges the rule,
// the count of earlier matches at the place and the ladder's step; the worker
// hands the judgement here with the step's product priced as any is). The
// two are judged apart, so `billableActionsFor` answers the collection's
// action, then the exception's. An exception is a `pickup-exception` event of
// quantity one, named with its stop and the proof that recorded it, priced on
// the service date under the placement's agreement or blocked
// (`no-subscription` with no placement), and nothing while free. The driver's
// `pickup-failed`, `pickup-skipped` and `pickup-completed` record it once,
// where none is live — stale news where the stop has moved since, the
// correction's own event deciding. A `pickup-corrected` leaves a live charge
// standing where the stop is still charged at the same step, and otherwise
// cancels it (or reverses it, once invoiced) and records the step it is
// charged at now, if any: the ladder is judged once, at each stop's own
// event, and a correction of one stop never re-steps another's.
//
// What the draft does not carry is the writer's: `createdBy` null,
// `sourceEventId` the event's id (`billable_event_origin_shape` ties the two),
// the stamps, and the row's own id.
import type { PickupExceptionJudgement } from "../execution/pickup-exceptions"
import { isWorkOrderService, type OutboxKind, type PickupOrigin, type PickupOutcome, type PickupService } from "../execution/vocabulary"
import type { AgreementStatus, CustomerKind, ProductStatus, ProductUnit } from "../registry/vocabulary"
import { isBillableResolution, type TicketResolution } from "../resolution/vocabulary"
import { HIRE_UNIT } from "./hire"
import { priceOccurrence, type PriceLabels, type PricedAmounts, type PricedList, type PriceRow } from "./pricing"
import { RECURRING_UNIT } from "./recurring"
import type { BillableEventKind, BlockReason, CancelReason } from "./vocabulary"

/** The events about a pickup that Finance reads: a missed stop's two (#293 M5) beside the completion and the correction. */
export const PICKUP_EVENT_KINDS = ["pickup-completed", "pickup-corrected", "pickup-failed", "pickup-skipped"] as const satisfies readonly OutboxKind[]
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
  /** What the event was under; null with the price on an event blocked `no-subscription`, which a correction cancels and never reverses. */
  agreementId: string | null
  subscriptionId: string | null
  productId: string | null
  quantity: number
  /** The frozen price, or null while the event is blocked. */
  price: PricedAmounts | null
  serviceDate: string
  invoiced: boolean
}

/** A Pickup Exception as the worker judged it (#293 M5): what its project's rules say of the stop now, the proof that recorded it, and the step's product priced as any product is. */
export type ExceptionFacts<Row extends PriceRow = PriceRow> = {
  /** `judgeException`'s answer: the rule, the earlier matches at the place, and the ladder's product, null while free; null where no rule governs the stop. */
  judgement: PickupExceptionJudgement | null
  /** The proof that recorded the outcome — the driver's completion, skip or failure, or the office's correction — the charge's evidence. */
  evidenceProofId: string | null
  /** The step's product with its rows on the list the placement's agreement is priced under on the service date; null while free, or with no placement to price under. */
  charge: { product: { id: string; unit: ProductUnit; vatPercent: number | null }; priceList: PricedList<Row> | null } | null
}

/** A pickup's event as the worker reads it: the payload's fields, the outcome a correction gave, and what it read beside them. */
export type PickupEventFacts<Row extends PriceRow = PriceRow> = {
  kind: PickupEventKind
  routeId: string
  pickupId: string
  /** The route's service date, `YYYY-MM-DD`: the identity day, never the operating date. */
  serviceDate: string
  /** The route's scheme's planning area, the price row's zone; null for a scheme without one, and for the office's ad-hoc route, which has no scheme (#111). */
  planningAreaId: string | null
  /** Who put the stop on its route (#111): an office stop's collection is no pickup event of the consumer's. */
  origin: PickupOrigin
  /** The container's type; null for an address-only stop, which names no container (#111). */
  containerTypeId: string | null
  /** The pickup's fraction on the day. */
  wasteFractionId: string
  /** The pickup's status as the worker read it beside the payload — the table's word now, not the payload's then: `completed` on a completion still standing, the outcome a correction gave. */
  outcome: PickupOutcome
  /** The placement of the container valid on the service date, or null when none was. */
  placement: PlacementFacts<Row> | null
  /** The pickup's live event, or null when it has none. */
  liveEvent: LiveEventFacts | null
  /** The stop's service: an emptying, or a work order the office booked (O3 of #290). */
  service: PickupService
  /** Whether the stop was booked to answer a ticket (O3c of #290): the ticket's charge is the one, never a job's. */
  bookedForTicket: boolean
  /** The `job` product the project names for a work order's service, with the agreement it charges and its pricing (M14 of #293); null where the project names none. */
  job: JobChargeFacts<Row> | null
  /** The stop as a Pickup Exception (#293 M5); null where it is none the rules may charge. */
  exception: ExceptionFacts<Row> | null
  /** The pickup's live exception charge, or null. */
  liveException: LiveEventFacts | null
}

/** A work order's charge as the worker read it: the project's product for the service, and the agreement it charges — the container's, a delivery's the stop's subscription's — with its pricing, null where none is reachable. */
export type JobChargeFacts<Row extends PriceRow = PriceRow> = {
  product: { id: string; status: ProductStatus; unit: ProductUnit; vatPercent: number | null }
  agreement: { id: string; status: AgreementStatus; customerKind: CustomerKind; customerId: string } | null
  subscriptionId: string | null
  /** The list that agreement is priced under, with its rows for the product on the service date; null where neither the agreement nor the project names one. */
  priceList: PricedList<Row> | null
}

/** The product a completed ticket charges for, as the worker read it (#291 C3), with what its price is resolved from. */
export type TicketChargeFacts<Row extends PriceRow = PriceRow> = {
  /** Who named it: the person who completed the ticket, or the project's charge for the ticket's kind. */
  source: "completion" | "kind"
  product: { id: string; status: ProductStatus; unit: ProductUnit; vatPercent: number | null }
  /** The agreement the ticket reaches, as the resolver reads it. */
  agreement: { status: AgreementStatus; customerKind: CustomerKind; customerId: string }
  /** The list that agreement is priced under, with its rows for the product on the day the ticket closed; null when neither the agreement nor the project names one. */
  priceList: PricedList<Row> | null
}

/** A completed ticket as the worker reads it: what it ended in, the agreement it reaches, the day it closed on the project's clock, and the product it charges for — or, for a ticket reopened since its completion was published, no resolution and no day, which is stale news and nothing here. */
export type TicketCompletedFacts<Row extends PriceRow = PriceRow> = {
  kind: "ticket-completed"
  ticketId: string
  /** The ticket's resolution as it stands now; null once `reopen` cleared it, which makes the completion stale news. */
  resolution: TicketResolution | null
  /** The ticket's own agreement, or the one its pickup's placement ran under on the route's service date, with that placement's subscription; null when none is reachable. */
  agreement: { id: string; subscriptionId: string | null } | null
  /** The ticket's `closedAt` rendered as a `YYYY-MM-DD` day in the project's timezone by the worker: this module has no clock and no timezone. Null where the ticket stands open again and has no closing instant. */
  closedOn: string | null
  /** The product the completion named, else the project's for the ticket's kind, with its pricing; null where neither names one or no agreement is reachable. */
  charge: TicketChargeFacts<Row> | null
}

/** Every other event, which this module reads the kind of and nothing else. */
export type OtherEventFacts = { kind: Exclude<OutboxKind, PickupEventKind | "ticket-completed"> }

/** An outbox event as the worker hands it here: the kind, and the plain facts that kind's payload and the reads beside it give. */
export type EventFacts<Row extends PriceRow = PriceRow> = PickupEventFacts<Row> | TicketCompletedFacts<Row> | OtherEventFacts

/** What a billable event links to: the ids the event named, each null where it named none. */
export type BillableEventLinks = {
  routeId: string | null
  pickupId: string | null
  ticketId: string | null
  reversesEventId: string | null
  /** The proof a Pickup Exception's charge is evidenced by (#293 M5); null on every other kind. */
  proofId: string | null
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

export { BILLABLE_RESOLUTIONS, isBillableResolution } from "../resolution/vocabulary"

/** Whether a product is charged by its period, never per occurrence: a recurring charge's month (#291 C2), a hire's day (M14 of #293). */
const chargedByPeriod = (unit: ProductUnit): boolean => unit === RECURRING_UNIT || unit === HIRE_UNIT

/** Whether a ticket's work may be charged at the product (#291 C3): never one sold by the month or the day, which a billing run charges by its period; the completion's as the person named it; the kind's only while it is offered, a retired one being the office's to replace. */
export const chargesTicketWork = (charge: TicketChargeFacts): boolean => !chargedByPeriod(charge.product.unit) && (charge.source === "completion" || charge.product.status === "active")

const NO_LINKS: BillableEventLinks = { routeId: null, pickupId: null, ticketId: null, reversesEventId: null, proofId: null }

/** Whether a work order may be charged at the project's product: one sold by the job, while it is offered — a retired one is the office's to replace, never a silent charge. */
export const chargesJob = (job: JobChargeFacts): boolean => job.product.unit === "job" && job.product.status === "active"

/** A completed work order's event (M14 of #293): nothing for an emptying, a stop booked for a ticket or a service the project prices nothing for; blocked where the product will not do or no agreement is reachable; otherwise priced by the resolver as a pickup is. */
function jobDraft<Row extends PriceRow>(facts: PickupEventFacts<Row>, labels: PriceLabels): BillableEventDraft | undefined {
  if (!isWorkOrderService(facts.service) || facts.bookedForTicket || facts.job === null) return undefined
  const { job } = facts
  const base = { kind: "job" as const, serviceDate: facts.serviceDate, quantity: 1, links: { ...NO_LINKS, routeId: facts.routeId, pickupId: facts.pickupId } }
  // The agreement first, as a pickup's placement is: with none reachable a product would price under nothing, so the block says what to fix.
  if (job.agreement === null) return { ...base, agreementId: null, subscriptionId: null, productId: chargesJob(job) ? job.product.id : null, price: null, blockReason: "no-subscription" }
  if (!chargesJob(job)) return { ...base, agreementId: job.agreement.id, subscriptionId: job.subscriptionId, productId: null, price: null, blockReason: "no-product" }
  const outcome = priceOccurrence(
    {
      agreement: { status: job.agreement.status },
      priceList: job.priceList,
      product: job.product,
      quantity: 1,
      input: {
        on: facts.serviceDate,
        planningAreaId: facts.planningAreaId,
        customerKind: job.agreement.customerKind,
        containerTypeId: facts.containerTypeId,
        wasteFractionId: facts.wasteFractionId,
        customerId: job.agreement.customerId,
      },
    },
    labels,
  )
  return { ...base, agreementId: job.agreement.id, subscriptionId: job.subscriptionId, productId: job.product.id, price: outcome.price, blockReason: outcome.blockReason }
}

/** A completed pickup's event: a work order's job for a stop the office added, blocked with `no-subscription` where no placement was valid, nothing under a `month` product, otherwise priced by the resolver or blocked with the reason that stood in the way. */
function pickupDraft<Row extends PriceRow>(facts: PickupEventFacts<Row>, labels: PriceLabels): BillableEventDraft | undefined {
  // The office's extra collection (#111) — a re-collection, a container added to a route, an address-only stop — is not a pickup charge; its billable event is the follow-up's. Its work order is a job (M14 of #293).
  if (facts.origin === "office") return jobDraft(facts, labels)
  const links: BillableEventLinks = { ...NO_LINKS, routeId: facts.routeId, pickupId: facts.pickupId }
  const base = { kind: "pickup" as const, serviceDate: facts.serviceDate, quantity: 1, links }
  const placement = facts.placement
  if (placement === null) return { ...base, agreementId: null, subscriptionId: null, productId: null, price: null, blockReason: "no-subscription" }
  // The collection is inside a recurring charge or a hire (M14 of #293), which a billing run bills by its period; a `job` is one event like a `pickup`.
  if (chargedByPeriod(placement.product.unit)) return undefined
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

/** The outcome each of the driver's events reports; a correction's is whatever it gave. */
const OUTCOME_REPORTED: Readonly<Record<PickupEventKind, PickupOutcome | null>> = { "pickup-completed": "completed", "pickup-failed": "failed", "pickup-skipped": "skipped", "pickup-corrected": null }

const isPickupEvent = <Row extends PriceRow>(event: EventFacts<Row>): event is PickupEventFacts<Row> => (PICKUP_EVENT_KINDS as readonly string[]).includes(event.kind)

/** A Pickup Exception's charge at the step the rules judged: nothing while free or ungoverned, blocked `no-subscription` with no placement, otherwise priced on the service date under the placement's agreement. */
function exceptionDraft<Row extends PriceRow>(event: PickupEventFacts<Row>, labels: PriceLabels): BillableEventDraft | undefined {
  const exception = event.exception
  const judgement = exception?.judgement ?? null
  if (exception === null || judgement === null || judgement.free || judgement.productId === null) return undefined
  const links: BillableEventLinks = { ...NO_LINKS, routeId: event.routeId, pickupId: event.pickupId, proofId: exception.evidenceProofId }
  const base = { kind: "pickup-exception" as const, serviceDate: event.serviceDate, quantity: 1, links }
  const placement = event.placement
  if (placement === null) return { ...base, agreementId: null, subscriptionId: null, productId: judgement.productId, price: null, blockReason: "no-subscription" }
  const charge = exception.charge
  if (charge === null) return { ...base, agreementId: placement.agreement.id, subscriptionId: placement.subscriptionId, productId: null, price: null, blockReason: "no-product" }
  const outcome = priceOccurrence(
    {
      agreement: { status: placement.agreement.status },
      priceList: charge.priceList,
      product: charge.product,
      quantity: 1,
      input: {
        on: event.serviceDate,
        planningAreaId: event.planningAreaId,
        customerKind: placement.agreement.customerKind,
        containerTypeId: event.containerTypeId,
        wasteFractionId: event.wasteFractionId,
        customerId: placement.agreement.customerId,
      },
    },
    labels,
  )
  return { ...base, agreementId: placement.agreement.id, subscriptionId: placement.subscriptionId, productId: charge.product.id, price: outcome.price, blockReason: outcome.blockReason }
}

/** What a pickup's event does to its exception charge: records it once from the driver's event; on a correction, keeps it at the same step, else undoes it and records the step charged now. */
function exceptionActionsFor<Row extends PriceRow>(event: PickupEventFacts<Row>, labels: PriceLabels): BillableAction[] {
  const reported = OUTCOME_REPORTED[event.kind]
  // Stale news: the stop has moved since the driver's event, and the correction's own event decides.
  if (reported !== null && event.outcome !== reported) return []
  const draft = exceptionDraft(event, labels)
  const live = event.liveException
  if (live === null) return draft === undefined ? [] : [{ action: "record", draft }]
  // Already charged: the driver's event arriving again or after the correction, or a correction that leaves the step as it was.
  if (event.kind !== "pickup-corrected" || (draft !== undefined && draft.productId === live.productId)) return []
  const undone = correctionOf(live)
  return [...(undone === undefined ? [] : [undone]), ...(draft === undefined ? [] : [{ action: "record" as const, draft }])]
}

/** Every action an event is worth, in order: a pickup's collection charge, then its exception charge (#293 M5); for any other event its one action, or none. */
export function billableActionsFor<Row extends PriceRow>(event: EventFacts<Row>, labels: PriceLabels = {}): BillableAction[] {
  const first = billableFor(event, labels)
  return [...(first === undefined ? [] : [first]), ...(isPickupEvent(event) ? exceptionActionsFor(event, labels) : [])]
}

/** The action an event is worth, or undefined for an event that is news and not money: a pickup's collection, a ticket's work. */
export function billableFor<Row extends PriceRow>(event: EventFacts<Row>, labels: PriceLabels = {}): BillableAction | undefined {
  switch (event.kind) {
    case "pickup-completed": {
      // Stale news: a correction moved the pickup since, and its own event decides. Already charged for: the pickup's live event stands, whichever of its events arrived first.
      if (event.outcome !== "completed" || event.liveEvent !== null) return undefined
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
      // Stale news: the ticket was reopened after its completion was published, and stands open with no resolution and no closing day; its next completion is its own event.
      if (event.resolution === null || event.closedOn === null) return undefined
      if (!isBillableResolution(event.resolution) || event.agreement === null) return undefined
      const base = { kind: "ticket" as const, serviceDate: event.closedOn, agreementId: event.agreement.id, subscriptionId: event.agreement.subscriptionId, quantity: 1, links: { ...NO_LINKS, ticketId: event.ticketId } }
      const { charge } = event
      if (charge === null || !chargesTicketWork(charge)) return { action: "record", draft: { ...base, productId: null, price: null, blockReason: "no-product" } }
      const outcome = priceOccurrence(
        {
          agreement: { status: charge.agreement.status },
          priceList: charge.priceList,
          product: charge.product,
          quantity: 1,
          input: { on: event.closedOn, planningAreaId: null, customerKind: charge.agreement.customerKind, containerTypeId: null, wasteFractionId: null, customerId: charge.agreement.customerId },
        },
        labels,
      )
      return { action: "record", draft: { ...base, productId: charge.product.id, price: outcome.price, blockReason: outcome.blockReason } }
    }
    default:
      return undefined
  }
}
