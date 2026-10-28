import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { routeShift } from "../../execution/shift"
import { stopLoadKg } from "../../execution/workload"
import { planFingerprint } from "../fingerprint"
import { OPTIMISER_MAX_LOCATIONS } from "../plans"
import { RELOAD_MAX_STOPS, reloadOf, UNLOAD_SECONDS, unloadsAlong, withUnloads } from "../reloads"
import { PLAN_STOP_KINDS } from "../vocabulary"

describe("a Plan's stops (O15 of #290)", () => {
  test("are the route's pickups and the unload visits on the way", () => {
    assert.deepEqual(PLAN_STOP_KINDS, ["pickup", "unload"])
  })
})

describe("what a stop puts on the truck", () => {
  test("an emptying, a swap or a bulky collection its expected weight; a delivery, a repair or a wash nothing; an unknown weight null", () => {
    const bin = { volumeLitres: 660, densityKgPerCubicMetre: 100 }
    assert.equal(stopLoadKg({ service: "empty", ...bin }), 66)
    assert.equal(stopLoadKg({ service: "swap", ...bin }), 66)
    assert.equal(stopLoadKg({ service: "deliver", ...bin }), 0)
    assert.equal(stopLoadKg({ service: "wash", ...bin }), 0)
    assert.equal(stopLoadKg({ service: "empty", volumeLitres: null, densityKgPerCubicMetre: 100 }), null)
  })
})

describe("whether a request unloads on the way", () => {
  const over = { solver: "optimiser" as const, trip: "full" as const, capacityKg: 1000, stopKg: [400, 400, 400] }

  test("a full trip whose stops weigh more than the payload does, each load as given", () => {
    assert.deepEqual(reloadOf(over), { capacityKg: 1000, amounts: [400, 400, 400] })
  })

  test("not within the payload, not without a payload, and not without the station a stops-only trip lacks", () => {
    assert.equal(reloadOf({ ...over, stopKg: [400, 600] }), null)
    assert.equal(reloadOf({ ...over, capacityKg: null }), null)
    assert.equal(reloadOf({ ...over, trip: "stops-only" }), null)
  })

  test("a weight nothing says weighs nothing, and a stop heavier than the vehicle is a full one: a trip of its own, never a stop the Plan cannot place", () => {
    assert.deepEqual(reloadOf({ ...over, stopKg: [null, 2500, 300] }), { capacityKg: 1000, amounts: [0, 1000, 300] })
  })

  test("an optimiser request takes reloads while its stops fit one request as shipments, two locations each; a measured order at any size", () => {
    assert.equal(RELOAD_MAX_STOPS * 2, OPTIMISER_MAX_LOCATIONS)
    const many = Array.from({ length: RELOAD_MAX_STOPS + 1 }, () => 100)
    assert.equal(reloadOf({ ...over, stopKg: many }), null)
    assert.notEqual(reloadOf({ ...over, stopKg: many.slice(1) }), null)
    assert.notEqual(reloadOf({ ...over, solver: "manual", stopKg: many }), null)
    assert.notEqual(reloadOf({ ...over, solver: "baseline", stopKg: many }), null)
  })
})

describe("the unload visits along a known order", () => {
  test("before each stop the vehicle cannot take on top of its load, counted by the stops before it", () => {
    assert.deepEqual(unloadsAlong([400, 400, 400, 400, 400], 1000), [2, 4])
    assert.deepEqual(unloadsAlong([500, 500, 500], 1000), [2])
    assert.deepEqual(unloadsAlong([1000, 1000], 1000), [1])
  })

  test("none within the payload, and never before the first stop", () => {
    assert.deepEqual(unloadsAlong([300, 300], 1000), [])
    assert.deepEqual(unloadsAlong([1000], 1000), [])
  })

  test("are written between the pickups they come after", () => {
    assert.deepEqual(withUnloads(["a", "b", "c"], [2]), [{ kind: "pickup", pickupId: "a" }, { kind: "pickup", pickupId: "b" }, { kind: "unload" }, { kind: "pickup", pickupId: "c" }])
    assert.deepEqual(withUnloads(["a"], []), [{ kind: "pickup", pickupId: "a" }])
  })
})

describe("the fingerprint of a request that unloads on the way", () => {
  const inputs = { provider: "fake", profile: "driving-hgv", solver: "optimiser" as const, depot: [12.5, 55.6] as const, station: [12.6, 55.7] as const, stops: [[12.51, 55.61] as const, [12.52, 55.62] as const] }

  test("keys as before without a reload, so no active Plan is asked again", () => {
    assert.equal(planFingerprint({ ...inputs, reload: null }), planFingerprint(inputs))
  })

  test("keys each stop's load and the payload, since they move the visits", () => {
    const loaded = planFingerprint({ ...inputs, reload: { capacityKg: 1000, amounts: [600, 600] } })
    assert.notEqual(loaded, planFingerprint(inputs))
    assert.notEqual(loaded, planFingerprint({ ...inputs, reload: { capacityKg: 1100, amounts: [600, 600] } }))
    assert.notEqual(loaded, planFingerprint({ ...inputs, reload: { capacityKg: 1000, amounts: [600, 700] } }))
    assert.match(loaded, /constraints=capacityKg=1000/)
  })
})

describe("the over-shift verdict over a Plan that unloads on the way", () => {
  test("works each unload visit's time at the station", () => {
    const shift = { from: "07:00", to: "15:00", breakMinutes: null, breakWindow: null }
    const without = routeShift({ shift, plannedStartTime: null, driveSeconds: 3600, waitingSeconds: 0, stopSeconds: 600 })
    const twice = routeShift({ shift, plannedStartTime: null, driveSeconds: 3600, waitingSeconds: 0, stopSeconds: 600, unloads: 2 })
    assert.equal((twice.workSeconds ?? 0) - (without.workSeconds ?? 0), 2 * UNLOAD_SECONDS)
  })
})
