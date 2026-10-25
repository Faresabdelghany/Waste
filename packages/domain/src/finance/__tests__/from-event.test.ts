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
import { BILLABLE_RESOLUTIONS, billableFor, chargesJob, chargesTicketWork, isBillableResolution, PICKUP_EVENT_KINDS, reversalOf, type EventFacts, type JobChargeFacts, type LiveEventFacts, type PickupEventFacts, type PlacementFacts, type TicketChargeFacts, type TicketCompletedFacts } from "../from-event"
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
  origin: "generation",
  containerTypeId: BIN_240,
  wasteFractionId: RESIDUAL,
  outcome: "completed",
  placement: placement(),
  liveEvent: null,
  service: "empty",
  bookedForTicket: false,
  job: null,
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

const completedTicket = (values: Partial<TicketCompletedFacts> = {}): TicketCompletedFacts => ({ kind: "ticket-completed", ticketId: TICKET, resolution: "recollected", agreement: { id: AGREEMENT, subscriptionId: SUBSCRIPTION }, closedOn: "2026-10-07", charge: null, ...values })

/** The product a completed ticket charges for (#291 C3): the completion's, a per-job service at 25 %, under the reached agreement of an organisation, with the default list's two rows. */
const charge = (values: Partial<TicketChargeFacts> = {}): TicketChargeFacts => ({
  source: "completion",
  product: { id: PRODUCT, status: "active", unit: "job", vatPercent: 25 },
  agreement: { status: "active", customerKind: "organisation", customerId: CUSTOMER },
  priceList: { id: "list", currency: "DKK", rows: [row("everyone"), row("harbor", { planningAreaId: HARBOR, unitPriceMinor: 1_500 })] },
  ...values,
})

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

  test("under a month or a day product is nothing, whatever else the facts say: the collection is inside a recurring charge or a hire (M14 of #293)", () => {
    for (const unit of PRODUCT_UNITS) {
      const action = billableFor(pickupEvent("pickup-completed", { placement: placement({ product: { id: PRODUCT, unit, vatPercent: 25 } }) }))
      if (unit === "month" || unit === "day") assert.equal(action, undefined, unit)
      else assert.equal(action?.action, "record", unit)
    }
    // Even a month product under a draft agreement or without a list is nothing: the unit is judged first.
    assert.equal(billableFor(pickupEvent("pickup-completed", { placement: placement({ product: { id: PRODUCT, unit: "month", vatPercent: null }, priceList: null }) })), undefined)
    // But no placement at all is a block, since the product is not known.
    assert.equal(billableFor(pickupEvent("pickup-completed", { placement: null }))?.action, "record")
  })

  test("is nothing when the pickup no longer stands completed or already has a live event: a completion delivered late or twice charges once, and the correction that moved the pickup decides", () => {
    for (const outcome of PICKUP_OUTCOMES.filter((candidate) => candidate !== "completed")) {
      assert.equal(billableFor(pickupEvent("pickup-completed", { outcome })), undefined, `${outcome}: the correction's own event decides`)
    }
    assert.equal(billableFor(pickupEvent("pickup-completed", { liveEvent: live() })), undefined, "already charged for")
    assert.equal(billableFor(pickupEvent("pickup-completed", { liveEvent: live({ price: null }) })), undefined, "a blocked live event is still the pickup's event")
  })

  test("is nothing for a stop the office added (#111), a container's or an address-only one: the extra collection's billable event is a follow-up's to decide, never a pickup's charge", () => {
    assert.equal(billableFor(pickupEvent("pickup-completed", { origin: "office" })), undefined, "a container placed under a per-pickup product")
    assert.equal(billableFor(pickupEvent("pickup-completed", { origin: "office", containerTypeId: null, placement: null })), undefined, "an address-only stop, no placement and no block")
    assert.equal(billableFor(pickupEvent("pickup-corrected", { origin: "office", outcome: "completed" })), undefined, "a correction to completed records nothing either")
  })
})

describe("billableFor a completed work order (M14 of #293)", () => {
  const JOB = "delivery-job"
  /** The project's job product for the service: an active per-job product at 25 %, charged to the container's agreement on the default list's row. */
  const job = (values: Partial<JobChargeFacts> = {}): JobChargeFacts => ({
    product: { id: JOB, status: "active", unit: "job", vatPercent: 25 },
    agreement: { id: AGREEMENT, status: "active", customerKind: "organisation", customerId: CUSTOMER },
    subscriptionId: SUBSCRIPTION,
    priceList: { id: "list", currency: "DKK", rows: [row("delivery", { unitPriceMinor: 45_000 })] },
    ...values,
  })
  const office = (values: Partial<PickupEventFacts> = {}) => pickupEvent("pickup-completed", { origin: "office", service: "deliver", job: job(), ...values })

  test("is a job event of quantity one on the container's agreement, priced as a pickup is on the service date", () => {
    const action = billableFor(office())
    assert.equal(action?.action, "record")
    const draft = action?.action === "record" ? action.draft : undefined
    assert.deepEqual(
      [draft?.kind, draft?.quantity, draft?.agreementId, draft?.subscriptionId, draft?.productId, draft?.price?.unitPriceMinor, draft?.price?.vatMinor, draft?.blockReason, draft?.links.pickupId],
      ["job", 1, AGREEMENT, SUBSCRIPTION, JOB, 45_000, 11_250, null, PICKUP],
    )
    for (const service of ["remove", "swap", "repair", "wash"] as const) assert.equal(billableFor(office({ service }))?.action, "record", service)
  })

  test("is nothing for a stop booked to answer a ticket: the ticket's charge is the one, so exactly one live event comes of the work", () => {
    assert.equal(billableFor(office({ bookedForTicket: true })), undefined)
    assert.equal(billableFor(office({ bookedForTicket: true, kind: "pickup-corrected" })), undefined, "nor its correction to completed")
  })

  test("is nothing for an office emptying or a service the project prices nothing for, as before", () => {
    assert.equal(billableFor(office({ service: "empty" })), undefined)
    assert.equal(billableFor(office({ job: null })), undefined)
  })

  test("is blocked for the office where the product will not do or no agreement is reachable, never a silent charge or a silent nothing", () => {
    const blocked = (values: Partial<JobChargeFacts>) => {
      const action = billableFor(office({ job: job(values) }))
      return action?.action === "record" ? [action.draft.blockReason, action.draft.productId, action.draft.price] : undefined
    }
    assert.deepEqual(blocked({ product: { id: JOB, status: "inactive", unit: "job", vatPercent: 25 } }), ["no-product", null, null], "a retired product")
    assert.deepEqual(blocked({ product: { id: JOB, status: "active", unit: "month", vatPercent: 25 } }), ["no-product", null, null], "one not sold by the job")
    assert.deepEqual(blocked({ agreement: null, subscriptionId: null }), ["no-subscription", JOB, null], "no agreement reachable")
    assert.equal(chargesJob(job()), true)
  })

  test("is charged once: a completion of a work order that already has a live event is nothing, and its correction away from completed cancels it", () => {
    assert.equal(billableFor(office({ liveEvent: live() })), undefined)
    assert.deepEqual(billableFor(office({ kind: "pickup-corrected", outcome: "failed", liveEvent: live() })), { action: "cancel", eventId: LIVE, reason: "pickup-corrected" })
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

  test("with a product — the completion's or its kind's — is priced as a pickup is, on the day it closed, by the customer's conditions alone: no zone, no container type, no fraction (#291 C3)", () => {
    const ticketLinks = { routeId: null, pickupId: null, ticketId: TICKET, reversesEventId: null }
    assert.deepEqual(billableFor(completedTicket({ charge: charge() })), {
      action: "record",
      draft: {
        kind: "ticket",
        serviceDate: "2026-10-07",
        agreementId: AGREEMENT,
        subscriptionId: SUBSCRIPTION,
        productId: PRODUCT,
        quantity: 1,
        // The harbour row asks for a zone a ticket's event never names: the row for everyone wins.
        price: { priceListRowId: "everyone", unitPriceMinor: 1_000, netMinor: 1_000, vatPercent: 25, vatMinor: 250, currency: "DKK" },
        blockReason: null,
        links: ticketLinks,
      },
    })
    const blocked = (facts: TicketChargeFacts) => {
      const action = billableFor(completedTicket({ charge: facts }))
      return action?.action === "record" ? [action.draft.productId, action.draft.blockReason, action.draft.price] : action
    }
    // Each block keeps the product named, so a reprice once it is put right prices it.
    assert.deepEqual(blocked(charge({ agreement: { status: "draft", customerKind: "organisation", customerId: CUSTOMER } })), [PRODUCT, "agreement-draft", null])
    assert.deepEqual(blocked(charge({ priceList: null })), [PRODUCT, "no-price-list", null])
    assert.deepEqual(blocked(charge({ priceList: { id: "list", currency: "DKK", rows: [] } })), [PRODUCT, "no-price-row", null])
    assert.deepEqual(blocked(charge({ product: { id: PRODUCT, status: "active", unit: "job", vatPercent: null } })), [PRODUCT, "no-vat-rate", null])
    // A re-collection or a service only: an answered ticket with a product is still nothing.
    assert.equal(billableFor(completedTicket({ resolution: "answered", charge: charge() })), undefined)
  })

  test("takes the completion's product as named, its kind's only while it is offered, and never one sold by the month: otherwise no-product, the office's to price (#291 C3)", () => {
    const productOf = (facts: TicketChargeFacts) => {
      const action = billableFor(completedTicket({ charge: facts }))
      return action?.action === "record" ? [action.draft.productId, action.draft.blockReason] : action
    }
    const retired = { id: PRODUCT, status: "inactive" as const, unit: "job" as const, vatPercent: 25 }
    assert.deepEqual(productOf(charge({ source: "kind", product: retired })), [null, "no-product"], "a kind's product retired since it was mapped is never a silent charge")
    assert.deepEqual(productOf(charge({ source: "kind", product: { ...retired, status: "draft" } })), [null, "no-product"])
    assert.deepEqual(productOf(charge({ source: "kind" })), [PRODUCT, null])
    assert.deepEqual(productOf(charge({ source: "completion", product: retired })), [PRODUCT, null], "the person named it at completion, where the gate stood")
    for (const source of ["completion", "kind"] as const) {
      assert.deepEqual(productOf(charge({ source, product: { id: PRODUCT, status: "active", unit: "month", vatPercent: 25 } })), [null, "no-product"], `a month product is a recurring charge, never ticket work (${source})`)
      assert.deepEqual(productOf(charge({ source, product: { id: PRODUCT, status: "active", unit: "day", vatPercent: 25 } })), [null, "no-product"], `a day product is a hire, never ticket work (${source})`)
    }
    assert.equal(chargesTicketWork(charge({ product: { id: PRODUCT, status: "active", unit: "pickup", vatPercent: 25 } })), true, "a per-pickup product charges a re-collection")
  })

  test("with no agreement reachable is nothing: a ticket about nothing billable makes no money row; an agreement without a subscription still makes one", () => {
    assert.equal(billableFor(completedTicket({ agreement: null })), undefined)
    const bare = billableFor(completedTicket({ agreement: { id: AGREEMENT, subscriptionId: null } }))
    assert.equal(bare?.action === "record" ? bare.draft.subscriptionId : undefined, null)
    assert.equal(bare?.action === "record" ? bare.draft.agreementId : undefined, AGREEMENT)
  })

  test("for a ticket reopened since its completion was published — no resolution, no closing day as the worker read the row — is nothing: stale news, never a failure, its next completion its own event", () => {
    assert.equal(billableFor(completedTicket({ resolution: null, closedOn: null })), undefined)
    // The two go together under `ticket_closed_shape`; either alone is still nothing, since a day cannot be billed without a resolution nor a resolution without a day.
    assert.equal(billableFor(completedTicket({ resolution: null })), undefined)
    assert.equal(billableFor(completedTicket({ closedOn: null })), undefined)
    assert.equal(billableFor(completedTicket())?.action, "record", "and a ticket that stands completed records as before")
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
    assert.deepEqual(news, ["route-dispatched", "route-started", "route-completed", "route-cancelled", "route-reassigned", "pickup-failed", "pickup-skipped", "pickup-problem-reported", "unload-recorded", "command-rejected", "ticket-opened", "ticket-rejected", "invoice-issued", "settlement-closed", "application-decided"])
    assert.deepEqual([...PICKUP_EVENT_KINDS], ["pickup-completed", "pickup-corrected"])
  })
})
