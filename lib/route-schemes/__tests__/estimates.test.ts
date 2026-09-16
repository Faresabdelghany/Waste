import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  estimateLoadTonnes,
  estimateRoute,
  fallbackContainerWeightKg,
  formatMinutes,
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

  test("prototype value: 380 residual 240 L bins ≈ 3.8 t", () => {
    const containers = Array.from({ length: 380 }, () => ({
      containerType: "Two-wheel bin · 240 L",
      fractions: ["Residual"],
    }))
    assert.equal(estimateLoadTonnes(containers), 3.8)
  })

  test("a catalogue resolver overrides the fallback", () => {
    const containers = [{ containerType: "Two-wheel bin · 240 L", fractions: ["Residual"] }]
    assert.equal(estimateLoadTonnes(containers, () => 1800), 1.8)
  })
})

describe("formatMinutes", () => {
  test("hours and minutes", () => {
    assert.equal(formatMinutes(45), "45 min")
    assert.equal(formatMinutes(60), "1 h 00 min")
    assert.equal(formatMinutes(461), "7 h 41 min")
  })
})
