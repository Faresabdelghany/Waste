// The sustainability report's rules (M13 of #293): a stop weighed best first
// — measured, apportioned from its route's unloads by container volume,
// estimated by density, or unmeasured and never zero — and a Customer's
// stops summed per site and fraction with the recycling rate and CO₂e.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { fractionFactorInForce, gramsOf, kilogramsOf, recycles, SUSTAINABILITY_COLUMNS, sustainabilityCsv, sustainabilityLines, weighStops, type CustomerStop, type FractionFactor, type StopToWeigh } from "../sustainability"

const stop = (id: string, values: Partial<StopToWeigh> = {}): StopToWeigh => ({ id, routeId: "r1", wasteFractionId: "food", volumeLitres: 240, measuredKg: null, densityKgPerCubicMetre: null, ...values })

describe("weighing the stops", () => {
  test("a stop's own weight is measured; the route's unloaded kilograms less those are shared over the others by container volume", () => {
    const weights = weighStops([stop("a", { measuredKg: 30 }), stop("b", { volumeLitres: 240 }), stop("c", { volumeLitres: 660 })], [{ routeId: "r1", wasteFractionId: "food", netKg: 120 }])
    assert.deepEqual(Object.fromEntries(weights), { a: { kg: 30, basis: "measured" }, b: { kg: 24, basis: "apportioned" }, c: { kg: 66, basis: "apportioned" } })
  })

  test("the unloads of a route and fraction add up; another fraction's or another route's are not shared here", () => {
    const weights = weighStops(
      [stop("a"), stop("b", { wasteFractionId: "glass" }), stop("c", { routeId: "r2" })],
      [
        { routeId: "r1", wasteFractionId: "food", netKg: 50 },
        { routeId: "r1", wasteFractionId: "food", netKg: 25 },
        { routeId: "r1", wasteFractionId: "residual", netKg: 400 },
      ],
    )
    assert.deepEqual([weights.get("a"), weights.get("b"), weights.get("c")], [{ kg: 75, basis: "apportioned" }, { kg: null, basis: "unmeasured" }, { kg: null, basis: "unmeasured" }])
  })

  test("shares in whole kilograms, the odd ones to the largest remainders, a tie to the earlier stop", () => {
    // 2 kg over 1, 3 and 10 parts: 1/7, 3/7 and 10/7 — the 3/7s tie, and a float would rank them by its last bit.
    const weights = weighStops([stop("a", { volumeLitres: 1 }), stop("b", { volumeLitres: 3 }), stop("c", { volumeLitres: 10 })], [{ routeId: "r1", wasteFractionId: "food", netKg: 2 }])
    assert.deepEqual([weights.get("b")?.kg, weights.get("c")?.kg], [1, 1])
    assert.deepEqual(weights.get("a"), { kg: null, basis: "unmeasured" }, "a share of nothing falls to the next basis, never weighed as zero")
    const many = weighStops([stop("a"), stop("b"), stop("c")], [{ routeId: "r1", wasteFractionId: "food", netKg: 100 }])
    assert.deepEqual([...many.values()].map((weight) => weight.kg), [34, 33, 33], "equal volumes: the earlier stop takes the odd kilogram")
  })

  test("shares equally where any stop has no volume recorded", () => {
    const weights = weighStops([stop("a", { volumeLitres: null }), stop("b", { volumeLitres: 660 })], [{ routeId: "r1", wasteFractionId: "food", netKg: 9 }])
    assert.deepEqual([weights.get("a")?.kg, weights.get("b")?.kg], [5, 4])
  })

  test("where the measured stops account for all the weighbridge saw, the others are not apportioned a zero", () => {
    const weights = weighStops([stop("a", { measuredKg: 80 }), stop("b")], [{ routeId: "r1", wasteFractionId: "food", netKg: 70 }])
    assert.deepEqual(weights.get("b"), { kg: null, basis: "unmeasured" })
  })

  test("with no unload, a stop is estimated by volume and density where both are known, and unmeasured otherwise", () => {
    const weights = weighStops([stop("a", { densityKgPerCubicMetre: 125 }), stop("b")], [])
    assert.deepEqual([weights.get("a"), weights.get("b")], [{ kg: 30, basis: "estimated" }, { kg: null, basis: "unmeasured" }])
  })
})

describe("factors and grams", () => {
  const factors: FractionFactor[] = [
    { wasteFractionId: "food", footprintKgPerTonne: 30, avoidedKgPerTonne: 120, validFrom: "2026-01-01", validTo: "2027-01-01" },
    { wasteFractionId: "food", footprintKgPerTonne: 28, avoidedKgPerTonne: null, validFrom: "2027-01-01", validTo: null },
  ]

  test("the factor in force is the fraction's whose half-open period holds the day", () => {
    assert.equal(fractionFactorInForce(factors, "food", "2026-12-31")?.footprintKgPerTonne, 30)
    assert.equal(fractionFactorInForce(factors, "food", "2027-01-01")?.footprintKgPerTonne, 28, "the first day out is the next one's")
    assert.equal(fractionFactorInForce(factors, "food", "2025-12-31"), undefined)
    assert.equal(fractionFactorInForce(factors, "glass", "2026-06-01"), undefined)
  })

  test("kilograms times kilograms per tonne is grams, exactly; reuse and recycling recycle", () => {
    assert.equal(gramsOf(250, 30), 7500)
    assert.deepEqual((["reuse", "recycling", "energy-recovery", "disposal", null] as const).map(recycles), [true, true, false, false, false])
  })
})

describe("a Customer's lines", () => {
  const factors: FractionFactor[] = [
    { wasteFractionId: "food", footprintKgPerTonne: 30, avoidedKgPerTonne: 120, validFrom: "2026-01-01", validTo: null },
    { wasteFractionId: "residual", footprintKgPerTonne: 400, avoidedKgPerTonne: null, validFrom: "2026-01-01", validTo: null },
  ]
  const treatments = new Map([["food", "recycling" as const], ["residual", "energy-recovery" as const], ["glass", null]])
  const at = (siteKey: string, wasteFractionId: string, kg: number | null, basis: CustomerStop["weight"]["basis"], day = "2026-11-02"): CustomerStop => ({ siteKey, wasteFractionId, day, weight: { kg, basis } })

  test("sums each site's fraction by basis, counts every stop, and prices the weighed kilograms in grams", () => {
    const { lines, totals, warnings } = sustainabilityLines(
      [at("p1", "food", 30, "measured"), at("p1", "food", 70, "apportioned"), at("p1", "food", null, "unmeasured"), at("p1", "residual", 200, "apportioned"), at("p2", "food", 50, "estimated")],
      treatments,
      factors,
    )
    assert.deepEqual(
      lines.map((line) => [line.siteKey, line.wasteFractionId, line.kg, line.stops, line.footprintGrams, line.avoidedGrams]),
      [
        ["p1", "food", { measured: 30, apportioned: 70, estimated: 0 }, { measured: 1, apportioned: 1, estimated: 0, unmeasured: 1 }, 3000, 12000],
        ["p1", "residual", { measured: 0, apportioned: 200, estimated: 0 }, { measured: 0, apportioned: 1, estimated: 0, unmeasured: 0 }, 80000, 0],
        ["p2", "food", { measured: 0, apportioned: 0, estimated: 50 }, { measured: 0, apportioned: 0, estimated: 1, unmeasured: 0 }, 1500, 6000],
      ],
    )
    assert.deepEqual(totals, { weighedKg: 350, recycledKg: 150, recyclingRate: 150 / 350, footprintGrams: 84500, avoidedGrams: 18000, unmeasuredStops: 1 })
    assert.deepEqual(warnings, [])
  })

  test("a fraction with no treatment counts as not recycled and is named; one with no factor on a stop's day has no CO₂e and is named, never zero", () => {
    const { lines, totals, warnings } = sustainabilityLines([at("p1", "glass", 40, "measured"), at("p1", "food", 10, "measured"), at("p1", "food", 10, "measured", "2025-06-01")], treatments, factors)
    assert.deepEqual(lines.map((line) => [line.wasteFractionId, line.footprintGrams, line.avoidedGrams]), [["glass", null, null], ["food", null, null]])
    assert.deepEqual([totals.weighedKg, totals.recycledKg, totals.footprintGrams, totals.avoidedGrams], [60, 20, null, null], "a total missing a line's CO₂e is not the whole: null, never a partial sum")
    assert.deepEqual(warnings, [{ kind: "no-treatment", wasteFractionId: "glass" }, { kind: "no-factor", wasteFractionId: "glass" }, { kind: "no-factor", wasteFractionId: "food" }])
  })

  test("nothing weighed has no rate, rather than a rate of zero", () => {
    assert.equal(sustainabilityLines([at("p1", "food", null, "unmeasured")], treatments, factors).totals.recyclingRate, null)
  })
})

describe("the report's file", () => {
  test("kilograms carry their three decimals exactly", () => {
    assert.deepEqual([kilogramsOf(12500), kilogramsOf(7), kilogramsOf(0), kilogramsOf(1234567)], ["12.500", "0.007", "0.000", "1234.567"])
  })

  test("a row per site and fraction, a note for stops with no container, and a row per warning, behind a byte-order mark with CRLF records", () => {
    const text = sustainabilityCsv(
      {
        from: "2026-01-01",
        to: "2026-12-31",
        sites: [
          {
            name: "Parkvej 18",
            address: "Parkvej 18; 2100 København Ø",
            notAttributedStops: 2,
            lines: [
              { fractionName: "Organic", treatment: "recycling", kg: { measured: 30, apportioned: 70, estimated: 0 }, stops: { measured: 1, apportioned: 1, estimated: 0, unmeasured: 1 }, footprintGrams: 3000, avoidedGrams: 12000 },
              { fractionName: "Glass", treatment: null, kg: { measured: 40, apportioned: 0, estimated: 0 }, stops: { measured: 1, apportioned: 0, estimated: 0, unmeasured: 0 }, footprintGrams: null, avoidedGrams: null },
            ],
          },
        ],
        warnings: [{ kind: "no-treatment", fractionName: "Glass" }],
      },
      ";",
    )
    assert.ok(text.startsWith("\uFEFF"))
    const records = text.slice(1).split("\r\n")
    assert.equal(records.at(-1), "", "every record ends in CRLF")
    assert.deepEqual(records.slice(0, -1), [
      SUSTAINABILITY_COLUMNS.join(";"),
      '2026-01-01;2026-12-31;Parkvej 18;"Parkvej 18; 2100 København Ø";Organic;recycling;30;70;0;1;3.000;12.000;',
      '2026-01-01;2026-12-31;Parkvej 18;"Parkvej 18; 2100 København Ø";Glass;;40;0;0;0;;;',
      '2026-01-01;2026-12-31;Parkvej 18;"Parkvej 18; 2100 København Ø";;;;;;;;;2 completed stops with no container, so no agreement\'s, not counted',
      "2026-01-01;2026-12-31;;;Glass;;;;;;;;Glass has no treatment set, so its kilograms count as not recycled: set it under Master data",
    ])
  })
})
