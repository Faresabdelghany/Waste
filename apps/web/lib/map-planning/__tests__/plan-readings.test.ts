// A dated Route's routing on the map (#173, on #124 §5 and #132 §5): the
// active Plan read off the route's record as the routes adapter writes it,
// the Plan a reading is taken from at its freshest, every per-route reading,
// and when the map asks `GET /plans/:id` again.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { ActivePlan, Plan, PlanDetail } from "@waste/contracts/plans"

import { ROUTE_ACTIVE_PLAN_KEY } from "@/lib/data/routes"

import { activePlanOf, nextPlanFetch, PLAN_POLL_MS, planReading, routePlanOf, type RoutePlan } from "../plan-readings"

const PLAN = "01a0d3a5-e5e0-7000-8000-0000000000a1"
const RETRY = "01a0d3a5-e5e0-7000-8000-0000000000a2"
/** 12:00 local on 1 October 2026. */
const NOW = new Date(2026, 9, 1, 12, 0)
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString()

const active = (overrides: Partial<ActivePlan> = {}): ActivePlan => ({
  id: PLAN,
  solver: "manual",
  status: "ready",
  trip: "full",
  distanceMetres: 18_473,
  durationSeconds: 1_849,
  stale: false,
  deferredUntil: null,
  ...overrides,
})

const plan = (overrides: Partial<Plan> = {}): Plan => ({
  id: RETRY,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  projectId: "01a0d3a5-e5e0-7000-8000-0000000000b1",
  routeId: "01a0d3a5-e5e0-7000-8000-0000000000c1",
  solver: "optimiser",
  status: "calculating",
  trip: "full",
  distanceMetres: null,
  durationSeconds: null,
  deferredUntil: null,
  failureReason: null,
  provider: "openrouteservice",
  engineVersion: null,
  graphDate: null,
  ...overrides,
})

const detail = (overrides: Partial<PlanDetail> = {}): PlanDetail => ({ ...plan({ id: PLAN, solver: "manual", status: "ready", distanceMetres: 18_473, durationSeconds: 1_849 }), legs: [], ...overrides })

const routePlan = (overrides: Partial<RoutePlan> = {}): RoutePlan => ({ id: PLAN, solver: "manual", status: "ready", distanceMetres: 18_473, durationSeconds: 1_849, deferredUntil: null, failureReason: null, stale: false, ...overrides })

describe("activePlanOf: the active Plan a route's record carries (lib/data/routes.ts)", () => {
  test("reads the JSON the routes adapter writes under the key", () => {
    assert.deepEqual(activePlanOf({ submittedValues: { [ROUTE_ACTIVE_PLAN_KEY]: JSON.stringify(active()) } }), active())
  })

  test("no Plan: the key absent, \"null\" for a route without one, or anything that does not read as one", () => {
    assert.equal(activePlanOf({}), null)
    assert.equal(activePlanOf(undefined), null)
    assert.equal(activePlanOf({ submittedValues: { [ROUTE_ACTIVE_PLAN_KEY]: "null" } }), null)
    assert.equal(activePlanOf({ submittedValues: { [ROUTE_ACTIVE_PLAN_KEY]: "{not json" } }), null)
    assert.equal(activePlanOf({ submittedValues: { [ROUTE_ACTIVE_PLAN_KEY]: JSON.stringify({ ...active(), status: "deferred" }) } }), null, "no fourth status")
    assert.equal(activePlanOf({ submittedValues: { [ROUTE_ACTIVE_PLAN_KEY]: JSON.stringify({ ...active(), stale: "no" }) } }), null)
  })
})

describe("routePlanOf: the Plan a drawn route reads, at its freshest", () => {
  test("the route's active Plan as the list carried it, its staleness the route's own", () => {
    assert.deepEqual(routePlanOf(active({ stale: true }), null, undefined), routePlan({ stale: true }))
  })

  test("what the map fetched of that very Plan since, its sentence included", () => {
    const fetched = detail({ status: "failed", distanceMetres: null, durationSeconds: null, failureReason: "Could not find routable point" })
    assert.deepEqual(routePlanOf(active({ status: "calculating", distanceMetres: null, durationSeconds: null }), null, fetched), routePlan({ status: "failed", distanceMetres: null, durationSeconds: null, failureReason: "Could not find routable point" }))
  })

  test("a Retry's Plan while the map holds it, over the stops as they stand", () => {
    const retried = plan({ deferredUntil: later(60) })
    assert.deepEqual(routePlanOf(active({ stale: true }), retried, detail()), { id: RETRY, solver: "optimiser", status: "calculating", distanceMetres: null, durationSeconds: null, deferredUntil: later(60), failureReason: null, stale: false })
  })

  test("a finished result wins over a calculating one, whichever read it came from: the list read since says ready, the fetch was earlier", () => {
    const fetched = detail({ status: "calculating", distanceMetres: null, durationSeconds: null, deferredUntil: later(900) })
    const plan = routePlanOf(active(), null, fetched)
    assert.deepEqual(plan, routePlan())
    assert.deepEqual(plan && nextPlanFetch(plan, fetched, NOW.getTime() - 1, NOW.getTime()), { kind: "now" }, "and its legs are asked for now")
  })

  test("no active Plan and no Retry: none", () => {
    assert.equal(routePlanOf(null, null, undefined), null)
  })
})

describe("planReading: every per-route reading of #132 §5, off the Plan alone", () => {
  test("Not measured without a Plan: the generated order stands", () => {
    assert.deepEqual(planReading(null, NOW), { kind: "not-measured", sentence: "Not measured", retry: false })
  })

  test("Measuring… while it calculates with its job due, a deferral gone by included", () => {
    assert.deepEqual(planReading(routePlan({ status: "calculating" }), NOW), { kind: "measuring", sentence: "Measuring…", retry: false })
    assert.equal(planReading(routePlan({ status: "calculating", deferredUntil: later(-1) }), NOW).kind, "measuring")
  })

  test("Waiting for routing quota, resumes at the deferral, while the quota puts it off", () => {
    assert.deepEqual(planReading(routePlan({ status: "calculating", deferredUntil: new Date(2026, 9, 1, 14, 32).toISOString() }), NOW), {
      kind: "waiting",
      sentence: "Waiting for routing quota, resumes at 14:32",
      retry: false,
    })
  })

  test("the totals once ready, Not optimised beside a baseline's", () => {
    assert.deepEqual(planReading(routePlan(), NOW), { kind: "measured", sentence: "18.5 km · 31 min", retry: false })
    assert.equal(planReading(routePlan({ solver: "baseline" }), NOW).sentence, "18.5 km · 31 min · Not optimised")
  })

  test("Routing failed in the Plan's own words, with Retry", () => {
    assert.deepEqual(planReading(routePlan({ status: "failed", failureReason: "the routing provider refused the key" }), NOW), {
      kind: "failed",
      sentence: "Routing failed: the routing provider refused the key",
      retry: true,
    })
    assert.equal(planReading(routePlan({ status: "failed" }), NOW).sentence, "Routing failed", "before its sentence is fetched")
  })

  test("Stale beside any reading when the stops moved under the Plan", () => {
    assert.equal(planReading(routePlan({ stale: true }), NOW).sentence, "18.5 km · 31 min · Stale")
    assert.equal(planReading(routePlan({ status: "calculating", stale: true }), NOW).sentence, "Measuring… · Stale")
  })
})

describe("nextPlanFetch: when the map asks GET /plans/:id of a Plan it draws", () => {
  const now = NOW.getTime()

  test("once for a ready Plan's legs and a failed one's sentence, never again once fetched as such", () => {
    assert.deepEqual(nextPlanFetch(routePlan(), undefined, undefined, now), { kind: "now" })
    assert.deepEqual(nextPlanFetch(routePlan(), detail(), now - 1, now), { kind: "never" })
    assert.deepEqual(nextPlanFetch(routePlan({ status: "failed" }), detail({ status: "failed" }), now - 1, now), { kind: "never" })
    assert.deepEqual(nextPlanFetch(routePlan({ status: "failed" }), detail({ status: "ready" }), now - 1, now), { kind: "now" }, "a fetch of another state is not the result")
  })

  test("every ten seconds while it calculates with its job due", () => {
    const calculating = routePlan({ status: "calculating" })
    assert.deepEqual(nextPlanFetch(calculating, undefined, undefined, now), { kind: "now" })
    assert.deepEqual(nextPlanFetch(calculating, detail({ status: "calculating" }), now - 1_000, now), { kind: "at", at: now - 1_000 + PLAN_POLL_MS })
    assert.deepEqual(nextPlanFetch(calculating, detail({ status: "calculating" }), now - PLAN_POLL_MS, now), { kind: "now" })
    assert.equal(PLAN_POLL_MS, 10_000)
  })

  test("not before its deferral while the quota puts it off: a wait hours away costs nothing", () => {
    const deferredUntil = later(180)
    assert.deepEqual(nextPlanFetch(routePlan({ status: "calculating", deferredUntil }), undefined, undefined, now), { kind: "at", at: Date.parse(deferredUntil) })
  })

  test("a fetch of another Plan is none of this one's", () => {
    assert.deepEqual(nextPlanFetch(routePlan({ id: RETRY }), detail(), now - 1, now), { kind: "now" })
  })
})
