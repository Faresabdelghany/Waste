import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { activeOnCreation, executionOrder, horizonRequest, isSuperseded, OPTIMISER_MAX_STOPS, optimiseSolver, planIsStale, tripOf } from "../plans"
import { FINGERPRINT_DECIMALS, planFingerprint, roundCoordinate } from "../fingerprint"
import { routingJobPriority } from "../jobs"
import { OPTIMISE_FALLBACKS, PLAN_SOLVERS, PLAN_STATUSES, PLAN_TRIPS, ROUTING_JOB_CLASSES, ROUTING_QUOTA_FAMILIES, ROUTING_VOCABULARIES, SUPERSEDED } from "../vocabulary"

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
    assert.deepEqual(ROUTING_QUOTA_FAMILIES, ["directions", "optimisation"])
    assert.deepEqual(OPTIMISE_FALLBACKS, ["too-many-stops", "no-depot"])
  })
})

describe("which solver an Optimise request gets (#124 §4, #171)", () => {
  test("fifty open stops or fewer, from a depot: the optimiser, no fallback", () => {
    assert.deepEqual(optimiseSolver({ openStops: 50, hasDepot: true }), { solver: "optimiser", fallback: null })
    assert.deepEqual(optimiseSolver({ openStops: 1, hasDepot: true }), { solver: "optimiser", fallback: null })
  })

  test("more than fifty: a baseline measurement, and the token that says why", () => {
    assert.deepEqual(optimiseSolver({ openStops: 51, hasDepot: true }), { solver: "baseline", fallback: "too-many-stops" })
  })

  test("a route that names no depot: a baseline, since the optimiser orders from the depot", () => {
    assert.deepEqual(optimiseSolver({ openStops: 12, hasDepot: false }), { solver: "baseline", fallback: "no-depot" })
  })

  test("both at once reads the size first, the older of the two rules", () => {
    assert.deepEqual(optimiseSolver({ openStops: 80, hasDepot: false }), { solver: "baseline", fallback: "too-many-stops" })
  })
})

describe("supersession (#132 §4, amending #124 §2 for the optimiser)", () => {
  const older = "01900000-0000-7000-8000-000000000001"
  const plan = "01900000-0000-7000-8000-000000000002"
  const newer = "01900000-0000-7000-8000-000000000003"

  test("a measurement is superseded once its Plan is not the route's active one, whoever replaced it", () => {
    assert.equal(isSuperseded({ solver: "manual", planId: plan, activePlanId: plan }), false)
    assert.equal(isSuperseded({ solver: "manual", planId: plan, activePlanId: newer }), true)
    assert.equal(isSuperseded({ solver: "baseline", planId: plan, activePlanId: older }), true)
    assert.equal(isSuperseded({ solver: "baseline", planId: plan, activePlanId: null }), true)
  })

  test("an optimiser Plan, never active before it is ready, is superseded only by an active Plan newer than itself: a later order wins", () => {
    assert.equal(isSuperseded({ solver: "optimiser", planId: plan, activePlanId: null }), false)
    assert.equal(isSuperseded({ solver: "optimiser", planId: plan, activePlanId: older }), false)
    assert.equal(isSuperseded({ solver: "optimiser", planId: plan, activePlanId: newer }), true)
  })
})

describe("routing job priority (#132 §1: the class first, then batch by the nearest operating date)", () => {
  test("every interactive job runs before any batch job, whatever the dates", () => {
    const interactive = routingJobPriority({ class: "interactive", operatingDate: "2026-11-30" })
    assert.equal(interactive, 2_000_000)
    assert.ok(interactive > routingJobPriority({ class: "batch", operatingDate: "1970-01-02" }))
    assert.equal(routingJobPriority({ class: "interactive", operatingDate: "2026-10-02" }), interactive)
  })

  test("within batch, the earlier operating date runs first: one step lower per day, counted from the date alone", () => {
    // 2026-10-01 is day 20 727 of the Unix epoch.
    assert.equal(routingJobPriority({ class: "batch", operatingDate: "2026-10-01" }), 979_273)
    assert.equal(routingJobPriority({ class: "batch", operatingDate: "2026-10-02" }), 979_272)
    assert.equal(routingJobPriority({ class: "batch", operatingDate: "2026-10-08" }), 979_266)
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

describe("what the horizon asks of a route (#172: generation and the sweep, over #124 §2 and §4)", () => {
  test("without an active Plan, the Optimise request's size rule over the open stops in baseline order: the optimiser from a depot, a baseline without one", () => {
    assert.deepEqual(horizonRequest({ open: ["a", "b"], hasDepot: true, active: null }), { solver: "optimiser", orderedPickupIds: ["a", "b"] })
    assert.deepEqual(horizonRequest({ open: ["a", "b"], hasDepot: false, active: null }), { solver: "baseline", orderedPickupIds: ["a", "b"] })
  })

  test("more than fifty open stops are measured as a baseline, depot or not; fifty still go to the optimiser", () => {
    const open = Array.from({ length: 51 }, (_, index) => `stop-${index + 1}`)
    const asked = horizonRequest({ open, hasDepot: true, active: null })
    assert.equal(asked.solver, "baseline")
    assert.deepEqual(asked.orderedPickupIds.slice(0, 2), ["stop-1", "stop-2"])
    assert.equal(asked.orderedPickupIds.length, 51)
    assert.equal(horizonRequest({ open: open.slice(0, 50), hasDepot: true, active: null }).solver, "optimiser")
  })

  test("under a machine's order — an optimiser's or a baseline — the size rule again: a stale machine order is simply asked anew", () => {
    assert.deepEqual(horizonRequest({ open: ["a", "b", "c"], hasDepot: true, active: { solver: "optimiser", named: ["b", "a"] } }), { solver: "optimiser", orderedPickupIds: ["a", "b", "c"] })
    assert.deepEqual(horizonRequest({ open: ["a", "b", "c"], hasDepot: false, active: { solver: "baseline", named: ["a", "b"] } }), { solver: "baseline", orderedPickupIds: ["a", "b", "c"] })
  })

  test("under a dispatcher's manual order, a new manual Plan over the order the driver already reads: the named stops in the dispatcher's sequence, a new one appended in baseline order", () => {
    assert.deepEqual(horizonRequest({ open: ["a", "b", "c", "d"], hasDepot: true, active: { solver: "manual", named: ["c", "a", "b"] } }), { solver: "manual", orderedPickupIds: ["c", "a", "b", "d"] })
  })

  test("a stop regeneration removed leaves the dispatcher's sequence of the rest, never the optimiser, whatever the route's size or depot", () => {
    assert.deepEqual(horizonRequest({ open: ["a", "c"], hasDepot: true, active: { solver: "manual", named: ["c", "b", "a"] } }), { solver: "manual", orderedPickupIds: ["c", "a"] })
    const open = Array.from({ length: 60 }, (_, index) => `stop-${index + 1}`)
    const asked = horizonRequest({ open, hasDepot: false, active: { solver: "manual", named: ["stop-60", "stop-1"] } })
    assert.equal(asked.solver, "manual")
    assert.deepEqual(asked.orderedPickupIds.slice(0, 3), ["stop-60", "stop-1", "stop-2"])
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
