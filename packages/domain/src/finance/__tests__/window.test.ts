// The scale house's window prices (M16b of #293): a tier judged on a line's
// quantity in its product's unit, a row with no tier resolving as it always
// has, and an account's completed ticket an event per line, priced per tonne
// or per cubic metre, its void cancelling or reversing each.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { scaleTicketActionsFor, type ScaleTicketEventFacts } from "../from-event"
import { appliesFrom, resolvePrice, type PriceRow } from "../pricing"
import { quantityOf, soldAtTheWindow, thousandthsOf, windowLoad } from "../window"

const row = (id: string, values: Partial<PriceRow> = {}): PriceRow => ({ id, unitPriceMinor: 50_000, planningAreaId: null, customerKind: null, containerTypeId: null, wasteFractionId: "garden", customerId: null, validFrom: "2026-01-01", validTo: null, ...values })

describe("a quantity tier", () => {
  const rows = [row("base"), row("from-2", { unitPriceMinor: 45_000, fromQuantity: 2 }), row("from-5", { unitPriceMinor: 40_000, fromQuantity: 5 })]

  test("is met from its quantity, the highest tier met winning among rows of one score", () => {
    const at = (quantity: number | undefined) => resolvePrice(rows, { on: "2026-10-07", wasteFractionId: "garden", quantity }).winner?.row.id
    assert.equal(at(1.2), "base")
    assert.equal(at(2), "from-2")
    assert.equal(at(4.99), "from-2")
    assert.equal(at(7), "from-5")
    assert.equal(at(undefined), "base", "an occurrence naming no quantity meets no tier")
  })

  test("says why a row lost to its tier", () => {
    const verdict = resolvePrice(rows, { on: "2026-10-07", wasteFractionId: "garden", quantity: 3 }).verdicts.find((one) => one.row.id === "from-5")
    assert.equal(verdict?.reason, appliesFrom(5))
  })

  test("never ranks above a better score: a negotiated row or one of more conditions still wins", () => {
    const negotiated = row("negotiated", { unitPriceMinor: 30_000, customerId: "anna" })
    assert.equal(resolvePrice([...rows, negotiated], { on: "2026-10-07", wasteFractionId: "garden", customerId: "anna", quantity: 9 }).winner?.row.id, "negotiated")
  })

  test("leaves a list without tiers resolving as it always has, whatever the quantity", () => {
    const plain = [row("a"), row("b", { validFrom: "2026-03-01" }), row("c", { customerKind: "organisation" }), row("d", { wasteFractionId: "glass" })]
    const inputs = [{ on: "2026-10-07", wasteFractionId: "garden" }, { on: "2026-10-07", wasteFractionId: "garden", customerKind: "organisation" as const }, { on: "2026-02-01", wasteFractionId: "glass" }]
    for (const input of inputs) {
      const without = resolvePrice(plain, input)
      for (const quantity of [0.4, 1, 12, 1_000]) {
        const withQuantity = resolvePrice(plain, { ...input, quantity })
        assert.deepEqual(
          withQuantity.verdicts.map((verdict) => [verdict.row.id, verdict.eligible, verdict.reason, verdict.winner]),
          without.verdicts.map((verdict) => [verdict.row.id, verdict.eligible, verdict.reason, verdict.winner]),
        )
      }
    }
  })
})

describe("a window line's measure", () => {
  test("is kilograms of a tonne and litres of a cubic metre; any other unit is not the window's", () => {
    assert.equal(soldAtTheWindow("tonne"), true)
    assert.equal(soldAtTheWindow("m3"), true)
    assert.equal(soldAtTheWindow("pickup"), false)
    assert.equal(thousandthsOf("tonne", { netKg: 2_340, volumeLitres: null }), 2_340)
    assert.equal(thousandthsOf("m3", { netKg: 2_340, volumeLitres: 1_500 }), 1_500)
    assert.equal(thousandthsOf("m3", { netKg: 2_340, volumeLitres: null }), null)
    assert.equal(quantityOf(1_500), 1.5)
  })

  test("is priced at the rate times its thousandths, half away from zero", () => {
    const price = { priceListRowId: "row", unitPriceMinor: 45_000, netMinor: 45_000, vatPercent: 25, vatMinor: 11_250, currency: "DKK" }
    assert.deepEqual(windowLoad(price, 2_341), { ...price, unitPriceMinor: 105_345, netMinor: 105_345, vatMinor: 26_336 })
  })
})

describe("a Scale Ticket's events", () => {
  const priceList = { id: "list", currency: "DKK", rows: [row("per-tonne", { unitPriceMinor: 60_000 }), row("per-m3", { unitPriceMinor: 20_000, wasteFractionId: "bulky" })] }
  const tonne = { id: "garden-tonne", unit: "tonne" as const, vatPercent: 25 }
  const m3 = { id: "bulky-m3", unit: "m3" as const, vatPercent: 25 }
  const event = (values: Partial<ScaleTicketEventFacts> = {}): ScaleTicketEventFacts => ({
    kind: "scale-ticket-completed",
    ticketId: "ticket",
    serviceDate: "2026-10-07",
    completed: true,
    agreement: { id: "agreement", status: "active", customerKind: "organisation", customerId: "anna", priceList },
    lines: [
      { lineId: "line-1", wasteFractionId: "garden", netKg: 1_200, volumeLitres: null, product: tonne },
      { lineId: "line-2", wasteFractionId: "bulky", netKg: 300, volumeLitres: 2_500, product: m3 },
    ],
    liveEvents: [],
    ...values,
  })

  test("is an event per line of an account's completed ticket, each priced per its unit on the weighed-out day", () => {
    const actions = scaleTicketActionsFor(event())
    assert.deepEqual(
      actions.map((action) => (action.action === "record" ? [action.draft.kind, action.draft.links.scaleTicketLineId, action.draft.productId, action.draft.weightKg, action.draft.price?.netMinor, action.draft.blockReason] : [])),
      [
        ["scale-ticket", "line-1", "garden-tonne", 1_200, 72_000, null],
        ["scale-ticket", "line-2", "bulky-m3", 300, 50_000, null],
      ],
    )
  })

  test("is blocked no-product where a line names none, or a volume product with no volume", () => {
    const actions = scaleTicketActionsFor(event({ lines: [{ lineId: "line-1", wasteFractionId: "garden", netKg: 1_200, volumeLitres: null, product: null }, { lineId: "line-2", wasteFractionId: "bulky", netKg: 300, volumeLitres: null, product: m3 }] }))
    assert.deepEqual(
      actions.map((action) => (action.action === "record" ? action.draft.blockReason : null)),
      ["no-product", "no-product"],
    )
  })

  test("is nothing for a walk-in's, a ticket charged already, or a completion that arrives after the void", () => {
    assert.deepEqual(scaleTicketActionsFor(event({ agreement: null })), [])
    assert.deepEqual(scaleTicketActionsFor(event({ completed: false })), [])
    const live = { id: "live", agreementId: "agreement", subscriptionId: null, productId: "garden-tonne", quantity: 1, price: null, serviceDate: "2026-10-07", invoiced: false }
    assert.deepEqual(scaleTicketActionsFor(event({ liveEvents: [live] })), [])
  })

  test("is undone by the void: a live event cancelled, an invoiced one reversed", () => {
    const live = { id: "live", agreementId: "agreement", subscriptionId: null, productId: "garden-tonne", quantity: 1, price: null, serviceDate: "2026-10-07", invoiced: false }
    assert.deepEqual(scaleTicketActionsFor(event({ kind: "scale-ticket-voided", completed: false, liveEvents: [live] })), [{ action: "cancel", eventId: "live", reason: "scale-ticket-voided" }])
    const price = { priceListRowId: "per-tonne", unitPriceMinor: 72_000, netMinor: 72_000, vatPercent: 25, vatMinor: 18_000, currency: "DKK" }
    const [reversed] = scaleTicketActionsFor(event({ kind: "scale-ticket-voided", completed: false, liveEvents: [{ ...live, price, invoiced: true }] }))
    assert.equal(reversed?.action, "reverse")
  })
})
