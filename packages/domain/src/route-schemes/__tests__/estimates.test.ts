import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  STOP_MINUTES,
  estimateLoad,
  estimateRoute,
  estimateServiceMinutes,
  fallbackContainerWeight,
  fallbackContainerWeightKg,
  formatKilometres,
  routeEstimateAdapter,
  formatMinutes,
  type ContainerWeightResolver,
} from "../estimates"

describe("estimateRoute", () => {
  test("prototype coefficients: 381 stops → 43 km, 7 h 41 min, on the estimate basis", () => {
    const estimate = estimateRoute({ stops: 381, loadT: 3.8, capacityT: 10 })
    assert.equal(estimate.km, 43)
    assert.equal(formatMinutes(estimate.mins), "7 h 41 min")
    assert.equal(estimate.pct, 38)
    assert.equal(estimate.status, "within")
    assert.equal(estimate.basis, "estimate")
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

  test("with the road: its distance to a tenth of a kilometre, its drive time plus the time at the stops", () => {
    const routed = estimateRoute({
      stops: 3,
      loadT: 0.1,
      capacityT: 10,
      road: { distanceMetres: 12_340, durationSeconds: 1_800 },
      serviceMinutes: 9,
    })
    assert.equal(routed.basis, "road")
    assert.equal(routed.km, 12.3)
    assert.equal(routed.mins, 39)
    assert.equal(routed.status, "within")
  })

  test("without service minutes the road basis charges the allowance per stop; a null road is the estimate", () => {
    const routed = estimateRoute({ stops: 4, loadT: 0, capacityT: 10, road: { distanceMetres: 0, durationSeconds: 600 } })
    assert.equal(routed.mins, Math.round(10 + 4 * STOP_MINUTES))
    assert.equal(estimateRoute({ stops: 4, loadT: 0, capacityT: 10, road: null }).basis, "estimate")
  })

  test("the shift verdict reads the road's minutes", () => {
    const long = estimateRoute({
      stops: 2,
      loadT: 1,
      capacityT: 10,
      road: { distanceMetres: 400_000, durationSeconds: 8 * 3600 },
      serviceMinutes: 1,
    })
    assert.equal(long.overShift, true)
    assert.equal(long.status, "over-shift")
  })
})

describe("estimateServiceMinutes", () => {
  test("sums the catalogue's emptying time per stop, the allowance where it has none", () => {
    const containers = [
      { containerType: "Two-wheel bin · 240 L" },
      { containerType: "Two-wheel bin · 240 L" },
      { containerType: "Igloo · 2,500 L" },
      { containerType: undefined },
    ]
    const minutesFor = (type: string | undefined) => (type === "Two-wheel bin · 240 L" ? 2 : null)
    assert.ok(Math.abs(estimateServiceMinutes(containers, minutesFor) - (4 + 2 * STOP_MINUTES)) < 1e-9)
    assert.ok(Math.abs(estimateServiceMinutes(containers) - 4 * STOP_MINUTES) < 1e-9)
    assert.equal(estimateServiceMinutes([]), 0)
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

describe("formatKilometres", () => {
  test("whole and decimal kilometres, a float sum rounded back to a tenth", () => {
    assert.equal(formatKilometres(43), "43 km")
    assert.equal(formatKilometres(12.3), "12.3 km")
    assert.equal(formatKilometres(0.1 + 0.2), "0.3 km")
    assert.equal(formatKilometres(1234.56), "1,234.6 km")
  })
})

describe("routeEstimateAdapter", () => {
  test("labels each basis and delegates to the heuristics and the road alike", () => {
    assert.deepEqual(routeEstimateAdapter.labels, { estimate: "Estimate", road: "Road" })
    assert.deepEqual(
      routeEstimateAdapter.route({ stops: 381, loadT: 3.8, capacityT: 10 }),
      estimateRoute({ stops: 381, loadT: 3.8, capacityT: 10 }),
    )
    const road = { distanceMetres: 5_000, durationSeconds: 600 }
    assert.deepEqual(
      routeEstimateAdapter.route({ stops: 3, loadT: 0.1, capacityT: 10, road, serviceMinutes: 6 }),
      estimateRoute({ stops: 3, loadT: 0.1, capacityT: 10, road, serviceMinutes: 6 }),
    )
    assert.deepEqual(routeEstimateAdapter.load([], fallbackContainerWeight), {
      loadT: 0,
      fallbackWeight: false,
    })
    assert.equal(routeEstimateAdapter.serviceMinutes([{ containerType: "x" }], () => 3), 3)
  })

  test("verdicts are information only — the estimate carries no blocking flag", () => {
    const over = routeEstimateAdapter.route({ stops: 600, loadT: 12, capacityT: 10 })
    assert.equal(over.status, "over-capacity")
    assert.equal("blocking" in over, false)
  })
})
