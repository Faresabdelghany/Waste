// The edit policy — "Changes to a running scheme" (issue #38): the stored
// choice, what an edit shapes, the routes "ask" counts, and the scheme a
// one-off leaves behind.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord, SubmittedValues } from "../../prototype-record"
import { editChangesGeneration, futureRefreshableRoutes, schemeAfterOneOff, schemeEditPolicy } from "../edit"

/* --------------------------------- fixtures -------------------------------- */

/** The values as a record that never stored `key`. */
const without = (values: SubmittedValues | undefined, key: string): SubmittedValues =>
  Object.fromEntries(Object.entries(values ?? {}).filter(([name]) => name !== key))

const AREA = "area-indreby"
const TODAY = "2026-09-25" // a Friday
const GENERATED_AT = "2026-09-20T06:00:00.000Z"

/** A Scheduled weekly Mon/Wed manual scheme that has generated before; the stored record an edit starts from. */
function scheme(values: Record<string, string | boolean> = {}, facts: Record<string, string> = {}): BusinessRecord {
  return {
    id: "scheme-38",
    name: "RS-38",
    context: "",
    status: "Scheduled",
    owner: "",
    value: "",
    updated: "Now",
    description: "",
    facts: { Vehicle: "WH-24", Driver: "Mads Jensen", ...facts },
    related: [],
    source: "",
    freshness: "Now",
    allowedTransitions: [],
    submittedValues: {
      schemeName: "RS-38",
      planningAreaId: AREA,
      frequency: "weekly",
      serviceDays: "monday, wednesday",
      effectiveFrom: "2026-09-01",
      effectiveTo: "",
      holidayPolicy: "skip",
      plannedVehicleId: "vehicle-wh24",
      plannedDriverId: "driver-mads",
      stopSelection: "manual",
      sameAllDays: true,
      containerIds: "c1, c2",
      planAhead: true,
      lastGeneratedAt: GENERATED_AT,
      editPolicy: "ask",
      ...values,
    },
  }
}

/** The record with some stored values changed — the shape the edit dialog hands the planner. */
const edited = (stored: BusinessRecord, values: Record<string, string | boolean>): BusinessRecord => ({
  ...stored,
  submittedValues: { ...stored.submittedValues, ...values },
})

/** An edit of the planned start time — a value generation reads (the routes' Time window). */
const startAt = (stored: BusinessRecord, time: string) => edited(stored, { plannedStartTime: time })

/** A route of a scheme on a service date, in a status. */
const route = (id: string, schemeId: string, serviceDate: string, status = "Planned"): BusinessRecord => ({
  id,
  name: id,
  context: "",
  status,
  owner: "",
  value: "",
  updated: "",
  description: "",
  facts: {},
  related: [],
  source: "",
  freshness: "",
  allowedTransitions: [],
  submittedValues: { schemeId, serviceDate },
})

/* ------------------------------ the stored policy ------------------------------ */

describe("schemeEditPolicy", () => {
  test("reads the stored choice and asks for a record that predates the field or carries a stray value", () => {
    assert.equal(schemeEditPolicy({ editPolicy: "future" }), "future")
    assert.equal(schemeEditPolicy({ editPolicy: "single" }), "single")
    assert.equal(schemeEditPolicy({ editPolicy: "ask" }), "ask")
    assert.equal(schemeEditPolicy({}), "ask")
    assert.equal(schemeEditPolicy(undefined), "ask")
    assert.equal(schemeEditPolicy({ editPolicy: "always" }), "ask")
    assert.equal(schemeEditPolicy({ editPolicy: true }), "ask")
  })
})

/* ------------------------------ what an edit shapes ------------------------------ */

describe("editChangesGeneration", () => {
  const stored = scheme()

  test("a value generation reads — the start time, a service day, the stops, the effective period — shapes a collection", () => {
    assert.equal(editChangesGeneration(stored, startAt(stored, "08:00")), true)
    assert.equal(editChangesGeneration(stored, edited(stored, { serviceDays: "monday" })), true)
    assert.equal(editChangesGeneration(stored, edited(stored, { effectiveTo: "2026-12-31" })), true)
    assert.equal(editChangesGeneration(stored, edited(stored, { containerIds: "c1" })), true)
    assert.equal(editChangesGeneration(stored, edited(stored, { plannedDriverId: "driver-anna" })), true)
  })

  test("a fact the routes carry — the vehicle, the depot — shapes a collection", () => {
    assert.equal(editChangesGeneration(stored, { ...stored, facts: { ...stored.facts, Vehicle: "WH-25" } }), true)
    assert.equal(
      editChangesGeneration(stored, { ...stored, facts: { ...stored.facts, "Departure depot": "Nord" } }),
      true,
    )
  })

  test("the name, the policy itself and Plan Ahead shape none", () => {
    assert.equal(editChangesGeneration(stored, { ...stored, name: "RS-38 renamed" }), false)
    assert.equal(editChangesGeneration(stored, edited(stored, { editPolicy: "future" })), false)
    assert.equal(editChangesGeneration(stored, edited(stored, { planAhead: false })), false)
  })

  test("an absent value and an empty one are the same value", () => {
    const rest = without(stored.submittedValues, "plannedStartTime")
    assert.equal(
      editChangesGeneration(
        { ...stored, submittedValues: rest },
        { ...stored, submittedValues: { ...rest, plannedStartTime: "" } },
      ),
      false,
    )
  })

  test("an absent boolean and the value its readers take for it are the same value", () => {
    // sameAllDays is read `!== false` everywhere: a record that never stored
    // it IS same-all-days, so the `true` the groups editor writes is no
    // change — and neither is an absent key against an explicit true.
    const rest = without(stored.submittedValues, "sameAllDays")
    const never = { ...stored, submittedValues: rest }
    assert.equal(editChangesGeneration(never, { ...stored, submittedValues: { ...rest, sameAllDays: true } }), false)
    assert.equal(editChangesGeneration({ ...stored, submittedValues: { ...rest, sameAllDays: true } }, never), false)
    // Only an explicit false is the other value.
    assert.equal(editChangesGeneration(never, { ...stored, submittedValues: { ...rest, sameAllDays: false } }), true)
    assert.equal(editChangesGeneration(stored, edited(stored, { sameAllDays: false })), true)
  })
})

/* ------------------------------ what ask counts ------------------------------ */

test("futureRefreshableRoutes counts the scheme's Draft and Planned routes from tomorrow and nothing else", () => {
  const stored = scheme()
  const routes = [
    route("route-other", "scheme-other", "2026-09-28"),
    route("route-today", stored.id, TODAY),
    route("route-active", stored.id, "2026-10-05", "Active"),
    route("route-draft", stored.id, "2026-10-07", "Draft"),
    route("route-planned", stored.id, "2026-09-28"),
  ]
  assert.deepEqual(
    futureRefreshableRoutes(stored.id, TODAY, routes).map((candidate) => candidate.id),
    ["route-draft", "route-planned"],
  )
})

/* --------------------------------- one-offs --------------------------------- */

test("schemeAfterOneOff keeps the stored configuration and takes the name and the non-shaping values", () => {
  const stored = scheme()
  const after = {
    ...startAt(stored, "08:00"),
    name: "Renamed",
    facts: { ...stored.facts, Vehicle: "WH-25" },
    submittedValues: { ...stored.submittedValues, plannedStartTime: "08:00", serviceDays: "friday", editPolicy: "single", planAhead: false },
  }
  const kept = schemeAfterOneOff(stored, after)
  assert.equal(kept.name, "Renamed")
  assert.equal(kept.facts.Vehicle, "WH-24")
  assert.equal(kept.submittedValues?.serviceDays, "monday, wednesday")
  assert.equal(kept.submittedValues?.plannedStartTime, undefined)
  assert.equal(kept.submittedValues?.editPolicy, "single")
  assert.equal(kept.submittedValues?.planAhead, false)
})
