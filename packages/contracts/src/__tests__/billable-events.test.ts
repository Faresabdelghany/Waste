import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { BILLABLE_EVENT_STATUSES, BLOCK_REASONS } from "@waste/domain/finance/vocabulary"

import { BillableEvent, BillableEventCancel, BillableEventCreate, BillableEventLinks, BillableEventListQuery, BillableEventReprice, OVERRIDE_WITH_A_REASON, overrideWithAReason } from "../billable-events"
import { DAY_WINDOW_ORDERED } from "../queries"
import { refusal, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const STAMPS = { createdAt: "2026-10-05T18:00:00.000Z", updatedAt: "2026-10-05T18:00:00.000Z" }
const WHEN = "2026-10-06T09:00:00.000Z"

const links = { routeId: OTHER, pickupId: THIRD, ticketId: null, reversesEventId: null }

/** The consumer's priced pickup event: no person, the outbox event's id, the winning row traceable, ready. */
const event = {
  id: ID,
  projectId: OTHER,
  kind: "pickup",
  status: "ready",
  serviceDate: "2026-10-05",
  agreementId: THIRD,
  subscriptionId: OTHER,
  productId: ID,
  quantity: 1,
  unitPriceMinor: 12_345,
  netMinor: 12_345,
  vatPercent: 25,
  vatMinor: 3_086,
  currency: "DKK",
  priceListRowId: THIRD,
  blockReason: null,
  links,
  sourceEventId: OTHER,
  createdBy: null,
  overrideReason: null,
  note: null,
  cancelledAt: null,
  cancelledBy: null,
  cancelReason: null,
  invoiceLineId: null,
  ...STAMPS,
}

describe("BillableEvent", () => {
  test("is the occurrence on the wire: its kind and its reading, what it was under, the frozen price, the winning row, the links, its origin and its stamps", () => {
    assert.deepEqual(BillableEvent.parse(event), event)
    assert.equal(Object.keys(BillableEventLinks.shape).length, 4)
  })

  test("parses each shape a row takes: blocked with the five price columns null, a manual event with a person's price and reason, a ticket's event awaiting its product, a reversal with negative amounts, a cancelled and an invoiced one", () => {
    const blocked = { ...event, status: "blocked", agreementId: null, subscriptionId: null, productId: null, unitPriceMinor: null, netMinor: null, vatPercent: null, vatMinor: null, currency: null, priceListRowId: null, blockReason: "no-subscription" }
    assert.deepEqual(BillableEvent.parse(blocked), blocked)
    const manual = { ...event, kind: "manual", links: { routeId: null, pickupId: null, ticketId: null, reversesEventId: null }, sourceEventId: null, createdBy: OTHER, priceListRowId: null, overrideReason: "Agreed by phone", note: "Extra lift" }
    assert.deepEqual(BillableEvent.parse(manual), manual)
    const ticket = { ...blocked, kind: "ticket", agreementId: THIRD, links: { routeId: null, pickupId: null, ticketId: OTHER, reversesEventId: null }, blockReason: "no-product" }
    assert.deepEqual(BillableEvent.parse(ticket), ticket)
    const reversal = { ...event, kind: "reversal", netMinor: -12_345, vatMinor: -3_086, priceListRowId: null, links: { routeId: null, pickupId: null, ticketId: null, reversesEventId: ID }, sourceEventId: THIRD }
    assert.deepEqual(BillableEvent.parse(reversal), reversal)
    const cancelled = { ...event, status: "cancelled", cancelledAt: WHEN, cancelledBy: OTHER, cancelReason: "duplicate" }
    assert.deepEqual(BillableEvent.parse(cancelled), cancelled)
    const invoiced = { ...event, status: "invoiced", invoiceLineId: THIRD }
    assert.deepEqual(BillableEvent.parse(invoiced), invoiced)
    for (const status of BILLABLE_EVENT_STATUSES) assert.equal(BillableEvent.safeParse({ ...event, status }).success, true, status)
    for (const blockReason of BLOCK_REASONS) assert.equal(BillableEvent.safeParse({ ...blocked, blockReason }).success, true, blockReason)
  })

  test("holds every enum to its vocabulary, the quantity above zero, the amounts to whole minor units of either sign, and the rate to a whole number", () => {
    for (const [field, value] of [
      ["kind", "credit"],
      ["status", "In progress"],
      ["blockReason", "missing-payer"],
      ["cancelReason", "mistake"],
      ["quantity", 0],
      ["unitPriceMinor", 12.5],
      ["netMinor", "12345"],
      ["vatPercent", 25.5],
      ["currency", "kr"],
      ["serviceDate", "2026-10-05T00:00:00Z"],
    ] as const) {
      assert.deepEqual(refusal(BillableEvent.safeParse({ ...event, [field]: value })).map((issue) => issue.path), [field], field)
    }
    assert.equal(BillableEvent.safeParse({ ...event, unitPriceMinor: -100, netMinor: -100, vatMinor: -25 }).success, true, "a reversal's amounts are negative")
    assert.deepEqual(refusal(BillableEvent.safeParse({ ...event, links: { ...links, pickupId: "pickup-1" } })).map((issue) => issue.path), ["links.pickupId"])
  })
})

describe("BillableEventCreate", () => {
  const body = { projectId: OTHER, agreementId: THIRD, productId: ID, quantity: 1, serviceDate: "2026-10-05" }

  test("takes the agreement, the product, a quantity, a service date and a note, and either the resolver's price or a person's with its reason", () => {
    assert.deepEqual(BillableEventCreate.parse(body), body)
    const own = { ...body, unitPriceMinor: 10_000, overrideReason: "Agreed by phone", note: "Extra lift" }
    assert.deepEqual(BillableEventCreate.parse(own), own)
    assert.equal(BillableEventCreate.parse({ ...body, unitPriceMinor: 0, overrideReason: "Goodwill" }).unitPriceMinor, 0, "a price of zero is a price")
  })

  test("holds the pair: a price of one's own wants its reason, and a reason without a price is nothing", () => {
    assert.deepEqual(refusal(BillableEventCreate.safeParse({ ...body, unitPriceMinor: 10_000 })), [{ path: "overrideReason", message: OVERRIDE_WITH_A_REASON }])
    assert.deepEqual(refusal(BillableEventCreate.safeParse({ ...body, overrideReason: "Agreed by phone" })), [{ path: "overrideReason", message: OVERRIDE_WITH_A_REASON }])
    assert.equal(overrideWithAReason({}), true)
    assert.equal(overrideWithAReason({ unitPriceMinor: 1, overrideReason: "x" }), true)
    assert.equal(overrideWithAReason({ unitPriceMinor: 1 }), false)
    assert.equal(overrideWithAReason({ overrideReason: "x" }), false)
    assert.deepEqual(refusal(BillableEventCreate.safeParse({ ...body, unitPriceMinor: -1, overrideReason: "x" })).map((issue) => issue.path), ["unitPriceMinor"], "a person's price is zero or more")
  })

  test("needs the project, the agreement, the product, the quantity and the day, and refuses what the server owns by name: the status, the links, the origin, the price columns, the stamps", () => {
    for (const key of Object.keys(body)) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(BillableEventCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
    refusesWhatTheServerOwns(BillableEventCreate, body)
    for (const [key, value] of [
      ["status", "ready"],
      ["kind", "manual"],
      ["sourceEventId", OTHER],
      ["createdBy", OTHER],
      ["cancelledAt", "2026-10-06T09:00:00.000Z"],
      ["cancelReason", "duplicate"],
      ["blockReason", "no-product"],
      ["priceListRowId", THIRD],
      ["netMinor", 12_345],
      ["vatMinor", 3_086],
      ["vatPercent", 25],
      ["currency", "DKK"],
      ["subscriptionId", OTHER],
      ["links", links],
      ["invoiceLineId", THIRD],
    ] as const) {
      const issues = refusal(BillableEventCreate.safeParse({ ...body, [key]: value }))
      assert.deepEqual(
        issues.map((issue) => issue.path),
        [""],
        key,
      )
      assert.match(issues[0].message, new RegExp(key))
    }
    assert.deepEqual(refusal(BillableEventCreate.safeParse({ ...body, quantity: 0 })).map((issue) => issue.path), ["quantity"])
  })
})

describe("the two commands", () => {
  test("reprice takes the ticket event's product or nothing, and cancel the office's reason and a note — never the consumer's pickup-corrected", () => {
    assert.deepEqual(BillableEventReprice.parse({}), {})
    assert.deepEqual(BillableEventReprice.parse({ productId: ID }), { productId: ID })
    assert.deepEqual(refusal(BillableEventReprice.safeParse({ productId: "recollection" })).map((issue) => issue.path), ["productId"])
    assert.deepEqual(refusal(BillableEventReprice.safeParse({ blockReason: null })).map((issue) => issue.path), [""])
    assert.deepEqual(BillableEventCancel.parse({ reason: "duplicate" }), { reason: "duplicate" })
    assert.deepEqual(BillableEventCancel.parse({ reason: "not-delivered", note: "The container was not out" }), { reason: "not-delivered", note: "The container was not out" })
    assert.deepEqual(refusal(BillableEventCancel.safeParse({ reason: "pickup-corrected" })).map((issue) => issue.path), ["reason"], "the consumer's reason is not a person's")
    assert.deepEqual(refusal(BillableEventCancel.safeParse({})).map((issue) => issue.path), ["reason"])
    for (const reason of ["duplicate", "not-delivered", "other"]) assert.equal(BillableEventCancel.safeParse({ reason }).success, true, reason)
  })
})

describe("BillableEventListQuery", () => {
  test("pages by project, status, kind, block reason, agreement, payer, product, route, pickup and ticket, and over a window of service dates", () => {
    assert.deepEqual(BillableEventListQuery.parse({}), { limit: 50 })
    const whole = { projectId: OTHER, status: "ready", kind: "pickup", blockReason: "no-price-row", agreementId: THIRD, customerId: ID, productId: OTHER, routeId: THIRD, pickupId: ID, ticketId: OTHER, from: "2026-10-01", to: "2026-10-31" }
    assert.deepEqual(BillableEventListQuery.parse(whole), { limit: 50, ...whole })
    assert.deepEqual(refusal(BillableEventListQuery.safeParse({ from: "2026-10-31", to: "2026-10-01" })), [{ path: "to", message: DAY_WINDOW_ORDERED }])
    assert.equal(BillableEventListQuery.safeParse({ from: "2026-10-05", to: "2026-10-05" }).success, true, "a window of one day")
    assert.deepEqual(refusal(BillableEventListQuery.safeParse({ status: "In progress" })).map((issue) => issue.path), ["status"])
  })
})
