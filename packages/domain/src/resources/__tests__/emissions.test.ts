// Fleet emissions (M10 of #293): the grams a route's planned distance burns,
// what a route missing a fact is told, the factor in force on a day, the
// split of a route's grams over its stops' fractions, and the optimiser's
// saving against the baseline.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { drivenGrams, factorInForce, FUEL_UNIT, routeEmission, savingOf, splitByStops, type EmissionFactorPeriod, type RouteEmissionFacts } from "../emissions"
import { EMISSION_GAPS, ENERGY_UNITS, FUEL_TYPES } from "../vocabulary"

describe("the grams driven", () => {
  test("are the kilometres times the consumption times the factor: 10 km at 450 ml/km of diesel at 2658 g/l", () => {
    // 10 km × 0.45 l/km × 2658 g/l = 11 961 g
    assert.equal(drivenGrams(10_000, 450, 2658), 11_961)
  })

  test("round half away from zero once, on the product, never per kilometre", () => {
    // 1 km × 0.5 l/km × 1 g/l = 0.5 g → 1
    assert.equal(drivenGrams(1_000, 500, 1), 1)
    // 1 km × 0.499 l/km × 1 g/l = 0.499 g → 0
    assert.equal(drivenGrams(1_000, 499, 1), 0)
    assert.equal(drivenGrams(0, 450, 2658), 0)
    assert.equal(drivenGrams(10_000, 450, 0), 0)
  })

  test("stay exact at the bounds, a Plan's distance any integer", () => {
    assert.equal(drivenGrams(2_000_000, 10_000, 10_000), 200_000_000)
    // The largest integer distance at the caps: 2 147 483 647 × 10⁸ is past a double's exact integers, and the quotient is still whole.
    assert.equal(drivenGrams(2_147_483_647, 10_000, 10_000), 214_748_364_700)
    // Past a double's exact integers with a remainder, and the half-gram edge either side.
    assert.equal(drivenGrams(2_147_483_647, 9_999, 1), 21_472_689)
    assert.equal(drivenGrams(500_001, 1, 1), 1)
    assert.equal(drivenGrams(499_999, 1, 1), 0)
  })
})

describe("the fuel's unit", () => {
  test("is a litre for the liquid fuels, a kilogram of gas, a kilowatt-hour of electricity", () => {
    assert.deepEqual(FUEL_UNIT, { diesel: "litre", hvo: "litre", biogas: "kg", electric: "kwh", hybrid: "litre", other: "litre" })
    for (const fuel of FUEL_TYPES) assert.ok(ENERGY_UNITS.includes(FUEL_UNIT[fuel]), fuel)
  })
})

describe("the factor in force", () => {
  const factors: EmissionFactorPeriod[] = [
    { fuel: "diesel", gramsPerUnit: 2640, validFrom: "2024-01-01", validTo: "2025-01-01" },
    { fuel: "diesel", gramsPerUnit: 2658, validFrom: "2025-01-01", validTo: null },
    { fuel: "hvo", gramsPerUnit: 0, validFrom: "2025-06-01", validTo: "2025-07-01" },
  ]

  test("is the fuel's period holding the day, half-open: a period's end is its first day out", () => {
    assert.equal(factorInForce(factors, "diesel", "2024-12-31"), 2640)
    assert.equal(factorInForce(factors, "diesel", "2025-01-01"), 2658)
    assert.equal(factorInForce(factors, "diesel", "2031-05-05"), 2658)
    assert.equal(factorInForce(factors, "hvo", "2025-06-30"), 0)
    assert.equal(factorInForce(factors, "hvo", "2025-07-01"), null)
    assert.equal(factorInForce(factors, "diesel", "2023-12-31"), null)
    assert.equal(factorInForce(factors, "electric", "2025-03-03"), null)
  })
})

describe("a route's emission", () => {
  const measured: RouteEmissionFacts = { plan: { metres: 10_000 }, fuel: "diesel", vehicleTypeId: "rear-loader", consumption: 450, factor: 2658 }

  test("is the planned distance's grams where every fact is known", () => {
    assert.deepEqual(routeEmission(measured), { measured: true, metres: 10_000, grams: 11_961 })
  })

  test("is unmeasured, never zero, naming the first fact it lacks", () => {
    assert.deepEqual(routeEmission({ ...measured, plan: null }), { measured: false, gap: "no-plan" })
    assert.deepEqual(routeEmission({ ...measured, plan: { metres: null } }), { measured: false, gap: "plan-unmeasured" })
    assert.deepEqual(routeEmission({ ...measured, vehicleTypeId: null, fuel: null }), { measured: false, gap: "no-vehicle" })
    assert.deepEqual(routeEmission({ ...measured, fuel: null }), { measured: false, gap: "no-fuel" })
    assert.deepEqual(routeEmission({ ...measured, consumption: null }), { measured: false, gap: "no-consumption" })
    assert.deepEqual(routeEmission({ ...measured, factor: null }), { measured: false, gap: "no-factor" })
    // The plan is judged before the vehicle: a route lacking both is told the first.
    assert.deepEqual(routeEmission({ ...measured, plan: null, vehicleTypeId: null, fuel: null }), { measured: false, gap: "no-plan" })
  })

  test("a factor of zero is measured: a biofuel documented as sustainable counts as nothing burnt", () => {
    assert.deepEqual(routeEmission({ ...measured, factor: 0 }), { measured: true, metres: 10_000, grams: 0 })
  })

  test("judges the gaps in the vocabulary's order, the first lacking named however many follow", () => {
    const nothing: RouteEmissionFacts = { plan: { metres: null }, vehicleTypeId: null, fuel: null, consumption: null, factor: null }
    const told = [
      routeEmission({ ...nothing, plan: null }),
      routeEmission(nothing),
      routeEmission({ ...nothing, plan: { metres: 1 } }),
      routeEmission({ ...nothing, plan: { metres: 1 }, vehicleTypeId: "t" }),
      routeEmission({ ...nothing, plan: { metres: 1 }, vehicleTypeId: "t", fuel: "diesel" }),
      routeEmission({ ...nothing, plan: { metres: 1 }, vehicleTypeId: "t", fuel: "diesel", consumption: 1 }),
    ].map((emission) => (emission.measured ? "measured" : emission.gap))
    assert.deepEqual(told, [...EMISSION_GAPS])
  })
})

describe("the split by stops", () => {
  test("shares a route's grams over its stops' fractions by count, the parts summing to the whole", () => {
    assert.deepEqual(splitByStops(100, new Map([["residual", 2], ["paper", 1]])), new Map([["residual", 67], ["paper", 33]]))
    assert.deepEqual(splitByStops(10, new Map([["a", 1], ["b", 1], ["c", 1]])), new Map([["a", 4], ["b", 3], ["c", 3]]))
    const parts = splitByStops(11_961, new Map([["residual", 7], ["mixed", 5], ["glass", 3]]))
    assert.equal([...parts.values()].reduce((sum, grams) => sum + grams, 0), 11_961)
  })

  test("gives a leftover gram to the largest remainder, ties to the first fraction named", () => {
    assert.deepEqual(splitByStops(1, new Map([["a", 1], ["b", 1]])), new Map([["a", 1], ["b", 0]]))
    assert.deepEqual(splitByStops(5, new Map([["a", 1], ["b", 3]])), new Map([["a", 1], ["b", 4]]))
  })

  test("a route without a counted stop splits into nothing: its grams are the route's alone", () => {
    assert.deepEqual(splitByStops(500, new Map()), new Map())
    assert.deepEqual(splitByStops(500, new Map([["a", 0]])), new Map())
  })
})

describe("the optimiser's saving", () => {
  test("is the measured baseline less the active optimised Plan, in metres and in grams", () => {
    assert.deepEqual(savingOf({ solver: "optimiser", metres: 8_000 }, 10_000, 450, 2658), { metres: 2_000, grams: 11_961 - 9_569 })
  })

  test("is none where the active Plan is not the optimiser's or the baseline was never measured", () => {
    assert.equal(savingOf({ solver: "manual", metres: 8_000 }, 10_000, 450, 2658), null)
    assert.equal(savingOf({ solver: "baseline", metres: 10_000 }, 10_000, 450, 2658), null)
    assert.equal(savingOf({ solver: "optimiser", metres: 8_000 }, null, 450, 2658), null)
  })

  test("may be negative where the optimiser drove further: the report says so rather than hide it", () => {
    assert.deepEqual(savingOf({ solver: "optimiser", metres: 10_500 }, 10_000, 450, 2658), { metres: -500, grams: 11_961 - 12_559 })
  })
})
