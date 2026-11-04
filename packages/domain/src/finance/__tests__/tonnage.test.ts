// The tonnage rule (O28 of #290, C32 of #291): which stops an Unload carried,
// how its reviewed net is shared among them, and a per-tonne price turned
// into one weighed load's amount.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { chargedByWeight, stopsCarried, tonnageShares, tonnesAt, weighedLoad, type RouteStop, type RouteUnload } from "../tonnage"

const unload = (id: string, occurredAt: string, values: Partial<RouteUnload> = {}): RouteUnload => ({ id, wasteFractionId: "residual", occurredAt, refused: false, ...values })
const stop = (pickupId: string, outcomeAt: string | null, values: Partial<RouteStop> = {}): RouteStop => ({ pickupId, wasteFractionId: "residual", outcomeAt, completed: true, onBoardKg: null, ...values })

describe("stopsCarried", () => {
  const stops = [stop("a", "2026-10-05T07:00:00Z"), stop("b", "2026-10-05T08:00:00Z"), stop("c", "2026-10-05T10:00:00Z"), stop("glass", "2026-10-05T07:30:00Z", { wasteFractionId: "glass" }), stop("missed", "2026-10-05T07:40:00Z", { completed: false })]

  test("an unload carries the completed stops of its fraction since the route's previous accepted unload of it, up to its own instant", () => {
    const first = unload("u1", "2026-10-05T09:00:00Z")
    const second = unload("u2", "2026-10-05T11:00:00Z")
    assert.deepEqual(stopsCarried(first, [first, second], stops).map((s) => s.pickupId), ["a", "b"])
    assert.deepEqual(stopsCarried(second, [first, second], stops).map((s) => s.pickupId), ["c"])
  })

  test("a refused load stays on board: the refused unload carries nothing, and the next accepted one carries its stops", () => {
    const refused = unload("u1", "2026-10-05T09:00:00Z", { refused: true })
    const next = unload("u2", "2026-10-05T11:00:00Z")
    assert.deepEqual(stopsCarried(refused, [refused, next], stops), [])
    assert.deepEqual(stopsCarried(next, [refused, next], stops).map((s) => s.pickupId), ["a", "b", "c"])
  })

  test("two accepted unloads of one fraction at one instant are one tipping, carried by the first by id", () => {
    const one = unload("u1", "2026-10-05T09:00:00Z")
    const two = unload("u2", "2026-10-05T09:00:00Z")
    assert.deepEqual(stopsCarried(one, [one, two], stops).map((s) => s.pickupId), ["a", "b"])
    assert.deepEqual(stopsCarried(two, [one, two], stops), [])
  })
})

describe("tonnageShares", () => {
  test("by the on-board weights where every stop was weighed, the shares adding up to the net", () => {
    assert.deepEqual(tonnageShares(1_000, [{ pickupId: "a", onBoardKg: 300 }, { pickupId: "b", onBoardKg: 600 }]), [
      { pickupId: "a", weightKg: 333 },
      { pickupId: "b", weightKg: 667 },
    ])
  })

  test("in equal parts where any stop was not weighed, the remainder to the earlier stops", () => {
    assert.deepEqual(tonnageShares(1_000, [{ pickupId: "a", onBoardKg: 300 }, { pickupId: "b", onBoardKg: null }, { pickupId: "c", onBoardKg: null }]), [
      { pickupId: "a", weightKg: 334 },
      { pickupId: "b", weightKg: 333 },
      { pickupId: "c", weightKg: 333 },
    ])
  })

  test("one stop carries the whole net; no stops, nothing; a share of nothing is left out", () => {
    assert.deepEqual(tonnageShares(8_240, [{ pickupId: "skip", onBoardKg: null }]), [{ pickupId: "skip", weightKg: 8_240 }])
    assert.deepEqual(tonnageShares(8_240, []), [])
    assert.deepEqual(tonnageShares(1, [{ pickupId: "a", onBoardKg: null }, { pickupId: "b", onBoardKg: null }]), [{ pickupId: "a", weightKg: 1 }])
  })
})

describe("a weighed load's price", () => {
  test("the rate per tonne times the tonnes, half away from zero to the minor unit", () => {
    assert.equal(tonnesAt(51_250, 2_500), 128_125)
    assert.equal(tonnesAt(1_001, 500), 501)
    assert.equal(tonnesAt(1_001, 499), 499)
    assert.equal(tonnesAt(0, 8_240), 0)
  })

  test("the unit price and the net are the load's amount, the VAT on it; past the columns, null", () => {
    const price = { priceListRowId: "row", unitPriceMinor: 51_250, netMinor: 51_250, vatPercent: 25, vatMinor: 12_813, currency: "DKK" }
    assert.deepEqual(weighedLoad(price, 8_240), { ...price, unitPriceMinor: 422_300, netMinor: 422_300, vatMinor: 105_575 })
    assert.equal(weighedLoad({ ...price, unitPriceMinor: 2_000_000_000 }, 10_000), null)
  })

  test("only a tonne product is charged by weight", () => {
    assert.deepEqual(["pickup", "month", "job", "day", "visit", "tonne"].filter((unit) => chargedByWeight(unit as never)), ["tonne"])
  })
})
