// Recurring charges (#291 slice 2, #292 C2): the owner's rule — billed in
// advance, prorated by day, by the agreement's billing cadence — as pure
// arithmetic. A cadence's periods are calendar periods; a run over a period
// charges the periods that overlap it and the day after it, so the next
// period is billed in advance and one never charged is caught up; a period's
// charged days are those inside the subscription's and the agreement's
// periods and outside every pause; and the unit price is the month's price
// times the period's months, prorated by those days and rounded half away
// from zero.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { MINOR_MAX } from "../money"
import { chargedDays, chargePeriodContaining, chargePeriodsOfRun, priceCharge, proratedUnitPrice, RECURRING_UNIT } from "../recurring"

describe("a cadence's charge periods", () => {
  test("are calendar months, quarters and years, half-open", () => {
    assert.deepEqual(chargePeriodContaining("monthly", "2026-11-15"), { from: "2026-11-01", to: "2026-12-01" })
    assert.deepEqual(chargePeriodContaining("monthly", "2026-12-31"), { from: "2026-12-01", to: "2027-01-01" })
    assert.deepEqual(chargePeriodContaining("quarterly", "2026-11-15"), { from: "2026-10-01", to: "2027-01-01" })
    assert.deepEqual(chargePeriodContaining("quarterly", "2026-02-28"), { from: "2026-01-01", to: "2026-04-01" })
    assert.deepEqual(chargePeriodContaining("annual", "2026-11-15"), { from: "2026-01-01", to: "2027-01-01" })
  })

  test("a run over a month charges that month, if never charged, and the next in advance; a quarter or a year is charged by the run whose window touches its first day; manual charges nothing", () => {
    const october = { periodFrom: "2026-10-01", periodTo: "2026-10-31" }
    assert.deepEqual(chargePeriodsOfRun("monthly", october), [
      { from: "2026-10-01", to: "2026-11-01" },
      { from: "2026-11-01", to: "2026-12-01" },
    ])
    assert.deepEqual(chargePeriodsOfRun("quarterly", october), [{ from: "2026-10-01", to: "2027-01-01" }], "Q4 overlaps October; the next quarter begins after the window")
    assert.deepEqual(chargePeriodsOfRun("quarterly", { periodFrom: "2026-09-01", periodTo: "2026-09-30" }), [
      { from: "2026-07-01", to: "2026-10-01" },
      { from: "2026-10-01", to: "2027-01-01" },
    ], "September's run bills Q4 in advance: its window touches 1 October")
    assert.deepEqual(chargePeriodsOfRun("annual", { periodFrom: "2026-12-01", periodTo: "2026-12-31" }), [
      { from: "2026-01-01", to: "2027-01-01" },
      { from: "2027-01-01", to: "2028-01-01" },
    ])
    assert.deepEqual(chargePeriodsOfRun("manual", october), [])
  })
})

describe("a period's charged days", () => {
  const november = { from: "2026-11-01", to: "2026-12-01" }

  test("are its days inside every period in force and outside every pause, with the first of them", () => {
    assert.deepEqual(chargedDays(november, [{ validFrom: "2026-01-01", validTo: null }], []), { first: "2026-11-01", days: 30, periodDays: 30 })
    assert.deepEqual(chargedDays(november, [{ validFrom: "2026-11-16", validTo: null }, { validFrom: "2026-01-01", validTo: "2026-11-26" }], []), { first: "2026-11-16", days: 10, periodDays: 30 }, "the subscription from the 16th, the agreement to the 25th")
    assert.deepEqual(chargedDays(november, [{ validFrom: "2026-01-01", validTo: null }], [{ validFrom: "2026-11-01", validTo: "2026-11-08" }, { validFrom: "2026-11-29", validTo: null }]), { first: "2026-11-08", days: 21, periodDays: 30 }, "paused the first week and from the 29th")
    assert.deepEqual(chargedDays(november, [{ validFrom: "2026-12-01", validTo: null }], []), { first: null, days: 0, periodDays: 30 }, "not in force at all")
  })
})

describe("a recurring charge's unit price", () => {
  const november = { from: "2026-11-01", to: "2026-12-01" }
  const december = { from: "2026-12-01", to: "2027-01-01" }

  test("is the month's price times the period's months, prorated by the charged days over the period's, rounded half away from zero", () => {
    assert.equal(RECURRING_UNIT, "month")
    assert.equal(proratedUnitPrice(30000, november, 30), 30000, "a whole month")
    assert.equal(proratedUnitPrice(30000, november, 10), 10000)
    assert.equal(proratedUnitPrice(10000, december, 1), 323, "322.58 rounds up")
    assert.equal(proratedUnitPrice(10000, { from: "2026-10-01", to: "2027-01-01" }, 92), 30000, "a whole quarter is three months")
    assert.equal(proratedUnitPrice(10000, { from: "2027-01-01", to: "2028-01-01" }, 365), 120000, "a whole year is twelve")
    assert.equal(proratedUnitPrice(10001, november, 15), 5001, "5000.5 rounds away from zero")
  })

  test("is read off the period alone, so a charge is priced again as it was minted whatever the agreement's cadence is now", () => {
    assert.equal(proratedUnitPrice(10000, chargePeriodContaining("quarterly", "2026-11-14"), 46), proratedUnitPrice(10000, { from: "2026-10-01", to: "2027-01-01" }, 46))
  })
})

describe("a recurring charge's price", () => {
  const november = { from: "2026-11-01", to: "2026-12-01" }
  const month = { priceListRowId: "row", unitPriceMinor: 30000, netMinor: 30000, vatPercent: 25, vatMinor: 7500, currency: "DKK" }

  test("is the month's unit prorated, the net that unit times the quantity and its VAT, on the month's row and currency", () => {
    assert.deepEqual(priceCharge(month, 3, november, 10), { blockReason: null, price: { priceListRowId: "row", unitPriceMinor: 10000, netMinor: 30000, vatPercent: 25, vatMinor: 7500, currency: "DKK" } })
    // Per unit: 2 bins for 1 of December's 31 days are 2 × 323, an øre more than rounding 645.16 whole.
    assert.equal(priceCharge({ ...month, unitPriceMinor: 10000 }, 2, { from: "2026-12-01", to: "2027-01-01" }, 1).price?.netMinor, 646)
  })

  test("blocks an amount the integer columns cannot hold as amount-too-large", () => {
    // 2 147 483 647 øre a month, a whole month: the unit fits, two of them do not.
    assert.equal(priceCharge({ ...month, unitPriceMinor: MINOR_MAX }, 1, november, 30).blockReason, null)
    assert.equal(priceCharge({ ...month, unitPriceMinor: MINOR_MAX }, 2, november, 30).blockReason, "amount-too-large")
    assert.deepEqual(priceCharge({ ...month, unitPriceMinor: 1_000_000_000, vatPercent: 0 }, 3, november, 30), { blockReason: "amount-too-large", price: null })
    assert.equal(priceCharge({ ...month, unitPriceMinor: 1_000_000_000, vatPercent: 0 }, 2, november, 30).blockReason, null, "2 000 000 000 fits")
  })
})
