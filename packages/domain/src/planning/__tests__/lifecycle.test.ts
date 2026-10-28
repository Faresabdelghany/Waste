// A Route Scheme's lifecycle on the API (O21 of #290), over plain shapes: the
// first day an archive or a new version may take effect, the Plan Ahead
// window's bounds and its run window, and what ending a scheme from a day
// does to its routes. The API's own tests prove the writes against Postgres.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { ExistingRoute } from "../generation"
import {
  firstEndingDay,
  PLAN_AHEAD_DAYS_DEFAULT,
  PLAN_AHEAD_DAYS_MAX,
  planAheadDaysAllowed,
  planAheadRunWindow,
  routesEndedFrom,
  SCHEME_ARCHIVED_NOTE,
  supersededNote,
} from "../lifecycle"

const route = (id: string, serviceDate: string, values: Partial<ExistingRoute> = {}): ExistingRoute => ({
  id,
  collectionGroupId: "group-1",
  serviceDate,
  operatingDate: serviceDate,
  status: "planned",
  cancelledByGeneration: false,
  held: false,
  officeStops: false,
  ...values,
})

describe("the day an ending takes effect", () => {
  test("is tomorrow at the earliest: today's routes are already operating", () => {
    assert.equal(firstEndingDay("2026-10-28"), "2026-10-29")
    assert.equal(firstEndingDay("2026-12-31"), "2027-01-01")
  })
})

describe("the Plan Ahead window", () => {
  test("defaults to the week it always was, and is held to 1..28 whole days", () => {
    assert.equal(PLAN_AHEAD_DAYS_DEFAULT, 7)
    assert.equal(PLAN_AHEAD_DAYS_MAX, 28)
    assert.ok(planAheadDaysAllowed(1) && planAheadDaysAllowed(7) && planAheadDaysAllowed(28))
    assert.ok(!planAheadDaysAllowed(0) && !planAheadDaysAllowed(29) && !planAheadDaysAllowed(2.5))
  })

  test("runs from tomorrow through the scheme's number of days", () => {
    assert.deepEqual(planAheadRunWindow("2026-10-28", 7), { from: "2026-10-29", to: "2026-11-04" })
    assert.deepEqual(planAheadRunWindow("2026-10-28", 1), { from: "2026-10-29", to: "2026-10-29" })
    assert.deepEqual(planAheadRunWindow("2026-10-28", 14), { from: "2026-10-29", to: "2026-11-11" })
  })
})

describe("ending a scheme from a day", () => {
  test("cancels its planned routes from that day on and leaves the ones before it", () => {
    const ended = routesEndedFrom([route("r1", "2026-10-28"), route("r2", "2026-10-29"), route("r3", "2027-03-01")], "2026-10-29", SCHEME_ARCHIVED_NOTE)
    assert.deepEqual(ended.decisions, [
      { kind: "cancel", routeId: "r2", groupId: "group-1", serviceDate: "2026-10-29", note: SCHEME_ARCHIVED_NOTE },
      { kind: "cancel", routeId: "r3", groupId: "group-1", serviceDate: "2027-03-01", note: SCHEME_ARCHIVED_NOTE },
    ])
    assert.equal(ended.kept, 0)
  })

  test("trims a planned route that carries an open stop the office added, rather than cancel it under the stop", () => {
    const ended = routesEndedFrom([route("r1", "2026-11-02", { officeStops: true })], "2026-10-29", SCHEME_ARCHIVED_NOTE)
    assert.deepEqual(ended.decisions, [{ kind: "trim", routeId: "r1", groupId: "group-1", serviceDate: "2026-11-02", note: SCHEME_ARCHIVED_NOTE }])
  })

  test("cancels a held route too, since the scheme no longer runs that collection", () => {
    const ended = routesEndedFrom([route("r1", "2026-11-02", { held: true, operatingDate: "2026-11-03" })], "2026-10-29", SCHEME_ARCHIVED_NOTE)
    assert.deepEqual(ended.decisions.map((decision) => decision.kind), ["cancel"])
  })

  test("leaves a route that ran or is about to as it stands, and counts the dispatched and running ones it kept", () => {
    const ended = routesEndedFrom(
      [
        route("ready", "2026-10-30", { status: "ready" }),
        route("active", "2026-10-30", { status: "active" }),
        route("completed", "2026-10-30", { status: "completed" }),
        route("cancelled", "2026-10-30", { status: "cancelled" }),
        route("run", "2026-10-30", { status: "cancelled", cancelledByGeneration: true }),
      ],
      "2026-10-29",
      SCHEME_ARCHIVED_NOTE,
    )
    assert.deepEqual(ended.decisions, [])
    assert.equal(ended.kept, 2, "the ready and the active route, which the office cancels by hand if it must")
  })

  test("orders the decisions by service date, then by id", () => {
    const ended = routesEndedFrom([route("b", "2026-11-02"), route("a", "2026-11-02"), route("c", "2026-11-01")], "2026-10-29", SCHEME_ARCHIVED_NOTE)
    assert.deepEqual(ended.decisions.map((decision) => decision.routeId), ["c", "a", "b"])
  })

  test("a new version's cut-off names the day it takes over", () => {
    assert.equal(supersededNote("2027-01-01"), "Superseded by the scheme's next version from 2027-01-01")
  })
})
