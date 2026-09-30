import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { ActivePlan, OptimiseAnswer, Plan, PlanDetail, PlanLeg } from "../plans"

const STAMPS = { createdAt: "2026-10-05T06:00:00.000Z", updatedAt: "2026-10-05T06:05:00.000Z" }
const IDS = {
  id: "01a0d2a4-a280-7010-8000-000000000001",
  projectId: "01a0d2a4-a280-7002-8000-000000000001",
  routeId: "01a0d2a4-a280-7008-8000-000000000001",
}

const ready: Plan = {
  ...IDS,
  ...STAMPS,
  solver: "baseline",
  status: "ready",
  trip: "full",
  distanceMetres: 12_400,
  durationSeconds: 3_600,
  deferredUntil: null,
  failureReason: null,
  provider: "fake",
  engineVersion: "fake",
  graphDate: null,
}

describe("Plan and PlanDetail (#170)", () => {
  test("a ready plan parses with its totals, and its legs on the detail", () => {
    assert.deepEqual(Plan.parse(ready), ready)
    const leg = { position: 1, path: { type: "LineString", coordinates: [[12.5, 55.7], [12.6, 55.71]] }, metres: 12_400, seconds: 3_600 }
    assert.deepEqual(PlanLeg.parse(leg), leg)
    const detail = { ...ready, legs: [leg] }
    assert.deepEqual(PlanDetail.parse(detail), detail)
  })

  test("a calculating plan carries no totals and may carry its deferral; a failed one its reason", () => {
    const calculating = { ...ready, status: "calculating", distanceMetres: null, durationSeconds: null, deferredUntil: "2026-10-06T03:00:00.000Z" }
    assert.deepEqual(Plan.parse(calculating), calculating)
    const failed = { ...ready, status: "failed", distanceMetres: null, durationSeconds: null, failureReason: "superseded" }
    assert.deepEqual(Plan.parse(failed), failed)
  })

  test("refuses a solver, status or trip outside the vocabulary, and a negative total", () => {
    assert.equal(Plan.safeParse({ ...ready, solver: "magic" }).success, false)
    assert.equal(Plan.safeParse({ ...ready, status: "waiting" }).success, false)
    assert.equal(Plan.safeParse({ ...ready, trip: "round" }).success, false)
    assert.equal(Plan.safeParse({ ...ready, distanceMetres: -1 }).success, false)
  })
})

describe("OptimiseAnswer: the Plan an Optimise request got, and why it is a baseline when it is (#171)", () => {
  test("the optimiser's Plan carries no fallback; a baseline says which rule sent it there", () => {
    const optimised = { ...ready, solver: "optimiser", status: "calculating", distanceMetres: null, durationSeconds: null, fallback: null }
    assert.deepEqual(OptimiseAnswer.parse(optimised), optimised)
    for (const fallback of ["too-many-stops", "no-depot"]) {
      const baseline = { ...ready, status: "calculating", distanceMetres: null, durationSeconds: null, fallback }
      assert.deepEqual(OptimiseAnswer.parse(baseline), baseline)
    }
  })

  test("refuses a fallback outside the vocabulary, and an answer without the member at all", () => {
    assert.equal(OptimiseAnswer.safeParse({ ...ready, fallback: "too-far" }).success, false)
    assert.equal(OptimiseAnswer.safeParse(ready).success, false)
  })
})

describe("ActivePlan: the reading a route carries (#132 §5)", () => {
  test("parses with its staleness and deferral, totals null while measuring", () => {
    const measuring = { id: IDS.id, solver: "manual", status: "calculating", trip: "stops-only", distanceMetres: null, durationSeconds: null, stale: false, deferredUntil: null }
    assert.deepEqual(ActivePlan.parse(measuring), measuring)
    const stale = { ...measuring, status: "ready", distanceMetres: 900, durationSeconds: 90, stale: true }
    assert.deepEqual(ActivePlan.parse(stale), stale)
  })
})
