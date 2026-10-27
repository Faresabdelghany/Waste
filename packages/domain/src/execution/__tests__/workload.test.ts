import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { BULKY_SERVICE_SECONDS, DENSITY_KG_PER_CUBIC_METRE, expectedKg, routeWorkload, SERVICE_SECONDS, serviceSecondsOf, UNKNOWN_SERVICE_SECONDS, WORK_ORDER_SERVICE_SECONDS, type WorkloadStop } from "../workload"

const bin = (values: Partial<WorkloadStop> = {}): WorkloadStop => ({ service: "empty", status: "planned", volumeLitres: 240, densityKgPerCubicMetre: 150, containerServiceSeconds: 30, ...values })

describe("a stop's expected weight (O10 of #290)", () => {
  test("is its container's litres times its fraction's density, whole kilograms", () => {
    assert.equal(expectedKg({ volumeLitres: 240, densityKgPerCubicMetre: 150 }), 36)
    assert.equal(expectedKg({ volumeLitres: 240, densityKgPerCubicMetre: 125 }), 30)
    assert.equal(expectedKg({ volumeLitres: 1100, densityKgPerCubicMetre: 45 }), 50, "49.5 rounds half away from zero")
  })

  test("is unknown without a volume or a density", () => {
    assert.equal(expectedKg({ volumeLitres: null, densityKgPerCubicMetre: 150 }), null)
    assert.equal(expectedKg({ volumeLitres: 240, densityKgPerCubicMetre: null }), null)
  })
})

describe("a stop's service time", () => {
  test("an emptying takes its container type's seconds, or the unknown figure without one", () => {
    assert.equal(serviceSecondsOf({ service: "empty", containerServiceSeconds: 75 }), 75)
    assert.equal(serviceSecondsOf({ service: "empty", containerServiceSeconds: null }), UNKNOWN_SERVICE_SECONDS)
  })

  test("a work order takes its service's figure, whatever the container", () => {
    for (const service of ["deliver", "remove", "swap", "repair", "wash"] as const) {
      assert.equal(serviceSecondsOf({ service, containerServiceSeconds: 30 }), WORK_ORDER_SERVICE_SECONDS[service], service)
    }
  })

  test("a bulky collection (O11 of #290) takes its own figure, and loads waste whose weight nothing says", () => {
    assert.equal(serviceSecondsOf({ service: "bulky", containerServiceSeconds: null }), BULKY_SERVICE_SECONDS)
    const reading = routeWorkload([{ service: "bulky", status: "planned", volumeLitres: null, densityKgPerCubicMetre: null, containerServiceSeconds: null }], null)
    assert.deepEqual([reading.stopSeconds, reading.expectedKg, reading.unexpectedStops], [BULKY_SERVICE_SECONDS, null, 1])
  })

  test("the bounds the database and the wire hold the settings to", () => {
    assert.deepEqual(DENSITY_KG_PER_CUBIC_METRE, { min: 1, max: 2000 })
    assert.deepEqual(SERVICE_SECONDS, { min: 1, max: 3600 })
  })
})

describe("a route's workload", () => {
  test("adds the seconds of the stops still planned, the kilograms of those it serves that load waste, and counts the ones it cannot expect", () => {
    const workload = routeWorkload(
      [
        bin(),
        bin({ status: "completed", volumeLitres: 1100, densityKgPerCubicMetre: 150, containerServiceSeconds: 75 }),
        bin({ volumeLitres: null }),
        bin({ service: "swap", volumeLitres: 660 }),
        bin({ service: "repair" }),
        bin({ service: "deliver" }),
        bin({ status: "skipped" }),
        bin({ status: "failed" }),
      ],
      12_000,
    )
    // Seconds: the planned emptyings 30 + 30, the swap 600, the repair 900 and the delivery 300; the completed stop is done.
    // Kilograms: the planned emptying 36, the completed one 165 and the swap's full 660 L 99; a repair and a delivery load none.
    assert.deepEqual(workload, { stopSeconds: 30 + 30 + 600 + 900 + 300, expectedKg: 36 + 165 + 99, unexpectedStops: 1, capacityKg: 12_000, overCapacityKg: 0 })
  })

  test("reads a stop that stands for several as that many", () => {
    assert.deepEqual(routeWorkload([bin({ count: 3 }), bin({ volumeLitres: null, count: 2 })], null), { stopSeconds: 150, expectedKg: 108, unexpectedStops: 2, capacityKg: null, overCapacityKg: null })
  })

  test("is over capacity by the kilograms the stops are expected to weigh beyond the vehicle's payload", () => {
    const heavy = Array.from({ length: 100 }, () => bin({ volumeLitres: 1100, densityKgPerCubicMetre: 150 }))
    assert.deepEqual(routeWorkload(heavy, 12_000), { stopSeconds: 3_000, expectedKg: 16_500, unexpectedStops: 0, capacityKg: 12_000, overCapacityKg: 4_500 })
  })

  test("reads no capacity without a vehicle's, and no weight where no stop's is known", () => {
    assert.deepEqual(routeWorkload([bin({ densityKgPerCubicMetre: null })], null), { stopSeconds: 30, expectedKg: null, unexpectedStops: 1, capacityKg: null, overCapacityKg: null })
    assert.deepEqual(routeWorkload([], 12_000), { stopSeconds: 0, expectedKg: null, unexpectedStops: 0, capacityKg: 12_000, overCapacityKg: null })
  })
})
