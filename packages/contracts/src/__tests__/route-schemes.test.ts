import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  CollectionGroup,
  CollectionGroupContainersSet,
  CollectionGroupCreate,
  CollectionGroupPatch,
  CONTAINERS_MAX,
  DAILY_SERVES_EVERY_DAY,
  EACH_CONTAINER_ONCE,
  EACH_FRACTION_ONCE,
  Occurrence,
  OccurrenceQuery,
  ONE_WAY_TO_FIND_STOPS,
  OUTSIDE_SERVICE_DAYS,
  RouteScheme,
  RouteSchemeCreate,
  RouteSchemeListQuery,
  RouteSchemePatch,
  StopMatchingRule,
  StopMatchingRuleSet,
  WEEK_ROTATION_WITH_FORTNIGHTLY,
  WINDOW_AT_MOST_A_YEAR,
  WINDOW_ORDERED,
} from "../route-schemes"
import { refusal, refusesAnEmptyPatch, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const FOURTH = "01a0d3a5-e5e0-7000-8000-000000000004"
const STAMPS = { createdAt: "2026-09-24T13:41:00.000Z", updatedAt: "2026-09-24T13:41:00.000Z" }
const BACKWARDS = "validTo is the first day out of force, so it comes after validFrom"
const ALL_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

const rule = { wasteFractionIds: [THIRD], containerTypeIds: [FOURTH], vehicleType: "rear-loader" }

const ruleGroup = { id: ID, routeSchemeId: OTHER, name: "Rear loaders", position: 1, days: ["monday", "thursday"], stopSource: "rule", rule, containerIds: [], serviceProviderId: THIRD, ...STAMPS }
const manualGroup = { id: OTHER, routeSchemeId: OTHER, name: "By hand", position: 2, days: ["monday"], stopSource: "manual", rule: null, containerIds: [THIRD, FOURTH], serviceProviderId: null, ...STAMPS }

const scheme = {
  id: OTHER,
  projectId: THIRD,
  name: "Residual weekly",
  planningAreaId: FOURTH,
  serviceType: "container-collection",
  frequency: "weekly",
  serviceDays: ["monday", "thursday"],
  weekRotation: null,
  plannedStartTime: "06:30",
  holidayPolicy: "shift-next",
  editPolicy: "ask",
  planAhead: true,
  status: "validated",
  collectionGroups: [ruleGroup, manualGroup],
  validFrom: "2026-01-01",
  validTo: null,
  ...STAMPS,
}

/** N distinct ids in the test's own bucket. */
const manyIds = (n: number) => Array.from({ length: n }, (_, i) => `01a0d3a5-e5e0-7000-8000-${(0x100000 + i).toString(16).padStart(12, "0")}`)

describe("StopMatchingRule", () => {
  test("names one or more fractions, none or more container types, and a vehicle type or null", () => {
    assert.deepEqual(StopMatchingRule.parse(rule), rule)
    const anyVehicle = { wasteFractionIds: [THIRD, FOURTH], containerTypeIds: [], vehicleType: null }
    assert.deepEqual(StopMatchingRule.parse(anyVehicle), anyVehicle)
    assert.equal(StopMatchingRuleSet, StopMatchingRule, "the PUT body is the rule itself")
  })

  test("refuses no fraction, a fraction twice, a type twice, and a member it does not carry", () => {
    assert.deepEqual(refusal(StopMatchingRule.safeParse({ ...rule, wasteFractionIds: [] })).map((issue) => issue.path), ["wasteFractionIds"])
    assert.deepEqual(refusal(StopMatchingRule.safeParse({ ...rule, wasteFractionIds: [THIRD, THIRD] })), [{ path: "wasteFractionIds", message: EACH_FRACTION_ONCE }])
    assert.deepEqual(refusal(StopMatchingRule.safeParse({ ...rule, containerTypeIds: [FOURTH, FOURTH] })).map((issue) => issue.path), ["containerTypeIds"])
    assert.match(refusal(StopMatchingRule.safeParse({ ...rule, planningAreaId: FOURTH }))[0].message, /planningAreaId/)
    assert.equal(StopMatchingRule.safeParse({ ...rule, vehicleType: "Rear loader" }).success, false)
  })
})

describe("CollectionGroup", () => {
  test("is a rule group with its rule and no containers, or a manual group with its containers in stop order and no rule", () => {
    assert.deepEqual(CollectionGroup.parse(ruleGroup), ruleGroup)
    assert.deepEqual(CollectionGroup.parse(manualGroup), manualGroup)
    const stopped = { ...ruleGroup, days: [] }
    assert.deepEqual(CollectionGroup.parse(stopped), stopped, "a group that no longer runs keeps its row with no days")
  })

  test("holds the position to a whole positive number and the days to distinct weekdays", () => {
    for (const position of [0, -1, 1.5]) assert.equal(CollectionGroup.safeParse({ ...ruleGroup, position }).success, false, String(position))
    assert.deepEqual(refusal(CollectionGroup.safeParse({ ...ruleGroup, days: ["monday", "monday"] })).map((issue) => issue.path), ["days"])
  })
})

describe("CollectionGroupCreate", () => {
  const byRule = { name: "Rear loaders", days: ["monday", "thursday"], stopSource: "rule", rule }
  const byHand = { name: "By hand", days: ["monday"], stopSource: "manual", containerIds: [THIRD, FOURTH] }

  test("takes a rule group or a manual group, the position appended when absent, and mints nothing", () => {
    assert.deepEqual(CollectionGroupCreate.parse(byRule), byRule)
    assert.deepEqual(CollectionGroupCreate.parse({ ...byHand, position: 2, serviceProviderId: THIRD }), { ...byHand, position: 2, serviceProviderId: THIRD })
    assert.match(CollectionGroupCreate.shape.position.description ?? "", /after the last/)
    refusesWhatTheServerOwns(CollectionGroupCreate, byRule)
    assert.match(refusal(CollectionGroupCreate.safeParse({ ...byRule, routeSchemeId: OTHER }))[0].message, /routeSchemeId/)
  })

  test("finds its stops one way: a rule group carries a rule and no containers, a manual group at least one container and no rule", () => {
    const oneWay = { path: "stopSource", message: ONE_WAY_TO_FIND_STOPS }
    assert.deepEqual(refusal(CollectionGroupCreate.safeParse({ ...byRule, rule: null })), [oneWay], "a rule group without a rule")
    assert.deepEqual(refusal(CollectionGroupCreate.safeParse({ ...byRule, containerIds: [THIRD] })), [oneWay], "a rule group that also picks")
    assert.deepEqual(refusal(CollectionGroupCreate.safeParse({ ...byHand, containerIds: [] })), [oneWay], "a manual group that picks nothing")
    assert.deepEqual(refusal(CollectionGroupCreate.safeParse({ name: "By hand", days: ["monday"], stopSource: "manual" })), [oneWay], "or has no list at all")
    assert.deepEqual(refusal(CollectionGroupCreate.safeParse({ ...byHand, rule })), [oneWay], "a manual group with a rule")
  })

  test("takes the unused half as null or empty, which is what a form with both fields sends", () => {
    assert.deepEqual(CollectionGroupCreate.parse({ ...byRule, containerIds: [] }), { ...byRule, containerIds: [] })
    assert.deepEqual(CollectionGroupCreate.parse({ ...byRule, containerIds: null }), { ...byRule, containerIds: null })
    assert.deepEqual(CollectionGroupCreate.parse({ ...byHand, rule: null }), { ...byHand, rule: null })
  })

  test("holds the picked list to distinct containers and at most 200", () => {
    assert.deepEqual(refusal(CollectionGroupCreate.safeParse({ ...byHand, containerIds: [THIRD, THIRD] })), [{ path: "containerIds", message: EACH_CONTAINER_ONCE }])
    assert.equal(CollectionGroupCreate.safeParse({ ...byHand, containerIds: manyIds(CONTAINERS_MAX) }).success, true)
    assert.deepEqual(refusal(CollectionGroupCreate.safeParse({ ...byHand, containerIds: manyIds(CONTAINERS_MAX + 1) })).map((issue) => issue.path), ["containerIds"])
  })
})

describe("CollectionGroupPatch and CollectionGroupContainersSet", () => {
  test("a patch moves the name, the order, the days and the provider, and never the source, the rule or the list", () => {
    assert.deepEqual(CollectionGroupPatch.parse({ name: "Side loaders", position: 3, days: [], serviceProviderId: null }), { name: "Side loaders", position: 3, days: [], serviceProviderId: null })
    refusesAnEmptyPatch(CollectionGroupPatch)
    for (const key of ["stopSource", "rule", "containerIds", "routeSchemeId"]) {
      assert.match(refusal(CollectionGroupPatch.safeParse({ name: "x", [key]: "manual" }))[0].message, new RegExp(key))
    }
  })

  test("the containers set is the whole list in stop order, at least one, each once, at most 200", () => {
    assert.deepEqual(CollectionGroupContainersSet.parse({ containerIds: [FOURTH, THIRD] }), { containerIds: [FOURTH, THIRD] })
    assert.deepEqual(refusal(CollectionGroupContainersSet.safeParse({ containerIds: [] })).map((issue) => issue.path), ["containerIds"])
    assert.deepEqual(refusal(CollectionGroupContainersSet.safeParse({ containerIds: [THIRD, THIRD] })), [{ path: "containerIds", message: EACH_CONTAINER_ONCE }])
    assert.equal(CollectionGroupContainersSet.safeParse({ containerIds: manyIds(CONTAINERS_MAX + 1) }).success, false)
    assert.match(refusal(CollectionGroupContainersSet.safeParse({ containerIds: [THIRD], rule }))[0].message, /rule/)
  })
})

describe("RouteScheme", () => {
  test("is the row on the wire with its groups by position and the period it plans for", () => {
    assert.deepEqual(RouteScheme.parse(scheme), scheme)
    const fortnightly = { ...scheme, frequency: "every-2-weeks", weekRotation: "odd", plannedStartTime: null, validTo: "2027-01-01" }
    assert.deepEqual(RouteScheme.parse(fortnightly), fortnightly)
  })

  test("carries none of the readings: no scheduled, effective or expired status, no lastGeneratedAt until part B", () => {
    for (const reading of ["scheduled", "effective", "expired"]) assert.equal(RouteScheme.safeParse({ ...scheme, status: reading }).success, false, reading)
    assert.equal(Object.keys(RouteScheme.shape).includes("lastGeneratedAt"), false)
  })

  test("holds the period, the rotation and the days on the way out too", () => {
    assert.deepEqual(refusal(RouteScheme.safeParse({ ...scheme, validTo: "2026-01-01" })), [{ path: "validTo", message: BACKWARDS }])
    assert.deepEqual(refusal(RouteScheme.safeParse({ ...scheme, weekRotation: "odd" })), [{ path: "weekRotation", message: WEEK_ROTATION_WITH_FORTNIGHTLY }])
    assert.deepEqual(refusal(RouteScheme.safeParse({ ...scheme, serviceDays: [] })).map((issue) => issue.path), ["serviceDays"])
    assert.equal(RouteScheme.safeParse({ ...scheme, plannedStartTime: "06:30:00" }).success, false, "a time of day carries no seconds")
  })
})

describe("RouteSchemeCreate", () => {
  const group = { name: "Rear loaders", days: ["monday", "thursday"], stopSource: "rule", rule }
  const body = {
    projectId: THIRD,
    name: "Residual weekly",
    serviceType: "container-collection",
    frequency: "weekly",
    serviceDays: ["monday", "thursday"],
    collectionGroups: [group],
    validFrom: "2026-01-01",
  }
  const defaults = { holidayPolicy: "skip", editPolicy: "ask", planAhead: true, status: "draft" }

  test("defaults the policies, plan ahead and the status, says so in the schema, and mints nothing", () => {
    assert.deepEqual(RouteSchemeCreate.parse(body), { ...body, ...defaults })
    for (const key of ["holidayPolicy", "editPolicy", "planAhead", "status"] as const) assert.ok(RouteSchemeCreate.shape[key].description, key)
    assert.match(RouteSchemeCreate.shape.status.description ?? "", /draft/)
    refusesWhatTheServerOwns(RouteSchemeCreate, body)
  })

  test("needs the project, a name, a service type, a cadence, a day, a group and a first day", () => {
    for (const key of Object.keys(body)) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(RouteSchemeCreate.safeParse(without)).map((issue) => issue.path), [key], key)
    }
    assert.deepEqual(refusal(RouteSchemeCreate.safeParse({ ...body, collectionGroups: [] })).map((issue) => issue.path), ["collectionGroups"], "the implicit group is a row: at least one")
    // An empty set fails the scheme's own rule and puts every group's days outside it; a group with no days is outside nothing.
    assert.deepEqual(refusal(RouteSchemeCreate.safeParse({ ...body, serviceDays: [] })).map((issue) => issue.path), ["serviceDays", "collectionGroups.0.days"])
    assert.deepEqual(refusal(RouteSchemeCreate.safeParse({ ...body, serviceDays: [], collectionGroups: [{ ...group, days: [] }] })).map((issue) => issue.path), ["serviceDays"])
  })

  test("gives the week rotation with every-2-weeks and with nothing else", () => {
    const rotation = { path: "weekRotation", message: WEEK_ROTATION_WITH_FORTNIGHTLY }
    assert.deepEqual(refusal(RouteSchemeCreate.safeParse({ ...body, weekRotation: "odd" })), [rotation], "weekly with a rotation")
    assert.deepEqual(refusal(RouteSchemeCreate.safeParse({ ...body, frequency: "every-2-weeks" })), [rotation], "fortnightly without one")
    assert.deepEqual(refusal(RouteSchemeCreate.safeParse({ ...body, frequency: "every-2-weeks", weekRotation: null })), [rotation], "or with null")
    assert.equal(RouteSchemeCreate.safeParse({ ...body, frequency: "every-2-weeks", weekRotation: "even" }).success, true)
    assert.equal(RouteSchemeCreate.safeParse({ ...body, weekRotation: null }).success, true, "null on a weekly scheme is the resource's spelling of none")
  })

  test("a daily scheme serves every weekday", () => {
    const daily = { path: "serviceDays", message: DAILY_SERVES_EVERY_DAY }
    assert.deepEqual(refusal(RouteSchemeCreate.safeParse({ ...body, frequency: "daily" })), [daily])
    assert.equal(RouteSchemeCreate.safeParse({ ...body, frequency: "daily", serviceDays: ALL_DAYS }).success, true)
    assert.equal(RouteSchemeCreate.safeParse({ ...body, frequency: "daily", serviceDays: [...ALL_DAYS].reverse() }).success, true, "in any order")
  })

  test("every group's days lie within the scheme's, refused at that group's days", () => {
    const groups = [group, { ...group, name: "Fridays", days: ["friday"] }, { ...group, name: "Weekend", days: ["monday", "saturday"] }]
    assert.deepEqual(refusal(RouteSchemeCreate.safeParse({ ...body, collectionGroups: groups })), [
      { path: "collectionGroups.1.days", message: OUTSIDE_SERVICE_DAYS },
      { path: "collectionGroups.2.days", message: OUTSIDE_SERVICE_DAYS },
    ])
    assert.equal(RouteSchemeCreate.safeParse({ ...body, collectionGroups: [group, { ...group, name: "Stopped", days: [] }] }).success, true, "a group with no days is within any")
  })

  test("holds each group to its own rules at its own path, and the period to the ordering rule", () => {
    assert.deepEqual(refusal(RouteSchemeCreate.safeParse({ ...body, collectionGroups: [{ ...group, rule: null }] })), [{ path: "collectionGroups.0.stopSource", message: ONE_WAY_TO_FIND_STOPS }])
    assert.deepEqual(refusal(RouteSchemeCreate.safeParse({ ...body, validTo: "2026-01-01" })), [{ path: "validTo", message: BACKWARDS }])
  })
})

describe("RouteSchemePatch", () => {
  test("changes everything but the project, the groups and the stamps", () => {
    const patch = { name: "Residual, twice weekly", planningAreaId: null, serviceType: "kerbside-collection", plannedStartTime: "07:00", holidayPolicy: "collect", editPolicy: "future", planAhead: false, status: "validated", validFrom: "2026-02-01", validTo: null }
    assert.deepEqual(RouteSchemePatch.parse(patch), patch)
    refusesAnEmptyPatch(RouteSchemePatch)
    for (const key of ["projectId", "collectionGroups", "id", "updatedAt"]) {
      assert.match(refusal(RouteSchemePatch.safeParse({ name: "x", [key]: "y" }))[0].message, new RegExp(key))
    }
  })

  test("holds the recurrence rules where the patch carries both halves, and leaves a half to the route", () => {
    assert.deepEqual(refusal(RouteSchemePatch.safeParse({ frequency: "weekly", weekRotation: "odd" })), [{ path: "weekRotation", message: WEEK_ROTATION_WITH_FORTNIGHTLY }])
    assert.deepEqual(refusal(RouteSchemePatch.safeParse({ frequency: "every-2-weeks", weekRotation: null })), [{ path: "weekRotation", message: WEEK_ROTATION_WITH_FORTNIGHTLY }])
    assert.deepEqual(RouteSchemePatch.parse({ weekRotation: "odd" }), { weekRotation: "odd" }, "the cadence is the stored row's to judge")
    assert.deepEqual(RouteSchemePatch.parse({ frequency: "every-2-weeks" }), { frequency: "every-2-weeks" })
    assert.deepEqual(refusal(RouteSchemePatch.safeParse({ frequency: "daily", serviceDays: ["monday"] })), [{ path: "serviceDays", message: DAILY_SERVES_EVERY_DAY }])
    assert.deepEqual(RouteSchemePatch.parse({ frequency: "daily" }), { frequency: "daily" })
    assert.deepEqual(refusal(RouteSchemePatch.safeParse({ validFrom: "2026-02-01", validTo: "2026-01-01" })), [{ path: "validTo", message: BACKWARDS }])
    assert.deepEqual(refusal(RouteSchemePatch.safeParse({ serviceDays: [] })).map((issue) => issue.path), ["serviceDays"])
  })
})

describe("RouteSchemeListQuery", () => {
  test("takes a page, the project, the area, the status, plan ahead as a query-string boolean, and the day in force", () => {
    assert.deepEqual(RouteSchemeListQuery.parse({}), { limit: 50 })
    assert.deepEqual(RouteSchemeListQuery.parse({ projectId: THIRD, planningAreaId: FOURTH, status: "validated", planAhead: "true", validOn: "2026-06-01", limit: "10" }), {
      projectId: THIRD,
      planningAreaId: FOURTH,
      status: "validated",
      planAhead: true,
      validOn: "2026-06-01",
      limit: 10,
    })
    assert.equal(RouteSchemeListQuery.parse({ planAhead: "false" }).planAhead, false)
    assert.equal(RouteSchemeListQuery.safeParse({ planAhead: "yes" }).success, false)
    assert.equal(RouteSchemeListQuery.safeParse({ status: "effective" }).success, false, "a reading is asked for with validOn")
  })
})

describe("OccurrenceQuery and Occurrence", () => {
  test("the window has both ends, to on or after from, at most 366 days apart", () => {
    assert.deepEqual(OccurrenceQuery.parse({ from: "2026-01-01", to: "2026-01-01" }), { from: "2026-01-01", to: "2026-01-01" })
    assert.deepEqual(OccurrenceQuery.parse({ from: "2026-01-01", to: "2027-01-02" }), { from: "2026-01-01", to: "2027-01-02" }, "366 days")
    assert.deepEqual(refusal(OccurrenceQuery.safeParse({ from: "2026-01-02", to: "2026-01-01" })), [{ path: "to", message: WINDOW_ORDERED }])
    assert.deepEqual(refusal(OccurrenceQuery.safeParse({ from: "2026-01-01", to: "2027-01-03" })), [{ path: "to", message: WINDOW_AT_MOST_A_YEAR }])
    assert.deepEqual(refusal(OccurrenceQuery.safeParse({ from: "2026-01-01" })).map((issue) => issue.path), ["to"])
  })

  test("an occurrence is the domain's shape: n null on a skipped row, the note the holiday's name", () => {
    const planned = { n: 1, date: "2026-01-05", plannedDate: "2026-01-05", week: 2, status: "planned" }
    assert.deepEqual(Occurrence.parse(planned), planned)
    const shifted = { n: 2, date: "2026-06-08", plannedDate: "2026-06-05", week: 24, status: "shifted", note: "Grundlovsdag" }
    assert.deepEqual(Occurrence.parse(shifted), shifted)
    const skipped = { n: null, date: "2026-06-05", plannedDate: "2026-06-05", week: 23, status: "skipped", note: "Grundlovsdag" }
    assert.deepEqual(Occurrence.parse(skipped), skipped)
    assert.equal(Occurrence.safeParse({ ...planned, status: "cancelled" }).success, false)
    assert.equal(Occurrence.safeParse({ ...planned, week: 54 }).success, false)
  })
})
