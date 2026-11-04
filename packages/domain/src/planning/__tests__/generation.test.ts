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
import type { TankGate } from "../../route-schemes/due-from-last"
import type { SchemeRecurrence } from "../../route-schemes/recurrence"
import {
  compatibilityKey,
  holidayListOf,
  holidayReleases,
  keptOffHoliday,
  matchAreas,
  matchStampOf,
  NO_LONGER_PLANS_GROUP,
  NO_LONGER_SERVES_DATE,
  noBoundaryInForce,
  noGroupBoundaryInForce,
  occurrenceNote,
  pickupChanges,
  planRoutes,
  REMOVED_FROM_DAY_PLAN,
  resolveStops,
  ruleAreaOf,
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
  held: false,
  officeStops: false,
  operatingDate: values.serviceDate,
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

  test("the rows' seasons become the domain's, a null rotation left out; no seasons is none", () => {
    const stored = { frequency: "weekly" as const, serviceDays: ["monday" as const], weekRotation: null, validFrom: "2026-10-01", validTo: null }
    const seasons = [
      { name: "Winter", startsOn: "11-01", endsOn: "04-01", frequency: "every-2-weeks" as const, weekRotation: "odd" as const },
      { name: "Spring", startsOn: "04-01", endsOn: "05-01", frequency: "every-3-weeks" as const, weekRotation: null },
    ]
    assert.deepEqual(schemeRecurrenceOf({ ...stored, seasons }).seasons, [
      { name: "Winter", startsOn: "11-01", endsOn: "04-01", frequency: "every-2-weeks", weekRotation: "odd" },
      { name: "Spring", startsOn: "04-01", endsOn: "05-01", frequency: "every-3-weeks" },
    ])
    assert.equal("seasons" in schemeRecurrenceOf({ ...stored, seasons: [] }), false)
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

  test("under skip, a route the office held off its holiday stays on the day it was moved to, its note saying so; one held on the holiday, or moved without a hold, is cancelled (#226)", () => {
    const skip = (existing: ExistingRoute) => planRoutes({ recurrence: weekly, holidayPolicy: "skip", calendar: withHoliday, window: { from: "2026-10-08", to: "2026-10-08" }, groups: [residual], existingRoutes: [existing] })
    const kept = skip(route({ id: "r2", serviceDate: "2026-10-08", operatingDate: "2026-10-09", held: true }))
    assert.deepEqual(kept.decisions, [{ kind: "refresh", routeId: "r2", groupId: residual.id, serviceDate: "2026-10-08", operatingDate: "2026-10-09", note: "Kept on Fri 9 Oct by the office, off Test Day", resurrect: false }])
    assert.equal(kept.holidaysSkipped, 0, "the collection runs on the office's day: no holiday skipped")
    assert.equal(keptOffHoliday("2026-10-09", undefined), "Kept on Fri 9 Oct by the office, off Holiday")
    for (const existing of [route({ id: "r2", serviceDate: "2026-10-08", held: true }), route({ id: "r2", serviceDate: "2026-10-08", operatingDate: "2026-10-09" })]) {
      assert.deepEqual(skip(existing).decisions, [{ kind: "cancel", routeId: "r2", groupId: residual.id, serviceDate: "2026-10-08", note: "Skipped · Test Day" }], JSON.stringify(existing))
    }
  })

  test("a holiday input releases a held route the scheme's own decision moves under it, and keeps one the office put elsewhere unless its day becomes one the scheme moves off (#226)", () => {
    const shiftNext = (calendar: SchemeCalendar) => ({ holidayPolicy: "shift-next" as const, calendar })
    const held = (serviceDate: string, operatingDate = serviceDate) => ({ serviceDate, operatingDate })
    // Held by an assign on Thursday 8 Oct, which becomes a holiday: its neighbours move to Friday, so it is released to move with them.
    assert.equal(holidayReleases(held("2026-10-08"), shiftNext(restingWeekend), shiftNext(withHoliday)), true)
    // The holiday taken away again: a route held where the shift put it goes back with its neighbours.
    assert.equal(holidayReleases(held("2026-10-08", "2026-10-09"), shiftNext(withHoliday), shiftNext(restingWeekend)), true)
    // A list renamed names its days anew and moves none of them.
    assert.equal(holidayReleases(held("2026-10-08", "2026-10-09"), shiftNext(withHoliday), shiftNext({ ...withHoliday, holidays: new Map([["2026-10-08", "Renamed Day"]]) })), false)
    // A holiday on another day, or one collected on, moves nothing under it.
    assert.equal(holidayReleases(held("2026-10-12"), shiftNext(restingWeekend), shiftNext(withHoliday)), false)
    assert.equal(holidayReleases(held("2026-10-08"), { holidayPolicy: "collect", calendar: restingWeekend }, { holidayPolicy: "collect", calendar: withHoliday }), false)
    // Under skip the collection goes, so the route held on it is released for the run to cancel.
    assert.equal(holidayReleases(held("2026-10-08"), { holidayPolicy: "skip", calendar: restingWeekend }, { holidayPolicy: "skip", calendar: withHoliday }), true)
    // A policy change re-decides the holiday: a route held where shift-next put it reads as moved by nobody once the policy is skip.
    assert.equal(holidayReleases(held("2026-10-08", "2026-10-09"), shiftNext(withHoliday), { holidayPolicy: "skip", calendar: withHoliday }), true)
    assert.equal(holidayReleases(held("2026-10-12"), shiftNext(withHoliday), { holidayPolicy: "skip", calendar: withHoliday }), false)
    // A weekend change moves a shift's landing day: the route held where the shift landed is released.
    const fridayHoliday: SchemeCalendar = { holidays: new Map([["2026-10-09", "Test Day"]]), weekend: ["saturday", "sunday"] }
    assert.equal(holidayReleases(held("2026-10-09", "2026-10-12"), shiftNext(fridayHoliday), shiftNext({ ...fridayHoliday, weekend: ["sunday"] })), true)
    // The office moved Thursday's collection to Friday: a holiday on Thursday leaves the office's day alone ...
    assert.equal(holidayReleases(held("2026-10-08", "2026-10-09"), shiftNext(restingWeekend), shiftNext(withHoliday)), false)
    // ... a holiday on the Friday it chose releases it, the scheme moving a collection off that day ...
    assert.equal(holidayReleases(held("2026-10-08", "2026-10-09"), shiftNext(restingWeekend), shiftNext(fridayHoliday)), true)
    // ... unless the policy collects on holidays, or the day was one the scheme moved off already when the office chose it.
    assert.equal(holidayReleases(held("2026-10-08", "2026-10-09"), { holidayPolicy: "collect", calendar: restingWeekend }, { holidayPolicy: "collect", calendar: fridayHoliday }), false)
    assert.equal(holidayReleases(held("2026-10-08", "2026-10-09"), shiftNext(fridayHoliday), shiftNext({ ...fridayHoliday, weekend: ["sunday"] })), false)
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

  test("a planned route carrying an open stop the office added is trimmed, never cancelled, by the cleanup and by a skipped holiday: the route stays for the office's stop (#111)", () => {
    const mondaysOnly: SchemeRecurrence = { ...weekly, serviceDays: ["monday"] }
    const cleanup = planRoutes({
      recurrence: mondaysOnly,
      holidayPolicy: "skip",
      calendar: restingWeekend,
      window: { from: "2026-10-05", to: "2026-10-11" },
      groups: [{ ...residual, days: ["monday"] }],
      existingRoutes: [route({ id: "mon", serviceDate: "2026-10-05" }), route({ id: "thu", serviceDate: "2026-10-08", officeStops: true })],
    })
    assert.deepEqual(cleanup.decisions, [
      { kind: "refresh", routeId: "mon", groupId: residual.id, serviceDate: "2026-10-05", operatingDate: "2026-10-05", note: null, resurrect: false },
      { kind: "trim", routeId: "thu", groupId: residual.id, serviceDate: "2026-10-08", note: NO_LONGER_SERVES_DATE },
    ])
    const holiday = planRoutes({ recurrence: weekly, holidayPolicy: "skip", calendar: withHoliday, window: { from: "2026-10-08", to: "2026-10-08" }, groups: [residual], existingRoutes: [route({ id: "r2", serviceDate: "2026-10-08", officeStops: true })] })
    assert.deepEqual(holiday.decisions, [{ kind: "trim", routeId: "r2", groupId: residual.id, serviceDate: "2026-10-08", note: "Skipped · Test Day" }])
    assert.equal(holiday.holidaysSkipped, 1, "the scheme's collection is skipped all the same; only the office's stop keeps the route")
    // A route still planned by the scheme is refreshed as ever, the office's stop or not: pickupChanges leaves the stop alone.
    const served = planRoutes({ recurrence: weekly, holidayPolicy: "skip", calendar: restingWeekend, window: { from: "2026-10-05", to: "2026-10-05" }, groups: [residual], existingRoutes: [route({ id: "mon", serviceDate: "2026-10-05", officeStops: true })] })
    assert.deepEqual(served.decisions.map((decision) => decision.kind), ["refresh"])
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
  containedIn: ["area-1"],
  paused: false,
  tank: null,
  ...values,
})

const residualRule: StopRule = { fractionIds: ["residual"], containerTypeIds: [], vehicleTypeId: null, planningAreaId: "area-1" }
const ruleGroup = (id: string, position: number, rule: StopRule): StopGroup => ({ id, position, stopSource: "rule", rule, pickedContainerIds: [] })
const manualGroup = (id: string, position: number, picked: string[]): StopGroup => ({ id, position, stopSource: "manual", rule: null, pickedContainerIds: picked })
const noCompatibility: ReadonlySet<string> = new Set()
/** A day no tank is judged on: no candidate of these tests is a tank unless it says so. */
const ANY_DAY: TankGate = { day: "2026-06-01", held: new Set() }

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
    const candidates = [candidate("c3", "BIN-3"), candidate("c1", "BIN-1"), candidate("c2", "BIN-2", { containedIn: [] }), candidate("c4", "BIN-4", { located: false, containedIn: [], propertyId: null, sharedCollectionPointId: "point-1" })]
    assert.deepEqual(
      ruleMatchSet(candidates, residualRule, noCompatibility).map((match) => match.containerId),
      ["c1", "c3"],
    )
  })
})

describe("a rule's own planning area (O30 of #290, row 2.17)", () => {
  test("a rule matches within the area it names: a candidate inside another area is not its, and a rule with no area matches nothing", () => {
    const candidates = [candidate("c1", "BIN-1", { containedIn: ["area-1", "area-north"] }), candidate("c2", "BIN-2"), candidate("c3", "BIN-3", { containedIn: ["area-north"] })]
    assert.deepEqual(ruleMatchSet(candidates, residualRule, noCompatibility).map((match) => match.containerId), ["c1", "c2"])
    assert.deepEqual(ruleMatchSet(candidates, { ...residualRule, planningAreaId: "area-north" }, noCompatibility).map((match) => match.containerId), ["c1", "c3"])
    assert.deepEqual(ruleMatchSet(candidates, { ...residualRule, planningAreaId: null }, noCompatibility), [])
  })

  test("two rule groups of one day, each within its own area, take their own containers; the first in position order still wins one inside both", () => {
    const candidates = [candidate("c1", "BIN-1", { containedIn: ["area-1", "area-north"] }), candidate("c2", "BIN-2"), candidate("c3", "BIN-3", { containedIn: ["area-north"] })]
    const { stops } = resolveStops([ruleGroup("south", 1, residualRule), ruleGroup("north", 2, { ...residualRule, planningAreaId: "area-north" })], candidates, noCompatibility, ANY_DAY)
    assert.deepEqual(stops.get("south")?.map((stop) => stop.containerId), ["c1", "c2"])
    assert.deepEqual(stops.get("north")?.map((stop) => stop.containerId), ["c3"])
  })

  test("the areas a day's candidates are judged against: the scheme's and every rule group's own, each once", () => {
    assert.deepEqual(matchAreas("area-1", [{ planningAreaId: null }, { planningAreaId: "area-north" }, { planningAreaId: "area-north" }]), ["area-1", "area-north"])
    assert.deepEqual(matchAreas(null, [{ planningAreaId: null }]), [])
    assert.deepEqual(matchAreas(null, [{ planningAreaId: "area-north" }]), ["area-north"])
    assert.equal(ruleAreaOf("area-1", null), "area-1")
    assert.equal(ruleAreaOf("area-1", "area-north"), "area-north")
    assert.equal(ruleAreaOf(null, null), null)
  })

  test("a day a group's own area has no boundary in force is said by the group's name", () => {
    assert.equal(noGroupBoundaryInForce("North", "2026-10-05"), "No boundary of collection group North's planning area in force on 2026-10-05; it matches no containers that day")
  })
})

describe("resolveStops", () => {
  test("a rule group's stops are its match set numbered 1..n; a manual group's are its picks in picked order with the day's place and fraction", () => {
    const candidates = [candidate("c2", "BIN-2"), candidate("c1", "BIN-1"), candidate("c9", "BIN-9", { wasteFractionId: "glass", sharedCollectionPointId: "point-9", propertyId: null })]
    const { stops, unlocated } = resolveStops([ruleGroup("residual", 1, residualRule), manualGroup("glass", 2, ["c9"])], candidates, noCompatibility, ANY_DAY)
    assert.deepEqual(unlocated, [])
    assert.deepEqual(stops.get("residual"), [
      { containerId: "c1", position: 1, propertyId: "property-of-c1", sharedCollectionPointId: null, wasteFractionId: "residual" },
      { containerId: "c2", position: 2, propertyId: "property-of-c2", sharedCollectionPointId: null, wasteFractionId: "residual" },
    ] satisfies PlannedStop[])
    assert.deepEqual(stops.get("glass")?.map((stop) => [stop.containerId, stop.position, stop.sharedCollectionPointId]), [["c9", 1, "point-9"]])
  })

  test("manual groups claim first in position order, then rule groups in position order take what is left: a container is on one route a day", () => {
    const candidates = [candidate("c1", "BIN-1"), candidate("c2", "BIN-2"), candidate("c3", "BIN-3")]
    const { stops } = resolveStops([ruleGroup("first-rule", 1, residualRule), manualGroup("picked", 3, ["c2"]), ruleGroup("second-rule", 2, residualRule)], candidates, noCompatibility, ANY_DAY)
    assert.deepEqual(stops.get("picked")?.map((stop) => stop.containerId), ["c2"])
    assert.deepEqual(stops.get("first-rule")?.map((stop) => [stop.containerId, stop.position]), [["c1", 1], ["c3", 2]])
    assert.deepEqual(stops.get("second-rule"), [], "the first rule group won every match")
  })

  test("a rule match whose place has no location and a pick with no placement valid that day are unlocated, once each, and get no stop — a pick a manual group planned is not among them, though a rule wanted it too", () => {
    const candidates = [candidate("c1", "BIN-1"), candidate("c5", "BIN-5", { located: false, containedIn: [] })]
    const { stops, unlocated } = resolveStops([ruleGroup("residual", 1, residualRule), manualGroup("picked", 2, ["c5", "c7"]), manualGroup("picked-too", 3, ["c7"])], candidates, noCompatibility, ANY_DAY)
    assert.deepEqual(unlocated, ["c7"], "c7 has no placement that day and gets no stop; c5 is planned by the pick, so the rule that would have wanted it does not count it unlocated")
    assert.deepEqual(stops.get("residual")?.map((stop) => stop.containerId), ["c1"])
    // A manual pick is planned as picked, the place aside: c5 has a placement that day, so it is a stop.
    assert.deepEqual(stops.get("picked")?.map((stop) => stop.containerId), ["c5"])
    assert.deepEqual(stops.get("picked-too"), [])
  })

  test("a container a manual group planned is not counted unlocated for a rule group that would have wanted it: it has a stop, written from the pick's place, and the run's count is of containers nobody planned", () => {
    // c5's place has no geometry; a manual group picks it and a rule group's fraction matches it. One stop on the manual group, nothing unlocated.
    const candidates = [candidate("c1", "BIN-1"), candidate("c5", "BIN-5", { located: false, containedIn: [] })]
    const { stops, unlocated } = resolveStops([manualGroup("picked", 1, ["c5"]), ruleGroup("residual", 2, residualRule)], candidates, noCompatibility, ANY_DAY)
    assert.deepEqual(stops.get("picked")?.map((stop) => stop.containerId), ["c5"])
    assert.deepEqual(stops.get("residual")?.map((stop) => stop.containerId), ["c1"])
    assert.deepEqual(unlocated, [], "planned by the pick, so not unlocated for the rule")
    // The same container with no manual group wanting it is unlocated as before; group order does not matter, since manual groups claim first whatever their position.
    assert.deepEqual(resolveStops([ruleGroup("residual", 1, residualRule)], candidates, noCompatibility, ANY_DAY).unlocated, ["c5"])
    assert.deepEqual(resolveStops([ruleGroup("residual", 1, residualRule), manualGroup("picked", 2, ["c5"])], candidates, noCompatibility, ANY_DAY).unlocated, [])
  })

  test("a container whose subscription is paused that day (#291) has no stop from a manual group or a rule group, and is not unlocated: it is not wanted, not lost", () => {
    const candidates = [
      candidate("c1", "BIN-1"),
      candidate("c2", "BIN-2", { paused: true }),
      candidate("c3", "BIN-3", { paused: true, located: false, containedIn: [] }),
      candidate("c4", "BIN-4", { paused: true }),
    ]
    const { stops, unlocated } = resolveStops([manualGroup("picked", 1, ["c4", "c1"]), ruleGroup("residual", 2, residualRule)], candidates, noCompatibility, ANY_DAY)
    assert.deepEqual(stops.get("picked")?.map((stop) => [stop.containerId, stop.position]), [["c1", 1]], "the paused pick is passed over, and the next takes its position")
    assert.deepEqual(stops.get("residual"), [], "c1 is the pick's, and the rest are paused")
    assert.deepEqual(unlocated, [], "a paused container is not one nobody could place, located or not")
    assert.deepEqual(
      ruleMatchSet(candidates, residualRule, noCompatibility).map((match) => match.containerId),
      ["c1", "c2", "c4"],
      "the drift stamp still reads what the rule matches: a pause is not drift",
    )
  })

  test("a tank (M11 of #293) is planned from its due date on, once: before it, or with a stop held on an earlier date, it waits like a pause — no stop, not unlocated, still in the drift stamp", () => {
    const tank = (lastEmptiedOn: string | null) => ({ lastEmptiedOn, intervalMonths: 12 })
    const candidates = [
      candidate("c1", "TANK-1", { tank: tank("2025-06-01") }),
      candidate("c2", "TANK-2", { tank: tank("2025-07-01") }),
      candidate("c3", "TANK-3", { tank: tank(null) }),
      candidate("c4", "TANK-4", { tank: tank("2025-01-01") }),
      candidate("c5", "TANK-5", { tank: tank("2025-07-01"), located: false, containedIn: [] }),
      candidate("c6", "BIN-6"),
    ]
    const gate: TankGate = { day: "2026-06-01", held: new Set(["c4"]) }
    const { stops, unlocated } = resolveStops([manualGroup("picked", 1, ["c2"]), ruleGroup("residual", 2, residualRule)], candidates, noCompatibility, gate)
    assert.deepEqual(stops.get("picked"), [], "c2 is due on 1 July: its pick waits")
    assert.deepEqual(stops.get("residual")?.map((stop) => stop.containerId), ["c6", "c1", "c3"], "in label order: a bin that is no tank, the tank due on the day, and the one never emptied")
    assert.deepEqual(unlocated, [], "a tank that waits is not wanted that day, so not unlocated")
    assert.deepEqual(resolveStops([ruleGroup("residual", 1, residualRule)], candidates, noCompatibility, { day: "2026-07-01", held: new Set() }).unlocated, ["c5"], "once due, a tank with no location is")
    assert.deepEqual(
      ruleMatchSet(candidates, residualRule, noCompatibility).map((match) => match.containerId),
      ["c6", "c1", "c2", "c3", "c4"],
      "the drift stamp reads what the rule matches: waiting is not drift",
    )
  })

  test("a rule group without a rule, or a day nothing is contained on, plans no stops and reports nothing unlocated it can place", () => {
    const outside = [candidate("c1", "BIN-1", { containedIn: [] })]
    const { stops, unlocated } = resolveStops([ruleGroup("residual", 1, residualRule), { ...ruleGroup("empty", 2, residualRule), rule: null }], outside, noCompatibility, ANY_DAY)
    assert.deepEqual([stops.get("residual"), stops.get("empty"), unlocated], [[], [], []])
    assert.equal(noBoundaryInForce("2026-10-05"), "No planning area boundary in force on 2026-10-05; rule groups match no containers that day")
  })
})

/* --------------------------------- pickups --------------------------------- */

const stop = (containerId: string, position: number, values: Partial<PlannedStop> = {}): PlannedStop => ({ containerId, position, propertyId: `property-of-${containerId}`, sharedCollectionPointId: null, wasteFractionId: "residual", ...values })
const existingPickup = (id: string, containerId: string | null, position: number, values: Partial<ExistingPickup> = {}): ExistingPickup => ({
  id,
  containerId,
  position,
  origin: "generation",
  service: "empty",
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

  test("a stop the office added is never skipped as no longer planned and never moved, an address-only one included, and a container it holds is not planned onto the route a second time (#111)", () => {
    const existing = [
      existingPickup("p1", "c1", 1),
      // The office's: a container the plan no longer holds, at a position the plan now gives another stop, and an address-only stop.
      existingPickup("o1", "c7", 2, { origin: "office" }),
      existingPickup("o2", null, 3, { origin: "office", propertyId: "property-9", wasteFractionId: "bulky" }),
      // The office's again: a container the plan holds too, which the office's stop stands for.
      existingPickup("o3", "c3", 4, { origin: "office" }),
    ]
    const changes = pickupChanges(existing, [stop("c2", 1), stop("c1", 2), stop("c3", 3)])
    assert.deepEqual(changes.insert, [stop("c2", 1)], "c3 is the office's stop already")
    assert.deepEqual(changes.update, [{ ...stop("c1", 2), id: "p1", resurrect: false }])
    assert.deepEqual(changes.skip, [])
    assert.equal(changes.unchanged, 3, "each of the office's three stands as the office left it, counted once")
    // A plan that holds nothing any more skips the run's own stop and none of the office's.
    assert.deepEqual(pickupChanges(existing, []).skip, [{ id: "p1", note: REMOVED_FROM_DAY_PLAN }])
  })

  test("an office emptying beside generation's own stop of the container — an extra emptying — leaves that stop refreshed as any other: moved, brought back, never frozen (O3 of #290)", () => {
    const existing = [
      existingPickup("p1", "c1", 1),
      existingPickup("p2", "c2", 2, { status: "skipped", reason: "regeneration" }),
      existingPickup("o1", "c1", 3, { origin: "office" }),
      existingPickup("o2", "c2", 4, { origin: "office" }),
    ]
    const changes = pickupChanges(existing, [stop("c2", 1), stop("c1", 2, { wasteFractionId: "paper" })])
    assert.deepEqual(changes.update, [
      { ...stop("c2", 1), id: "p2", resurrect: true },
      { ...stop("c1", 2, { wasteFractionId: "paper" }), id: "p1", resurrect: false },
    ])
    assert.deepEqual([changes.insert, changes.skip], [[], []])
  })

  test("an office stop that empties nothing — a repair, a wash — leaves the plan's emptying of its container to go on the route beside it (O3 of #290)", () => {
    const existing = [existingPickup("o1", "c1", 1, { origin: "office", service: "repair" }), existingPickup("o2", "c2", 2, { origin: "office", service: "wash" }), existingPickup("o3", "c3", 3, { origin: "office" })]
    const changes = pickupChanges(existing, [stop("c1", 1), stop("c2", 2), stop("c3", 3)])
    assert.deepEqual(changes.insert, [stop("c1", 1), stop("c2", 2)], "the repaired and the washed are emptied too; the office's emptying of c3 stands for the plan's")
    assert.equal(changes.unchanged, 3)
  })
})

/* ---------------------------------- stamps --------------------------------- */

describe("the drift stamp", () => {
  test("the signature is ruleSignature's spelling over the planning area, the sorted fractions, the vehicle type and the sorted container types", () => {
    const rule: StopRule = { fractionIds: ["paper", "residual"], containerTypeIds: ["type-660", "type-240"], vehicleTypeId: "rear-loader", planningAreaId: "area-1" }
    assert.equal(stopRuleSignature(rule), ruleSignature({ fractions: ["residual", "paper"], ruleVehicleType: "rear-loader", containerTypes: ["type-240", "type-660"] }, "area-1"))
    assert.equal(stopRuleSignature(rule), "area-1|paper,residual|rear-loader|type-240,type-660")
    assert.equal(stopRuleSignature({ ...residualRule, planningAreaId: null }), "|residual||")
    assert.equal(stopRuleSignature({ ...residualRule, planningAreaId: "area-north" }), "area-north|residual||", "a group's own area is part of what its matches depend on (O30 of #290)")
  })

  test("the stamp is the rule's own match set on the day, sorted by id, before any other group's claim", () => {
    const candidates = [candidate("c2", "BIN-2"), candidate("c1", "BIN-1"), candidate("c3", "BIN-3", { containedIn: [] })]
    assert.deepEqual(matchStampOf(residualRule, candidates, noCompatibility), { ruleSignature: "area-1|residual||", containerIds: ["c1", "c2"] })
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
