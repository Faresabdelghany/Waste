// billableFor over the table of §3: every outbox kind, every pickup outcome,
// every ticket resolution and every product unit — a completed pickup under a
// per-pickup product is a priced event or a blocked one with the actionable
// reason, under a month product nothing; a corrected pickup cancels an
// uninvoiced event and reverses an invoiced one; a completed ticket with a
// billable resolution and a reachable agreement is a no-product event on the
// day it closed, and everything else is nothing.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { OUTBOX_KINDS, PICKUP_OUTCOMES, type OutboxKind } from "../../execution/vocabulary"
import { PRODUCT_UNITS } from "../../registry/vocabulary"
import { TICKET_RESOLUTIONS } from "../../resolution/vocabulary"
import { BILLABLE_RESOLUTIONS, billableFor, isBillableResolution, PICKUP_EVENT_KINDS, reversalOf, type EventFacts, type LiveEventFacts, type PickupEventFacts, type PlacementFacts, type TicketCompletedFacts } from "../from-event"
import type { PriceRow } from "../pricing"

const ROUTE = "route"
const PICKUP = "pickup"
const TICKET = "ticket"
const HARBOR = "harbor"
const BIN_240 = "bin-240"
const RESIDUAL = "residual"
const AGREEMENT = "agreement"
const SUBSCRIPTION = "subscription"
const PRODUCT = "product"
const CUSTOMER = "customer"
const LIVE = "live-event"
const DAY = "2026-10-05"

const row = (id: string, values: Partial<PriceRow> = {}): PriceRow => ({ id, unitPriceMinor: 1_000, planningAreaId: null, customerKind: null, containerTypeId: null, wasteFractionId: null, customerId: null, validFrom: "2026-01-01", validTo: null, ...values })

/** The placement valid on the day: an active agreement of an organisation, a per-pickup product at 25 %, the project's default list with a default row and a harbour row. */
const placement = (values: Partial<PlacementFacts> = {}): PlacementFacts => ({
  subscriptionId: SUBSCRIPTION,
  agreement: { id: AGREEMENT, status: "active", customerKind: "organisation", customerId: CUSTOMER },
  product: { id: PRODUCT, unit: "pickup", vatPercent: 25 },
  priceList: { id: "list", currency: "DKK", rows: [row("everyone"), row("harbor", { planningAreaId: HARBOR, unitPriceMinor: 1_500 })] },
  ...values,
})

/** A pickup's event with everything the worker could read, but for what a test overrides: a completed stop in the harbour with a placement and no live event. */
const pickupEvent = (kind: "pickup-completed" | "pickup-corrected", values: Partial<PickupEventFacts> = {}): PickupEventFacts => ({
  kind,
  routeId: ROUTE,
  pickupId: PICKUP,
  serviceDate: DAY,
  planningAreaId: HARBOR,
  containerTypeId: BIN_240,
  wasteFractionId: RESIDUAL,
  outcome: "completed",
  placement: placement(),
  liveEvent: null,
  ...values,
})

/** The pickup's live event as the worker read it: priced, on an invoice or not. */
const live = (values: Partial<LiveEventFacts> = {}): LiveEventFacts => ({
  id: LIVE,
  agreementId: AGREEMENT,
  subscriptionId: SUBSCRIPTION,
  productId: PRODUCT,
  quantity: 1,
  price: { priceListRowId: "harbor", unitPriceMinor: 1_500, netMinor: 1_500, vatPercent: 25, vatMinor: 375, currency: "DKK" },
  serviceDate: DAY,
  invoiced: false,
  ...values,
})

const completedTicket = (values: Partial<TicketCompletedFacts> = {}): TicketCompletedFacts => ({ kind: "ticket-completed", ticketId: TICKET, resolution: "recollected", agreement: { id: AGREEMENT, subscriptionId: SUBSCRIPTION }, closedOn: "2026-10-07", ...values })

const links = { routeId: ROUTE, pickupId: PICKUP, ticketId: null, reversesEventId: null }

describe("billableFor a completed pickup", () => {
  test("under a per-pickup product with a placement, a signed agreement, a list, a row and a rate is a pickup event of quantity one, priced by the resolver on the service date, the winning row traceable", () => {
    assert.deepEqual(billableFor(pickupEvent("pickup-completed")), {
      action: "record",
      draft: {
        kind: "pickup",
        serviceDate: DAY,
        agreementId: AGREEMENT,
        subscriptionId: SUBSCRIPTION,
        productId: PRODUCT,
        quantity: 1,
        price: { priceListRowId: "harbor", unitPriceMinor: 1_500, netMinor: 1_500, vatPercent: 25, vatMinor: 375, currency: "DKK" },
        blockReason: null,
        links,
      },
    })
    // Off the harbour the default row wins; a `job` unit is one event like a pickup.
    const central = billableFor(pickupEvent("pickup-completed", { planningAreaId: null, placement: placement({ product: { id: PRODUCT, unit: "job", vatPercent: 25 } }) }))
    assert.equal(central?.action === "record" ? central.draft.price?.priceListRowId : undefined, "everyone")
  })

  test("is blocked with the actionable reason: no placement valid on the day, an unsigned agreement, no list, no row, no rate — the references kept where they are known", () => {
    const blocked = (values: Partial<PickupEventFacts>) => {
      const action = billableFor(pickupEvent("pickup-completed", values))
      assert.equal(action?.action, "record")
      return action?.action === "record" ? action.draft : undefined
    }
    assert.deepEqual(blocked({ placement: null }), { kind: "pickup", serviceDate: DAY, agreementId: null, subscriptionId: null, productId: null, quantity: 1, price: null, blockReason: "no-subscription", links })
    const draft = blocked({ placement: placement({ agreement: { id: AGREEMENT, status: "draft", customerKind: "organisation", customerId: CUSTOMER } }) })
    assert.deepEqual([draft?.blockReason, draft?.agreementId, draft?.subscriptionId, draft?.productId, draft?.price], ["agreement-draft", AGREEMENT, SUBSCRIPTION, PRODUCT, null])
    assert.equal(blocked({ placement: placement({ priceList: null }) })?.blockReason, "no-price-list")
    assert.equal(blocked({ placement: placement({ priceList: { id: "list", currency: "DKK", rows: [row("glass", { wasteFractionId: "glass" })] } }) })?.blockReason, "no-price-row")
    assert.equal(blocked({ placement: placement({ product: { id: PRODUCT, unit: "pickup", vatPercent: null } }) })?.blockReason, "no-vat-rate")
  })

  test("under a month product is nothing, whatever else the facts say: the collection is inside a recurring charge", () => {
    for (const unit of PRODUCT_UNITS) {
      const action = billableFor(pickupEvent("pickup-completed", { placement: placement({ product: { id: PRODUCT, unit, vatPercent: 25 } }) }))
      if (unit === "month") assert.equal(action, undefined, unit)
      else assert.equal(action?.action, "record", unit)
    }
    // Even a month product under a draft agreement or without a list is nothing: the unit is judged first.
    assert.equal(billableFor(pickupEvent("pickup-completed", { placement: placement({ product: { id: PRODUCT, unit: "month", vatPercent: null }, priceList: null }) })), undefined)
    // But no placement at all is a block, since the product is not known.
    assert.equal(billableFor(pickupEvent("pickup-completed", { placement: null }))?.action, "record")
  })
})

describe("billableFor a corrected pickup", () => {
  test("to completed is a pickup event as a completion would be when the pickup has no live event, and nothing when it has one", () => {
    const fresh = billableFor(pickupEvent("pickup-corrected", { outcome: "completed" }))
    assert.deepEqual(fresh, billableFor(pickupEvent("pickup-completed")))
    assert.equal(billableFor(pickupEvent("pickup-corrected", { outcome: "completed", liveEvent: live() })), undefined, "already charged for")
    assert.equal(billableFor(pickupEvent("pickup-corrected", { outcome: "completed", liveEvent: live({ price: null }) })), undefined, "a blocked live event is still the pickup's event")
  })

  test("to skipped or failed cancels the live event with the consumer's reason when no line names it, reverses it when one does, and does nothing without one", () => {
    for (const outcome of PICKUP_OUTCOMES.filter((candidate) => candidate !== "completed")) {
      assert.deepEqual(billableFor(pickupEvent("pickup-corrected", { outcome, liveEvent: live() })), { action: "cancel", eventId: LIVE, reason: "pickup-corrected" }, outcome)
      assert.deepEqual(billableFor(pickupEvent("pickup-corrected", { outcome, liveEvent: live({ invoiced: true }) })), { action: "reverse", eventId: LIVE, draft: reversalOf(live({ invoiced: true })) }, outcome)
      assert.equal(billableFor(pickupEvent("pickup-corrected", { outcome, liveEvent: null })), undefined, `${outcome} with nothing live`)
      // A blocked live event is cancelled like a ready one: there was nothing to invoice.
      assert.deepEqual(billableFor(pickupEvent("pickup-corrected", { outcome, liveEvent: live({ price: null }) })), { action: "cancel", eventId: LIVE, reason: "pickup-corrected" })
    }
  })

  test("the reversal copies the original's agreement, product, quantity, unit price, rate and currency, negates the net and the VAT, names the original on its service date, and carries no row", () => {
    assert.deepEqual(reversalOf(live({ invoiced: true, quantity: 2, price: { priceListRowId: "harbor", unitPriceMinor: 1_500, netMinor: 3_000, vatPercent: 25, vatMinor: 750, currency: "DKK" }, serviceDate: "2026-09-01" })), {
      kind: "reversal",
      serviceDate: "2026-09-01",
      agreementId: AGREEMENT,
      subscriptionId: SUBSCRIPTION,
      productId: PRODUCT,
      quantity: 2,
      price: { priceListRowId: null, unitPriceMinor: 1_500, netMinor: -3_000, vatPercent: 25, vatMinor: -750, currency: "DKK" },
      blockReason: null,
      links: { routeId: null, pickupId: null, ticketId: null, reversesEventId: LIVE },
    })
    // A reversal of nothing to reverse is a bug: a blocked event is cancelled, never reversed.
    assert.throws(() => reversalOf(live({ price: null })), /reversalOf: event live-event carries no price; a blocked event is cancelled, never reversed/)
    // A zero-priced original reverses to zero, never to -0.
    const zero = reversalOf(live({ price: { priceListRowId: "free", unitPriceMinor: 0, netMinor: 0, vatPercent: 25, vatMinor: 0, currency: "DKK" } }))
    assert.ok(Object.is(zero.price?.netMinor, 0) && Object.is(zero.price?.vatMinor, 0))
  })
})

describe("billableFor a completed ticket", () => {
  test("with recollected or serviced and a reachable agreement is a ticket event with no product and no-product for the office to price, on the day it closed", () => {
    for (const resolution of TICKET_RESOLUTIONS) {
      const action = billableFor(completedTicket({ resolution }))
      if (isBillableResolution(resolution)) {
        assert.deepEqual(
          action,
          {
            action: "record",
            draft: { kind: "ticket", serviceDate: "2026-10-07", agreementId: AGREEMENT, subscriptionId: SUBSCRIPTION, productId: null, quantity: 1, price: null, blockReason: "no-product", links: { routeId: null, pickupId: null, ticketId: TICKET, reversesEventId: null } },
          },
          resolution,
        )
      } else {
        assert.equal(action, undefined, resolution)
      }
    }
    assert.deepEqual([...BILLABLE_RESOLUTIONS], ["recollected", "serviced"])
    assert.equal(isBillableResolution("toString" as never), false, "a resolution outside the list finds nothing: the lookup is the list's, not a prototype's")
  })

  test("with no agreement reachable is nothing: a ticket about nothing billable makes no money row; an agreement without a subscription still makes one", () => {
    assert.equal(billableFor(completedTicket({ agreement: null })), undefined)
    const bare = billableFor(completedTicket({ agreement: { id: AGREEMENT, subscriptionId: null } }))
    assert.equal(bare?.action === "record" ? bare.draft.subscriptionId : undefined, null)
    assert.equal(bare?.action === "record" ? bare.draft.agreementId : undefined, AGREEMENT)
  })
})

describe("billableFor every other kind", () => {
  test("is nothing: the route's own events, the other pickup events, the unload, the ticket's opening and rejection and Finance's own two publishes", () => {
    const money: OutboxKind[] = []
    const news: OutboxKind[] = []
    for (const kind of OUTBOX_KINDS) {
      const event: EventFacts = (PICKUP_EVENT_KINDS as readonly string[]).includes(kind) ? pickupEvent(kind as "pickup-completed" | "pickup-corrected") : kind === "ticket-completed" ? completedTicket() : ({ kind } as EventFacts)
      ;(billableFor(event) === undefined ? news : money).push(kind)
    }
    assert.deepEqual(money, ["pickup-completed", "pickup-corrected", "ticket-completed"])
    assert.deepEqual(news, ["route-dispatched", "route-started", "route-completed", "route-cancelled", "route-reassigned", "pickup-failed", "pickup-skipped", "pickup-problem-reported", "unload-recorded", "command-rejected", "ticket-opened", "ticket-rejected", "invoice-issued", "settlement-closed"])
    assert.deepEqual([...PICKUP_EVENT_KINDS], ["pickup-completed", "pickup-corrected"])
  })
})
