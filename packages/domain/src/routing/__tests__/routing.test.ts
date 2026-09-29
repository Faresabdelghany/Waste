import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { activeOnCreation, executionOrder, OPTIMISER_MAX_STOPS, planIsStale, tripOf } from "../plans"
import { FINGERPRINT_DECIMALS, planFingerprint, roundCoordinate } from "../fingerprint"
import { PLAN_SOLVERS, PLAN_STATUSES, PLAN_TRIPS, ROUTING_JOB_CLASSES, ROUTING_VOCABULARIES, SUPERSEDED } from "../vocabulary"

describe("the routing vocabularies", () => {
  test("every value is a kebab-case token, fit for a CHECK literal and a z.enum member", () => {
    for (const [name, values] of Object.entries(ROUTING_VOCABULARIES)) {
      assert.ok(values.length > 0, name)
      for (const value of values) assert.match(value, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${name}: ${value}`)
      assert.equal(new Set(values).size, values.length, `${name} repeats a value`)
    }
  })

  test("names the lists the decisions fixed", () => {
    assert.deepEqual(PLAN_SOLVERS, ["optimiser", "manual", "baseline"])
    assert.deepEqual(PLAN_STATUSES, ["calculating", "ready", "failed"])
    assert.deepEqual(PLAN_TRIPS, ["full", "stops-only"])
    assert.deepEqual(ROUTING_JOB_CLASSES, ["interactive", "batch"])
    assert.equal(SUPERSEDED, "superseded")
  })
})

describe("activation (#124 §2)", () => {
  test("a manual or baseline Plan is active from creation; an optimiser Plan only on ready", () => {
    assert.equal(activeOnCreation("manual"), true)
    assert.equal(activeOnCreation("baseline"), true)
    assert.equal(activeOnCreation("optimiser"), false)
  })
})

describe("the execution order (#170: sequence is computed on read, never stored)", () => {
  test("the active Plan's order first, for the stops it names; the stops it does not name append in baseline order (#124 §2)", () => {
    assert.deepEqual(executionOrder(["a", "b", "c"], ["c", "a", "b"]), ["c", "a", "b"])
    assert.deepEqual(executionOrder(["a", "b", "c", "d"], ["c", "a"]), ["c", "a", "b", "d"])
  })

  test("a stop the Plan names that is no longer the route's is dropped, not invented", () => {
    assert.deepEqual(executionOrder(["a", "b"], ["gone", "b", "a"]), ["b", "a"])
  })

  test("without an active Plan the baseline order stands", () => {
    assert.deepEqual(executionOrder(["a", "b", "c"], null), ["a", "b", "c"])
  })

  test("the optimiser's ceiling is fifty stops, the provider's own limit (#118)", () => {
    assert.equal(OPTIMISER_MAX_STOPS, 50)
  })
})

describe("staleness: a reading, never a status (#124 §2)", () => {
  test("an open stop the Plan does not name reads stale, and one it names that regeneration removed does too", () => {
    assert.equal(planIsStale({ named: ["a", "b"], open: ["a", "b"], removed: [] }), false)
    assert.equal(planIsStale({ named: ["a", "b"], open: ["a", "b", "c"], removed: [] }), true)
    assert.equal(planIsStale({ named: ["a", "b"], open: ["a"], removed: ["b"] }), true)
  })

  test("a stop decided by the driver is progress, not staleness", () => {
    // "b" completed: no longer open, not removed by regeneration — the Plan stands.
    assert.equal(planIsStale({ named: ["a", "b"], open: ["a"], removed: [] }), false)
  })
})

describe("the trip (#124 §3)", () => {
  test("full only when the Route names both a depot and a station", () => {
    assert.equal(tripOf({ hasDepot: true, hasStation: true }), "full")
    assert.equal(tripOf({ hasDepot: true, hasStation: false }), "stops-only")
    assert.equal(tripOf({ hasDepot: false, hasStation: true }), "stops-only")
    assert.equal(tripOf({ hasDepot: false, hasStation: false }), "stops-only")
  })
})

describe("coordinate rounding: five decimals, about 1.1 m at Danish latitudes", () => {
  test("is pinned at five decimal places", () => {
    assert.equal(FINGERPRINT_DECIMALS, 5)
  })

  test("rounds on both sides of the boundary, symmetrically for negative ordinates", () => {
    assert.equal(roundCoordinate(55.7000049), 55.7)
    assert.equal(roundCoordinate(55.7000051), 55.70001)
    assert.equal(roundCoordinate(-55.7000049), -55.7)
    assert.equal(roundCoordinate(-55.7000051), -55.70001)
    assert.equal(roundCoordinate(12.5683), 12.5683)
  })
})

describe("the fingerprint (#124 §4, corrected by #132 §6: request inputs only)", () => {
  const inputs = {
    provider: "fake",
    profile: "driving-hgv",
    solver: "baseline",
    configuration: { g: true },
    depot: [12.5683, 55.6761] as [number, number],
    station: [12.6, 55.71] as [number, number],
    stops: [
      [12.5, 55.7],
      [12.51, 55.701],
      [12.52, 55.702],
    ] as [number, number][],
    constraints: {},
  } as const

  test("is deterministic, and blind to object key order", () => {
    const reordered = { constraints: {}, stops: inputs.stops, station: inputs.station, depot: inputs.depot, configuration: { g: true }, solver: "baseline", profile: "driving-hgv", provider: "fake" }
    assert.equal(planFingerprint(inputs), planFingerprint(reordered as typeof inputs))
  })

  test("two coordinates within a metre of each other are one fingerprint; past the fifth decimal apart, two", () => {
    const nudged = { ...inputs, stops: [[12.500000004, 55.699999996], inputs.stops[1], inputs.stops[2]] as [number, number][] }
    assert.equal(planFingerprint(inputs), planFingerprint(nudged))
    const moved = { ...inputs, stops: [[12.50002, 55.7], inputs.stops[1], inputs.stops[2]] as [number, number][] }
    assert.notEqual(planFingerprint(inputs), planFingerprint(moved))
  })

  test("a stop without a location keys by the name its caller gives it, so an unlocatable request still fingerprints — and two different orders of unlocated stops are two fingerprints (#170)", () => {
    const bare = { ...inputs, stops: [inputs.stops[0], "unlocated:b", inputs.stops[2]] as ([number, number] | string)[] }
    assert.equal(planFingerprint(bare), planFingerprint({ ...bare }))
    assert.notEqual(planFingerprint(bare), planFingerprint(inputs))
    const ab: Parameters<typeof planFingerprint>[0] = { ...inputs, solver: "manual", stops: ["unlocated:a", "unlocated:b"] }
    const ba: Parameters<typeof planFingerprint>[0] = { ...inputs, solver: "manual", stops: ["unlocated:b", "unlocated:a"] }
    assert.notEqual(planFingerprint(ab), planFingerprint(ba))
  })

  test("stop order counts for baseline and manual, and not for optimiser, whose stops are a set", () => {
    const swapped = { ...inputs, stops: [inputs.stops[1], inputs.stops[0], inputs.stops[2]] as [number, number][] }
    assert.notEqual(planFingerprint(inputs), planFingerprint(swapped))
    assert.notEqual(planFingerprint({ ...inputs, solver: "manual" }), planFingerprint({ ...swapped, solver: "manual" }))
    assert.equal(planFingerprint({ ...inputs, solver: "optimiser" }), planFingerprint({ ...swapped, solver: "optimiser" }))
  })

  test("every named input moves it: provider, profile, solver, configuration, depot, station, a constraint", () => {
    const prints = [
      planFingerprint(inputs),
      planFingerprint({ ...inputs, provider: "openrouteservice" }),
      planFingerprint({ ...inputs, profile: "driving-car" }),
      planFingerprint({ ...inputs, solver: "manual" }),
      planFingerprint({ ...inputs, configuration: { g: false } }),
      planFingerprint({ ...inputs, depot: null }),
      planFingerprint({ ...inputs, station: null }),
      planFingerprint({ ...inputs, constraints: { maxStops: 50 } }),
    ]
    assert.equal(new Set(prints).size, prints.length)
  })
})
