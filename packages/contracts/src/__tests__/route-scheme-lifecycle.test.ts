// A Route Scheme's lifecycle on the wire (O21 of #290): the Plan Ahead window
// on the create and the patch, the archive and successor bodies, and the list
// query's `archived`.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { PLAN_AHEAD_DAYS_BOUND, RouteSchemeArchive, RouteSchemeCreate, RouteSchemeListQuery, RouteSchemePatch, RouteSchemeSuccessorCreate } from "../route-schemes"
import { refusal } from "./expect"

const PROJECT = "01a0d3a5-e5e0-7000-8000-000000000001"
const FRACTION = "01a0d3a5-e5e0-7000-8000-000000000002"

const create = {
  projectId: PROJECT,
  name: "Residual",
  serviceType: "container-collection",
  frequency: "weekly",
  serviceDays: ["monday"],
  validFrom: "2026-01-01",
  collectionGroups: [{ name: "Residual", days: ["monday"], stopSource: "rule", rule: { wasteFractionIds: [FRACTION], containerTypeIds: [], vehicleTypeId: null } }],
}

describe("the Plan Ahead window on the wire", () => {
  test("a create defaults it to the week, and takes 1..28 whole days", () => {
    assert.equal(RouteSchemeCreate.parse(create).planAheadDays, 7)
    assert.equal(RouteSchemeCreate.parse({ ...create, planAheadDays: 14 }).planAheadDays, 14)
    assert.equal(RouteSchemeCreate.parse({ ...create, planAheadDays: 28 }).planAheadDays, 28)
    assert.deepEqual(refusal(RouteSchemeCreate.safeParse({ ...create, planAheadDays: 29 })), [{ path: "planAheadDays", message: PLAN_AHEAD_DAYS_BOUND }])
    assert.deepEqual(refusal(RouteSchemeCreate.safeParse({ ...create, planAheadDays: 0 })).map((issue) => issue.path), ["planAheadDays"])
    assert.deepEqual(refusal(RouteSchemeCreate.safeParse({ ...create, planAheadDays: 1.5 })).map((issue) => issue.path), ["planAheadDays"])
  })

  test("a patch may move it alone, and the archive mark is the server's", () => {
    assert.deepEqual(RouteSchemePatch.parse({ planAheadDays: 3 }), { planAheadDays: 3 })
    assert.deepEqual(refusal(RouteSchemePatch.safeParse({ planAheadDays: 3, archivedAt: "2026-10-28T12:00:00Z" })).map((issue) => issue.path), [""])
    assert.deepEqual(refusal(RouteSchemeCreate.safeParse({ ...create, archivedAt: null })).map((issue) => issue.path), [""])
  })
})

describe("the archive and the successor", () => {
  test("an archive's body may be empty, or name the first day the scheme no longer runs", () => {
    assert.deepEqual(RouteSchemeArchive.parse({}), {})
    assert.deepEqual(RouteSchemeArchive.parse({ effectiveFrom: "2026-11-02" }), { effectiveFrom: "2026-11-02" })
    assert.deepEqual(refusal(RouteSchemeArchive.safeParse({ effectiveFrom: "next week" })).map((issue) => issue.path), ["effectiveFrom"])
    assert.deepEqual(refusal(RouteSchemeArchive.safeParse({ cancelRoutes: false })).map((issue) => issue.path), [""])
  })

  test("a successor names the day it takes over, and nothing else", () => {
    assert.deepEqual(RouteSchemeSuccessorCreate.parse({ validFrom: "2027-01-01" }), { validFrom: "2027-01-01" })
    assert.deepEqual(refusal(RouteSchemeSuccessorCreate.safeParse({})).map((issue) => issue.path), ["validFrom"])
    assert.deepEqual(refusal(RouteSchemeSuccessorCreate.safeParse({ validFrom: "2027-01-01", name: "Residual 2027" })).map((issue) => issue.path), [""])
  })

  test("the list asks for the archived schemes, or the ones still planning, by a boolean spelled exactly", () => {
    assert.equal(RouteSchemeListQuery.parse({ archived: "true" }).archived, true)
    assert.equal(RouteSchemeListQuery.parse({ archived: "false" }).archived, false)
    assert.equal(RouteSchemeListQuery.parse({}).archived, undefined)
    assert.deepEqual(refusal(RouteSchemeListQuery.safeParse({ archived: "yes" })).map((issue) => issue.path), ["archived"])
  })
})
