// The generation job's decisions (Issue #97 part B), held over plain shapes:
// which dates the walk judges and how far it reaches, what becomes of each
// (group, occurrence) and of the routes already there, how a day's stops are
// resolved from what the database answered, what a refresh writes among a
// route's pickups, and when the drift stamp moves. No database and no clock:
// the worker's own tests prove the same rules against Postgres.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { WALK_CAP_DAYS } from "../../route-schemes/generation"
import { ruleSignature } from "../../route-schemes/container-drift"
import type { SchemeCalendar } from "../../route-schemes/occurrences"
import type { SchemeRecurrence } from "../../route-schemes/recurrence"
import {
  compatibilityKey,
  holidayListOf,
  matchStampOf,
  NO_LONGER_PLANS_GROUP,
  NO_LONGER_SERVES_DATE,
  noBoundaryInForce,
  occurrenceNote,
  pickupChanges,
  planRoutes,
  REMOVED_FROM_DAY_PLAN,
  resolveStops,
  ruleMatches,
  ruleMatchSet,
  schemeRecurrenceOf,
  skippedHoliday,
  stampMoved,
  stopRuleSignature,
  walkWindow,
  type ExistingPickup,
  type ExistingRoute,
  type GenerationGroup,
  type PlannedStop,
  type StopCandidate,
  type StopGroup,
  type StopRule,
} from "../generation"

/** Mondays and Thursdays, from October 2026, open-ended. */
const weekly: SchemeRecurrence = { frequency: "weekly", serviceDays: ["monday", "thursday"], effectiveFrom: "2026-10-01", effectiveTo: "" }
const restingWeekend: SchemeCalendar = { holidays: new Map(), weekend: ["saturday", "sunday"] }
/** Thursday 2026-10-08 is a holiday; the Monday after, the 12th, is not. */
const withHoliday: SchemeCalendar = { holidays: new Map([["2026-10-08", "Test Day"]]), weekend: ["saturday", "sunday"] }

const residual: GenerationGroup = { id: "g-residual", position: 1, days: ["monday", "thursday"], stopSource: "rule" }
const glass: GenerationGroup = { id: "g-glass", position: 2, days: ["thursday"], stopSource: "manual" }

const route = (values: Partial<ExistingRoute> & Pick<ExistingRoute, "id" | "serviceDate">): ExistingRoute => ({
  collectionGroupId: residual.id,
  status: "planned",
  cancelledByGeneration: false,
  ...values,
})

describe("walkWindow", () => {
  test("keeps a window inside the cap, caps one past it at WALK_CAP_DAYS after its start, and walks one day of an inverted one", () => {
    assert.deepEqual(walkWindow({ from: "2026-10-01", to: "2026-10-07" }), { from: "2026-10-01", to: "2026-10-07" })
    assert.deepEqual(walkWindow({ from: "2026-10-01", to: "2028-01-01" }), { from: "2026-10-01", to: "2027-10-02" })
    assert.equal(WALK_CAP_DAYS, 366)
    assert.deepEqual(walkWindow({ from: "2026-10-07", to: "2026-10-01" }), { from: "2026-10-07", to: "2026-10-07" })
  })
})

describe("schemeRecurrenceOf and holidayListOf", () => {
  test("the row's validTo, the first day out of force, becomes the domain's effectiveTo, the last day in it; an open end stays open", () => {
    const stored = { frequency: "every-2-weeks" as const, serviceDays: ["monday" as const], weekRotation: "odd" as const, validFrom: "2026-10-01", validTo: "2027-01-01" }
    assert.deepEqual(schemeRecurrenceOf(stored), { frequency: "every-2-weeks", serviceDays: ["monday"], weekRotation: "odd", effectiveFrom: "2026-10-01", effectiveTo: "2026-12-31" })
    assert.deepEqual(schemeRecurrenceOf({ ...stored, frequency: "weekly", weekRotation: null, validTo: null }), { frequency: "weekly", serviceDays: ["monday"], effectiveFrom: "2026-10-01", effectiveTo: "" })
  })

  test("a project without a holiday list reads no holidays whatever its calendars hold; with one, a carried name wins and the list names the rest", () => {
    const rows = [
      { day: "2026-12-25", name: null },
      { day: "2026-12-26", name: "Anden juledag" },
    ]
    assert.equal(holidayListOf(rows, null).size, 0)
    const danish = holidayListOf(rows, "Danish public holidays")
    assert.equal(danish.get("2026-12-25"), "Christmas Day")
    assert.equal(danish.get("2026-12-26"), "Anden juledag")
    assert.equal(holidayListOf([{ day: "2026-07-07", name: null }], "Some other list").get("2026-07-07"), "Holiday", "a day no lookup names is a Holiday")
  })
})

describe("planRoutes", () => {
  test("creates one route per group per occurrence the group runs on, in date then group order, each operating on its recurrence date", () => {
    const plan = planRoutes({ recurrence: weekly, holidayPolicy: "skip", calendar: restingWeekend, window: { from: "2026-10-05", to: "2026-10-11" }, groups: [glass, residual], existingRoutes: [] })
    assert.deepEqual(plan.walk, { from: "2026-10-05", to: "2026-10-11" })
    assert.deepEqual(plan.occurrences.map((occurrence) => occurrence.plannedDate), ["2026-10-05", "2026-10-08"])
    assert.deepEqual(plan.decisions, [
      { kind: "create", groupId: residual.id, serviceDate: "2026-10-05", operatingDate: "2026-10-05", note: null },
      { kind: "create", groupId: residual.id, serviceDate: "2026-10-08", operatingDate: "2026-10-08", note: null },
      { kind: "create", groupId: glass.id, serviceDate: "2026-10-08", operatingDate: "2026-10-08", note: null },
    ])
    assert.equal(plan.holidaysSkipped, 0)
  })

  test("a second run over the same routes refreshes every planned one and creates nothing: the identity is the scheme, the group and the service date", () => {
    const existing = [route({ id: "r1", serviceDate: "2026-10-05" }), route({ id: "r2", serviceDate: "2026-10-08" }), route({ id: "r3", serviceDate: "2026-10-08", collectionGroupId: glass.id })]
    const plan = planRoutes({ recurrence: weekly, holidayPolicy: "skip", calendar: restingWeekend, window: { from: "2026-10-05", to: "2026-10-11" }, groups: [residual, glass], existingRoutes: existing })
    assert.deepEqual(plan.decisions.map((decision) => [decision.kind, "routeId" in decision ? decision.routeId : null]), [
      ["refresh", "r1"],
      ["refresh", "r2"],
      ["refresh", "r3"],
    ])
    assert.ok(plan.decisions.every((decision) => decision.kind === "refresh" && !decision.resurrect))
  })

  test("a shifted holiday keeps the service date as the identity and moves the operating date, with the note; a collected one keeps both with its note", () => {
    const shifted = planRoutes({ recurrence: weekly, holidayPolicy: "shift-next", calendar: withHoliday, window: { from: "2026-10-05", to: "2026-10-11" }, groups: [residual], existingRoutes: [route({ id: "r2", serviceDate: "2026-10-08" })] })
    assert.deepEqual(shifted.decisions[1], { kind: "refresh", routeId: "r2", groupId: residual.id, serviceDate: "2026-10-08", operatingDate: "2026-10-09", note: "Shifted from Thu 8 Oct · Test Day", resurrect: false })
    const collected = planRoutes({ recurrence: weekly, holidayPolicy: "collect", calendar: withHoliday, window: { from: "2026-10-05", to: "2026-10-11" }, groups: [residual], existingRoutes: [] })
    assert.deepEqual(collected.decisions[1], { kind: "create", groupId: residual.id, serviceDate: "2026-10-08", operatingDate: "2026-10-08", note: "Collects on a holiday · Test Day" })
    assert.equal(occurrenceNote({ n: 1, date: "2026-10-05", plannedDate: "2026-10-05", week: 41, status: "planned" }), null)
  })

  test("a skipped holiday writes nothing where no route stands, cancels a planned route with the sentence, leaves a ready one, and is counted once per group that would have run", () => {
    const plan = planRoutes({
      recurrence: weekly,
      holidayPolicy: "skip",
      calendar: withHoliday,
      window: { from: "2026-10-05", to: "2026-10-11" },
      groups: [residual, glass],
      existingRoutes: [route({ id: "r2", serviceDate: "2026-10-08" })],
    })
    assert.deepEqual(plan.decisions.slice(1), [
      { kind: "cancel", routeId: "r2", groupId: residual.id, serviceDate: "2026-10-08", note: "Skipped · Test Day" },
      { kind: "omit", groupId: glass.id, serviceDate: "2026-10-08", note: "Skipped · Test Day" },
    ])
    assert.equal(plan.holidaysSkipped, 2)
    assert.equal(skippedHoliday(undefined), "Skipped · Holiday")
    const ready = planRoutes({ recurrence: weekly, holidayPolicy: "skip", calendar: withHoliday, window: { from: "2026-10-08", to: "2026-10-08" }, groups: [residual], existingRoutes: [route({ id: "r2", serviceDate: "2026-10-08", status: "ready" })] })
    assert.deepEqual(ready.decisions, [{ kind: "leave", routeId: "r2", groupId: residual.id, serviceDate: "2026-10-08", status: "ready" }])
  })

  test("a ready, active or completed route is left; a route a person cancelled is left; one an earlier run cancelled is resurrected when its identity is planned again", () => {
    const plan = planRoutes({
      recurrence: weekly,
      holidayPolicy: "skip",
      calendar: restingWeekend,
      window: { from: "2026-10-05", to: "2026-10-08" },
      groups: [residual, glass],
      existingRoutes: [
        route({ id: "ready", serviceDate: "2026-10-05", status: "ready" }),
        route({ id: "byhand", serviceDate: "2026-10-08", status: "cancelled" }),
        route({ id: "byrun", serviceDate: "2026-10-08", collectionGroupId: glass.id, status: "cancelled", cancelledByGeneration: true }),
      ],
    })
    assert.deepEqual(plan.decisions, [
      { kind: "leave", routeId: "ready", groupId: residual.id, serviceDate: "2026-10-05", status: "ready" },
      { kind: "leave", routeId: "byhand", groupId: residual.id, serviceDate: "2026-10-08", status: "cancelled" },
      { kind: "refresh", routeId: "byrun", groupId: glass.id, serviceDate: "2026-10-08", operatingDate: "2026-10-08", note: null, resurrect: true },
    ])
  })

  test("the cleanup cancels a planned route on a date the scheme no longer serves, and one of a group that no longer runs on a served date, each with its sentence; a ready one and one outside the walk stand", () => {
    const mondaysOnly: SchemeRecurrence = { ...weekly, serviceDays: ["monday"] }
    const plan = planRoutes({
      recurrence: mondaysOnly,
      holidayPolicy: "skip",
      calendar: restingWeekend,
      window: { from: "2026-10-05", to: "2026-10-11" },
      groups: [{ ...residual, days: ["monday"] }, { ...glass, days: [] }],
      existingRoutes: [
        route({ id: "thu", serviceDate: "2026-10-08" }),
        route({ id: "glass-mon", serviceDate: "2026-10-05", collectionGroupId: glass.id }),
        route({ id: "ready-thu", serviceDate: "2026-10-08", collectionGroupId: glass.id, status: "ready" }),
        route({ id: "later", serviceDate: "2026-10-15" }),
      ],
    })
    assert.deepEqual(plan.decisions, [
      { kind: "create", groupId: residual.id, serviceDate: "2026-10-05", operatingDate: "2026-10-05", note: null },
      { kind: "cancel", routeId: "glass-mon", groupId: glass.id, serviceDate: "2026-10-05", note: NO_LONGER_PLANS_GROUP },
      { kind: "cancel", routeId: "thu", groupId: residual.id, serviceDate: "2026-10-08", note: NO_LONGER_SERVES_DATE },
    ])
  })

  test("routes past the cap are never judged: an over-long window neither creates nor cancels beyond WALK_CAP_DAYS", () => {
    const plan = planRoutes({ recurrence: weekly, holidayPolicy: "skip", calendar: restingWeekend, window: { from: "2026-10-05", to: "2029-01-01" }, groups: [residual], existingRoutes: [route({ id: "far", serviceDate: "2028-06-05", collectionGroupId: glass.id })] })
    assert.deepEqual(plan.walk, { from: "2026-10-05", to: "2027-10-06" })
    assert.ok(plan.decisions.every((decision) => decision.serviceDate <= "2027-10-06"))
    assert.equal(plan.decisions.filter((decision) => decision.kind === "cancel").length, 0)
  })
})

/* ---------------------------------- stops ---------------------------------- */

const candidate = (containerId: string, label: string, values: Partial<StopCandidate> = {}): StopCandidate => ({
  containerId,
  label,
  containerTypeId: "type-240",
  wasteFractionId: "residual",
  propertyId: `property-of-${containerId}`,
  sharedCollectionPointId: null,
  located: true,
  contained: true,
  ...values,
})

const residualRule: StopRule = { fractionIds: ["residual"], containerTypeIds: [], vehicleTypeId: null }
const ruleGroup = (id: string, position: number, rule: StopRule): StopGroup => ({ id, position, stopSource: "rule", rule, pickedContainerIds: [] })
const manualGroup = (id: string, position: number, picked: string[]): StopGroup => ({ id, position, stopSource: "manual", rule: null, pickedContainerIds: picked })
const noCompatibility: ReadonlySet<string> = new Set()

describe("ruleMatches and ruleMatchSet", () => {
  test("a rule matches on the fraction, restricts by container type only where it names any, and asks compatibility of the vehicle type it names", () => {
    const compatible = new Set([compatibilityKey("type-240", "rear-loader")])
    assert.equal(ruleMatches(candidate("c1", "BIN-1"), residualRule, noCompatibility), true)
    assert.equal(ruleMatches(candidate("c1", "BIN-1", { wasteFractionId: "paper" }), residualRule, noCompatibility), false)
    assert.equal(ruleMatches(candidate("c1", "BIN-1"), { ...residualRule, containerTypeIds: ["type-660"] }, noCompatibility), false)
    assert.equal(ruleMatches(candidate("c1", "BIN-1"), { ...residualRule, containerTypeIds: ["type-660", "type-240"] }, noCompatibility), true)
    assert.equal(ruleMatches(candidate("c1", "BIN-1"), { ...residualRule, vehicleTypeId: "rear-loader" }, compatible), true)
    assert.equal(ruleMatches(candidate("c1", "BIN-1"), { ...residualRule, vehicleTypeId: "glass-crane" }, compatible), false, "a type with no compatibility row matches no typed rule")
  })

  test("the match set is the contained, located matches in label order, whatever order the database answered them in", () => {
    const candidates = [candidate("c3", "BIN-3"), candidate("c1", "BIN-1"), candidate("c2", "BIN-2", { contained: false }), candidate("c4", "BIN-4", { located: false, contained: false, propertyId: null, sharedCollectionPointId: "point-1" })]
    assert.deepEqual(
      ruleMatchSet(candidates, residualRule, noCompatibility).map((match) => match.containerId),
      ["c1", "c3"],
    )
  })
})

describe("resolveStops", () => {
  test("a rule group's stops are its match set numbered 1..n; a manual group's are its picks in picked order with the day's place and fraction", () => {
    const candidates = [candidate("c2", "BIN-2"), candidate("c1", "BIN-1"), candidate("c9", "BIN-9", { wasteFractionId: "glass", sharedCollectionPointId: "point-9", propertyId: null })]
    const { stops, unlocated } = resolveStops([ruleGroup("residual", 1, residualRule), manualGroup("glass", 2, ["c9"])], candidates, noCompatibility)
    assert.deepEqual(unlocated, [])
    assert.deepEqual(stops.get("residual"), [
      { containerId: "c1", position: 1, propertyId: "property-of-c1", sharedCollectionPointId: null, wasteFractionId: "residual" },
      { containerId: "c2", position: 2, propertyId: "property-of-c2", sharedCollectionPointId: null, wasteFractionId: "residual" },
    ] satisfies PlannedStop[])
    assert.deepEqual(stops.get("glass")?.map((stop) => [stop.containerId, stop.position, stop.sharedCollectionPointId]), [["c9", 1, "point-9"]])
  })

  test("manual groups claim first in position order, then rule groups in position order take what is left: a container is on one route a day", () => {
    const candidates = [candidate("c1", "BIN-1"), candidate("c2", "BIN-2"), candidate("c3", "BIN-3")]
    const { stops } = resolveStops([ruleGroup("first-rule", 1, residualRule), manualGroup("picked", 3, ["c2"]), ruleGroup("second-rule", 2, residualRule)], candidates, noCompatibility)
    assert.deepEqual(stops.get("picked")?.map((stop) => stop.containerId), ["c2"])
    assert.deepEqual(stops.get("first-rule")?.map((stop) => [stop.containerId, stop.position]), [["c1", 1], ["c3", 2]])
    assert.deepEqual(stops.get("second-rule"), [], "the first rule group won every match")
  })

  test("a rule match whose place has no location and a pick with no placement valid that day are unlocated, once each, and get no stop", () => {
    const candidates = [candidate("c1", "BIN-1"), candidate("c5", "BIN-5", { located: false, contained: false })]
    const { stops, unlocated } = resolveStops([ruleGroup("residual", 1, residualRule), manualGroup("picked", 2, ["c5", "c7"]), manualGroup("picked-too", 3, ["c7"])], candidates, noCompatibility)
    assert.deepEqual(unlocated, ["c5", "c7"])
    assert.deepEqual(stops.get("residual")?.map((stop) => stop.containerId), ["c1"])
    // A manual pick is planned as picked, the place aside: c5 has a placement that day, so it is a stop.
    assert.deepEqual(stops.get("picked")?.map((stop) => stop.containerId), ["c5"])
    assert.deepEqual(stops.get("picked-too"), [])
  })

  test("a rule group without a rule, or a day nothing is contained on, plans no stops and reports nothing unlocated it can place", () => {
    const outside = [candidate("c1", "BIN-1", { contained: false })]
    const { stops, unlocated } = resolveStops([ruleGroup("residual", 1, residualRule), { ...ruleGroup("empty", 2, residualRule), rule: null }], outside, noCompatibility)
    assert.deepEqual([stops.get("residual"), stops.get("empty"), unlocated], [[], [], []])
    assert.equal(noBoundaryInForce("2026-10-05"), "No planning area boundary in force on 2026-10-05; rule groups match no containers that day")
  })
})

/* --------------------------------- pickups --------------------------------- */

const stop = (containerId: string, position: number, values: Partial<PlannedStop> = {}): PlannedStop => ({ containerId, position, propertyId: `property-of-${containerId}`, sharedCollectionPointId: null, wasteFractionId: "residual", ...values })
const existingPickup = (id: string, containerId: string, position: number, values: Partial<ExistingPickup> = {}): ExistingPickup => ({
  id,
  containerId,
  position,
  status: "planned",
  reason: null,
  propertyId: `property-of-${containerId}`,
  sharedCollectionPointId: null,
  wasteFractionId: "residual",
  ...values,
})

describe("pickupChanges", () => {
  test("the same stops write nothing; a new stop is inserted; a moved position, place or fraction is updated in place", () => {
    const existing = [existingPickup("p1", "c1", 1), existingPickup("p2", "c2", 2)]
    assert.deepEqual(pickupChanges(existing, [stop("c1", 1), stop("c2", 2)]), { insert: [], update: [], skip: [], unchanged: 2 })
    const changed = pickupChanges(existing, [stop("c0", 1), stop("c1", 2), stop("c2", 3, { wasteFractionId: "paper" })])
    assert.deepEqual(changed.insert, [stop("c0", 1)])
    assert.deepEqual(changed.update, [
      { ...stop("c1", 2), id: "p1", resurrect: false },
      { ...stop("c2", 3, { wasteFractionId: "paper" }), id: "p2", resurrect: false },
    ])
    assert.deepEqual([changed.skip, changed.unchanged], [[], 0])
  })

  test("a planned pickup whose container left the plan is skipped with the sentence, never deleted; one a person decided stands; one an earlier run skipped comes back where the plan holds it", () => {
    const existing = [
      existingPickup("p1", "c1", 1),
      existingPickup("p2", "c2", 2, { status: "skipped", reason: "removed-by-dispatcher" }),
      existingPickup("p3", "c3", 3, { status: "completed" }),
      existingPickup("p4", "c4", 4, { status: "skipped", reason: "regeneration" }),
    ]
    const changes = pickupChanges(existing, [stop("c4", 1), stop("c2", 2)])
    assert.deepEqual(changes.skip, [{ id: "p1", note: REMOVED_FROM_DAY_PLAN }])
    assert.deepEqual(changes.update, [{ ...stop("c4", 1), id: "p4", resurrect: true }])
    assert.deepEqual(changes.insert, [])
    assert.equal(changes.unchanged, 2, "the dispatcher's removal and the completed stop stand, in or out of the plan")
  })
})

/* ---------------------------------- stamps --------------------------------- */

describe("the drift stamp", () => {
  test("the signature is ruleSignature's spelling over the planning area, the sorted fractions, the vehicle type and the sorted container types", () => {
    const rule: StopRule = { fractionIds: ["paper", "residual"], containerTypeIds: ["type-660", "type-240"], vehicleTypeId: "rear-loader" }
    assert.equal(stopRuleSignature(rule, "area-1"), ruleSignature({ fractions: ["residual", "paper"], ruleVehicleType: "rear-loader", containerTypes: ["type-240", "type-660"] }, "area-1"))
    assert.equal(stopRuleSignature(rule, "area-1"), "area-1|paper,residual|rear-loader|type-240,type-660")
    assert.equal(stopRuleSignature(residualRule, null), "|residual||")
  })

  test("the stamp is the rule's own match set on the day, sorted by id, before any other group's claim", () => {
    const candidates = [candidate("c2", "BIN-2"), candidate("c1", "BIN-1"), candidate("c3", "BIN-3", { contained: false })]
    assert.deepEqual(matchStampOf(residualRule, "area-1", candidates, noCompatibility), { ruleSignature: "area-1|residual||", containerIds: ["c1", "c2"] })
  })

  test("a stamp moves when there is none, when the signature differs or when the set differs, and not for the same set in another order", () => {
    const stamp = { ruleSignature: "area-1|residual||", containerIds: ["c1", "c2"] }
    assert.equal(stampMoved(undefined, stamp), true)
    assert.equal(stampMoved(stamp, { ...stamp, containerIds: ["c2", "c1"] }), false)
    assert.equal(stampMoved(stamp, { ...stamp, containerIds: ["c1", "c2", "c3"] }), true)
    assert.equal(stampMoved(stamp, { ...stamp, containerIds: ["c1", "c3"] }), true)
    assert.equal(stampMoved(stamp, { ruleSignature: "area-2|residual||", containerIds: ["c1", "c2"] }), true)
  })
})
