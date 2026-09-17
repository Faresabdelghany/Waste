import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  estimateLoad,
  estimateRoute,
  fallbackContainerWeight,
  fallbackContainerWeightKg,
  routeEstimateAdapter,
  formatMinutes,
  type ContainerWeightResolver,
} from "../estimates"

describe("estimateRoute", () => {
  test("prototype coefficients: 381 stops → 43 km, 7 h 41 min", () => {
    const estimate = estimateRoute({ stops: 381, loadT: 3.8, capacityT: 10 })
    assert.equal(estimate.km, 43)
    assert.equal(formatMinutes(estimate.mins), "7 h 41 min")
    assert.equal(estimate.pct, 38)
    assert.equal(estimate.status, "within")
  })

  test("verdict precedence: over capacity beats over shift beats tight", () => {
    assert.equal(estimateRoute({ stops: 600, loadT: 12, capacityT: 10 }).status, "over-capacity")
    assert.equal(estimateRoute({ stops: 600, loadT: 5, capacityT: 10 }).status, "over-shift")
    assert.equal(estimateRoute({ stops: 100, loadT: 9.2, capacityT: 10 }).status, "tight")
    assert.equal(estimateRoute({ stops: 100, loadT: 8.9, capacityT: 10 }).status, "within")
  })

  test("unknown capacity yields 0 % and never flags capacity", () => {
    const estimate = estimateRoute({ stops: 10, loadT: 5, capacityT: null })
    assert.equal(estimate.pct, 0)
    assert.equal(estimate.overCapacity, false)
    assert.equal(estimate.capacityT, 0)
  })
})

describe("load estimate", () => {
  test("fallback weights combine type and fraction", () => {
    assert.equal(fallbackContainerWeightKg("Two-wheel bin · 240 L", "Residual"), 10)
    assert.equal(fallbackContainerWeightKg("Two-wheel bin · 240 L", "Organic"), 12)
    assert.equal(fallbackContainerWeightKg("Underground · 5,000 L", "Glass"), 975)
    assert.equal(fallbackContainerWeightKg(undefined, undefined), 20)
  })

  test("prototype value: 380 residual 240 L bins ≈ 3.8 t, all from the fallback table", () => {
    const containers = Array.from({ length: 380 }, () => ({
      containerType: "Two-wheel bin · 240 L",
      fractions: ["Residual"],
    }))
    assert.deepEqual(estimateLoad(containers), { loadT: 3.8, fallbackWeight: true })
    assert.deepEqual(fallbackContainerWeight("Two-wheel bin · 240 L", "Residual"), { kg: 10, fallback: true })
  })

  test("a catalogue resolver overrides the fallback and clears the flag", () => {
    const containers = [{ containerType: "Two-wheel bin · 240 L", fractions: ["Residual"] }]
    const catalogue: ContainerWeightResolver = () => ({ kg: 1800, fallback: false })
    assert.deepEqual(estimateLoad(containers, catalogue), { loadT: 1.8, fallbackWeight: false })
  })

  test("one fallback-weighted container type flags the whole group", () => {
    const catalogue: ContainerWeightResolver = (containerType, fraction) =>
      containerType === "Two-wheel bin · 240 L"
        ? { kg: 18, fallback: false }
        : fallbackContainerWeight(containerType, fraction)
    const load = estimateLoad(
      [
        { containerType: "Two-wheel bin · 240 L", fractions: ["Residual"] },
        { containerType: "Two-wheel bin · 140 L", fractions: ["Residual"] },
      ],
      catalogue,
    )
    assert.deepEqual(load, { loadT: 0, fallbackWeight: true })
    assert.equal(estimateLoad([], catalogue).fallbackWeight, false)
  })
})

describe("formatMinutes", () => {
  test("hours and minutes", () => {
    assert.equal(formatMinutes(45), "45 min")
    assert.equal(formatMinutes(60), "1 h 00 min")
    assert.equal(formatMinutes(461), "7 h 41 min")
  })
})

describe("routeEstimateAdapter", () => {
  test("labels its numbers as estimates and delegates to the heuristics", () => {
    assert.equal(routeEstimateAdapter.label, "Estimate")
    assert.deepEqual(
      routeEstimateAdapter.route({ stops: 381, loadT: 3.8, capacityT: 10 }),
      estimateRoute({ stops: 381, loadT: 3.8, capacityT: 10 }),
    )
    assert.deepEqual(routeEstimateAdapter.load([], fallbackContainerWeight), {
      loadT: 0,
      fallbackWeight: false,
    })
  })

  test("verdicts are information only — the estimate carries no blocking flag", () => {
    const over = routeEstimateAdapter.route({ stops: 600, loadT: 12, capacityT: 10 })
    assert.equal(over.status, "over-capacity")
    assert.equal("blocking" in over, false)
  })
})
