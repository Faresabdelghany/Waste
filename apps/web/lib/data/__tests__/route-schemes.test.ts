// The status a scheme edit asks the API for on the Pilot (#177): the stored
// one, never lowered by the web's own reading, and Validated for a Draft the
// edit leaves without a blocking issue — the browser path's rule (D31) — so a
// scheme an edit refused midway left a Draft is validated again by the save
// that fixes it.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { validateGuidedScheme } from "@waste/domain/route-schemes/draft"
import { PLANNING_AREA_IDS_KEY, SERVES_TODAY_KEY } from "@waste/domain/route-schemes/matching"
import type { GuidedSchemeData } from "@waste/domain/route-schemes/quick-create"

import { statusLabel } from "../../api/records/adapter"
import { IDLE, type ModuleState, type ModuleStatus } from "../../api/records/server-records"
import type { BusinessRecord } from "../business-modules"
import { containersPlaced, licenceDayOf, ONE_OFF_ALREADY, ONE_OFF_NO_ROUTE, ONE_OFF_ONLY, ONE_OFF_SPLIT, ONE_OFF_UNREAD, PREVIEW_UNPLACED, projectToday, ROUTES_NOT_READ, schemeEditOnApi, schemeEditStatusOnApi, schemeOneOffOnApi, STORED_ONE_OFF, validationWhenUnplaced } from "../route-schemes"

describe("the status a scheme edit asks the API for", () => {
  test("a Validated scheme stays Validated, whatever the web's own validation says: the API's 409 speaks for the rules it holds", () => {
    assert.equal(schemeEditStatusOnApi("Validated", []), "Validated")
    assert.equal(schemeEditStatusOnApi("Validated", ["Pick a driver"]), "Validated")
  })

  test("a Draft the edit leaves without a blocking issue asks to be Validated; one with issues, or without a recurrence to judge, stays a Draft", () => {
    assert.equal(schemeEditStatusOnApi("Draft", []), "Validated")
    assert.equal(schemeEditStatusOnApi("Draft", ["Pick a vehicle"]), "Draft")
    assert.equal(schemeEditStatusOnApi("Draft", null), "Draft")
  })
})

// The wizard's validation on the Pilot (#207): a container the API holds
// carries what the preview's matcher reads — its fraction's and its type's
// names, every planning area containing it, whether a placement serves it
// today (lib/api/records/container-places.ts) — so the zero-match sentence is
// evidence there and blocks as it does in fixture mode.
describe("the wizard's validation over the API's containers", () => {
  const vehicle = { id: "vehicle-wh24", name: "WH-24 · CN 42 018", context: "Rear loader 18 t", facts: {}, submittedValues: { requiredLicenceClass: "C" } }
  const draft = (over: Partial<GuidedSchemeData> = {}): GuidedSchemeData => ({
    schemeName: "Guided · Residual",
    projectId: "project-copenhagen",
    planningAreaId: "area-indre-by",
    wasteFraction: "Residual",
    serviceType: "Kerbside collection",
    frequency: "weekly",
    weekRotation: "odd",
    serviceDays: ["monday", "thursday"],
    effectiveFrom: "2026-10-05",
    effectiveTo: "",
    plannedStartTime: "06:30",
    holidayPolicy: "skip",
    createAs: "validated",
    editPolicy: "ask",
    groups: [{ id: "group-a", name: "Residual · bins", days: ["monday", "thursday"], fractions: ["Residual"], stopSource: "rule", containerTypes: ["Two-wheel bin · 240 L"], containerIds: [], vehicleId: vehicle.id, driverId: "driver-mads" }],
    ...over,
  })
  // As the containers adapter carries one: master data by web id, the names as facts, no movement yet, its place read from its placement.
  const held = (servesToday: "yes" | "no") => ({
    id: "container-01a0d2a4-a280-7014-8000-000000000001",
    name: "BIN-91001",
    status: "No stock record",
    facts: { "Waste fractions": "Residual", "Container type": "Two-wheel bin · 240 L" },
    submittedValues: { wasteFraction: "fraction-01a0d2a4-a280-7007-8000-000000000001", containerType: "container-type-01a0d2a4-a280-7008-8000-000000000002", [PLANNING_AREA_IDS_KEY]: "area-osterbro,area-indre-by", [SERVES_TODAY_KEY]: servesToday },
    projectIds: ["project-copenhagen"],
  })
  const validated = (containers: ReturnType<typeof held>[]) => validateGuidedScheme(draft(), [], [], containers as never, [vehicle as never])

  test("a container a placement serves today inside the area is a stop of the rule, and the draft is Validated", () => {
    const result = validated([held("yes")])
    assert.deepEqual(result.issues, [])
    assert.equal(result.status, "Validated")
  })

  test("with none the rule matches, the zero-match sentence blocks: the draft stays a Draft", () => {
    for (const containers of [[], [held("no")]]) {
      const result = validated(containers)
      assert.equal(result.status, "Draft")
      assert.deepEqual(result.issues, ["No containers currently match the stop rule"], `${containers.length} container(s)`)
    }
  })

  // The zero match is evidence only where the preview had the API's containers placed: the containers and every module
  // their records are read through ready. One not read — loading, failed, or not granted to the role — leaves the
  // preview counting the fixtures' containers, or the API's standing nowhere.
  const state = (status: ModuleStatus): ModuleState => ({ ...IDLE, status })
  const ready = state("ready")
  const throughReady = [ready, ready, ready, ready, ready]

  test("placed: in fixture mode, with the containers not switched, or with every module read", () => {
    assert.equal(containersPlaced(false, state("not-granted"), throughReady), true, "fixture mode")
    assert.equal(containersPlaced(true, null, throughReady), true, "the containers on fixtures")
    assert.equal(containersPlaced(true, ready, throughReady), true)
    assert.equal(containersPlaced(true, ready, [ready, null, ready, ready, ready]), true, "a module still on fixtures says nothing")
  })

  test("not placed: a role granted none of them, or any one not read", () => {
    const grantedNothing = state("not-granted")
    assert.equal(containersPlaced(true, grantedNothing, [grantedNothing, grantedNothing, grantedNothing, grantedNothing, grantedNothing]), false, "a role granted nothing")
    assert.equal(containersPlaced(true, ready, [grantedNothing, ready, ready, ready, ready]), false, "the agreements not granted: no container's place is read")
    for (const status of ["idle", "loading", "failed"] as const) {
      assert.equal(containersPlaced(true, state(status), throughReady), false, `the containers ${status}`)
      assert.equal(containersPlaced(true, ready, [ready, ready, ready, state(status), ready]), false, `the areas ${status}`)
    }
  })

  test("placed, the zero-match sentence blocks as in fixture mode, and no notice is said", () => {
    const own = validated([])
    assert.deepEqual(validationWhenUnplaced(own, true), { ...own, notice: null })
  })

  test("not placed, it is no evidence: dropped, the notice standing in its place, and every other issue still blocks", () => {
    const unplaced = validationWhenUnplaced(validated([]), false)
    assert.deepEqual([unplaced.status, unplaced.issues, unplaced.notice], ["Validated", [], PREVIEW_UNPLACED])
    const withoutDriver = validationWhenUnplaced(validateGuidedScheme(draft({ groups: [{ ...draft().groups[0], driverId: undefined }] }), [], [], [], [vehicle as never]), false)
    assert.deepEqual([withoutDriver.status, withoutDriver.issues, withoutDriver.notice], ["Draft", ["Pick a driver"], PREVIEW_UNPLACED])
    const matched = validationWhenUnplaced(validated([held("yes")]), false)
    assert.equal(matched.notice, null, "nothing to stand in for where the rule matched")
  })
})

// The day a group's driver is judged on, as the API judges it (#178): the
// scheme's first day or today, whichever is later, today on the project's
// clock — not the browser's, which may sit in another timezone or past
// midnight.
describe("the day a group's driver is judged on", () => {
  const lateEvening = new Date("2026-09-30T22:30:00Z") // 00:30 on 1 October in Copenhagen

  test("today is the project's day, in the project's timezone", () => {
    assert.equal(projectToday("Europe/Copenhagen", lateEvening), "2026-10-01")
    assert.equal(projectToday("Europe/Copenhagen", new Date("2026-09-30T21:30:00Z")), "2026-09-30")
    assert.equal(projectToday("America/New_York", lateEvening), "2026-09-30")
  })

  test("the scheme's first day when it is later than today, else today", () => {
    assert.deepEqual(licenceDayOf("2026-10-05", "Europe/Copenhagen", lateEvening), { day: "2026-10-05", meaning: "the scheme starts" })
    assert.deepEqual(licenceDayOf("2026-09-01", "Europe/Copenhagen", lateEvening), { day: "2026-10-01", meaning: "today" })
    assert.deepEqual(licenceDayOf("", "Europe/Copenhagen", lateEvening), { day: "2026-10-01", meaning: "the scheme starts" }, "a draft without a first day is judged on today")
  })
})

// A scheme edit on the Pilot (#179): what the fixture path's reconciliation
// decides, over the routes the API holds — a running scheme's edit that
// shapes a collection asks "How should this change apply?" under "Ask each
// time" while planned routes after today can still follow it, and saves when
// none can. "This collection only" moves the next collection's routes where
// their commands can carry the edit (#209, below), and a scheme whose stored
// policy is that one-off refuses an edit they cannot carry rather than
// applying it scheme-wide. Without the API's routes read (loading, failed)
// the question cannot be asked, so a shaping edit that would ask is refused
// until they are.
describe("a scheme edit on the Pilot", () => {
  const TODAY = "2026-10-01"
  const scheme = (over: Partial<BusinessRecord> = {}, values: BusinessRecord["submittedValues"] = {}): BusinessRecord => ({
    id: "scheme-01a0d2a4-a280-7016-8000-000000000001",
    name: "RS-Central · Week A",
    context: "",
    status: "Validated",
    owner: "",
    value: "",
    updated: "",
    description: "",
    facts: {},
    related: [],
    source: "Waste API",
    freshness: "",
    recordKind: "Route Scheme",
    ...over,
    submittedValues: { editPolicy: "ask", lastGeneratedAt: "2026-09-30T02:00:00.000Z", plannedStartTime: "06:30", ...values },
  })
  // A route as the routes adapter files it: its status token shown as its label, which the domain's rule reads.
  const route = (id: string, serviceDate: string, status: string, schemeId = scheme().id): BusinessRecord => ({ ...scheme(), id, name: id, status: statusLabel(status), recordKind: "Route", submittedValues: { schemeId, serviceDate, status } })
  const routes = [
    route("route-a", "2026-10-02", "planned"),
    route("route-b", "2026-10-05", "planned"),
    route("route-today", TODAY, "planned"),
    route("route-dispatched", "2026-10-02", "ready"),
    route("route-cancelled", "2026-10-06", "cancelled"),
    route("route-other", "2026-10-02", "planned", "scheme-01a0d2a4-a280-7016-8000-000000000002"),
  ]
  const shaped = (before: BusinessRecord) => ({ ...before, submittedValues: { ...before.submittedValues, plannedStartTime: "08:15" } })
  const renamed = (before: BusinessRecord) => ({ ...before, name: `${before.name} (renamed)` })

  test("asks of a running scheme's shaping edit, counting the planned routes after today the API holds for it", () => {
    const before = scheme()
    const decided = schemeEditOnApi(before, shaped(before), routes, TODAY)
    assert.equal(decided.kind, "ask")
    if (decided.kind !== "ask") return
    const { question } = decided
    assert.equal(question.futureRoutes, 2, "tomorrow's and Monday's; not today's, not a dispatched one, not a cancelled one, not another scheme's")
    assert.equal(question.nextCollectionDate, TODAY, "the collection the one-off moves: today's planned route can still take it (#209)")
    assert.equal(question.options.future.label, "Apply to future collections")
    assert.equal(question.options.single.label, "This collection only")
    assert.equal(question.options.single.unavailable, undefined, "a planned start one collection's routes can carry")
    assert.equal(question.options.future.unavailable, undefined)
  })

  test("the answer future saves, counting the routes that follow; the one-off moves the next collection's routes", () => {
    const before = scheme()
    assert.deepEqual(schemeEditOnApi(before, shaped(before), routes, TODAY, "future"), { kind: "save", following: 2 })
    assert.deepEqual(schemeEditOnApi(before, shaped(before), routes, TODAY, "single"), {
      kind: "one-off",
      date: TODAY,
      moves: [{ routeId: "route-today", command: "reschedule", input: { plannedStartTime: "08:15" } }],
      scheme: null,
    })
  })

  test("the stored policy decides: switching off Ask each time in the same save still asks, and a stored future saves without asking", () => {
    const before = scheme()
    const after = { ...shaped(before), submittedValues: { ...shaped(before).submittedValues, editPolicy: "future" } }
    assert.equal(schemeEditOnApi(before, after, routes, TODAY).kind, "ask")
    const stored = scheme({}, { editPolicy: "future" })
    assert.deepEqual(schemeEditOnApi(stored, shaped(stored), routes, TODAY), { kind: "save", following: 2 })
    assert.deepEqual(schemeEditOnApi(stored, shaped(stored), null, TODAY), { kind: "save", following: 0 }, "future needs no routes to decide")
  })

  test("a stored one-off policy moves the next collection where its routes can carry the edit, and refuses it rather than applying it to every future collection where they cannot", () => {
    const stored = scheme({}, { editPolicy: "single" })
    assert.equal(schemeEditOnApi(stored, shaped(stored), routes, TODAY).kind, "one-off")
    const days = { ...stored, submittedValues: { ...stored.submittedValues, serviceDays: "tuesday" } }
    assert.deepEqual(schemeEditOnApi(stored, days, routes, TODAY), { kind: "refuse", message: `${ONE_OFF_ONLY} ${STORED_ONE_OFF}` }, "why, then how to save it")
    assert.deepEqual(schemeEditOnApi(stored, shaped(stored), null, TODAY), { kind: "refuse", message: `${ONE_OFF_UNREAD} ${STORED_ONE_OFF}` }, "the one-off is worked out over the routes")
    assert.deepEqual(schemeEditOnApi(stored, renamed(stored), routes, TODAY), { kind: "save", following: 0 }, "a rename shapes no collection")
  })

  test("without the API's routes read a shaping edit that would ask is refused until they are", () => {
    const before = scheme()
    assert.deepEqual(schemeEditOnApi(before, shaped(before), null, TODAY), { kind: "refuse", message: ROUTES_NOT_READ })
    assert.deepEqual(schemeEditOnApi(before, renamed(before), null, TODAY), { kind: "save", following: 0 })
  })

  test("saves without a question a rename, a scheme never generated, a Draft, or a shaping edit no planned route after today can follow", () => {
    const before = scheme()
    const save = { kind: "save", following: 0 }
    assert.deepEqual(schemeEditOnApi(before, renamed(before), routes, TODAY), save)
    // The edit form writes its display facts by field label ("Departure depot"), which the API's record never carried: the API generates from the values, so a rename still asks nothing.
    assert.deepEqual(schemeEditOnApi(before, { ...renamed(before), facts: { "Departure depot": "Nordhavn Depot", "Operational planning area": "Indre By Operations" } }, routes, TODAY), save)
    const never = scheme({}, { lastGeneratedAt: "" })
    assert.deepEqual(schemeEditOnApi(never, shaped(never), routes, TODAY), save)
    const draft = scheme({ status: "Draft" })
    assert.deepEqual(schemeEditOnApi(draft, shaped(draft), routes, TODAY), save)
    assert.deepEqual(schemeEditOnApi(before, shaped(before), routes.filter((row) => row.id === "route-today" || row.id === "route-dispatched"), TODAY), save)
  })

  test("a rename re-serialising the groups in another key order shapes nothing", () => {
    const groups = [{ id: "group-north", name: "North", days: ["monday"], stopSource: "rule", vehicleId: "vehicle-wh24", containerIds: [] }]
    const before = scheme({}, { collectionGroups: JSON.stringify(groups) })
    const reordered = groups.map(({ vehicleId, stopSource, ...rest }) => ({ ...rest, vehicleId, stopSource }))
    const after = { ...renamed(before), submittedValues: { ...before.submittedValues, collectionGroups: JSON.stringify(reordered) } }
    assert.notEqual(after.submittedValues.collectionGroups, before.submittedValues?.collectionGroups)
    assert.deepEqual(schemeEditOnApi(before, after, routes, TODAY), { kind: "save", following: 0 })
    const moved = { ...before, submittedValues: { ...before.submittedValues, collectionGroups: JSON.stringify([{ ...groups[0], vehicleId: "vehicle-wh31" }]) } }
    assert.equal(schemeEditOnApi(before, moved, routes, TODAY).kind, "ask", "a group's vehicle moved shapes its collections")
  })
})

// "This collection only" on the Pilot (#209): the next collection's routes moved by the office's own commands — a
// reschedule for the planned start, an assign for the depot, the unloading station and a group's vehicle or driver —
// which hold them from later generation runs; the scheme keeps its configuration. Anything else an edit shapes cannot
// be carried by one collection's routes, so the answer is shown disabled with the reason.
describe("This collection only on the Pilot", () => {
  const TODAY = "2026-10-01" // a Thursday
  const groups = [
    { id: "group-north", name: "North", days: ["monday"], fractions: ["Residual"], stopSource: "rule", vehicleId: "vehicle-wh24", driverId: "driver-mads", containerIds: [] },
    { id: "group-south", name: "South", days: ["thursday"], fractions: ["Residual"], stopSource: "rule", vehicleId: "vehicle-wh31", driverId: "driver-lars", containerIds: [] },
  ]
  const scheme = (values: BusinessRecord["submittedValues"] = {}): BusinessRecord => ({
    id: "scheme-01a0d2a4-a280-7016-8000-000000000001",
    name: "RS-Central · Week A",
    context: "",
    status: "Validated",
    owner: "",
    value: "",
    updated: "",
    description: "",
    facts: {},
    related: [],
    source: "Waste API",
    freshness: "",
    recordKind: "Route Scheme",
    submittedValues: {
      editPolicy: "ask",
      lastGeneratedAt: "2026-09-30T02:00:00.000Z",
      frequency: "weekly",
      serviceDays: "monday, thursday",
      plannedStartTime: "06:30",
      depotId: "depot-nordhavn",
      unloadingStationId: "station-arc",
      sameAllDays: false,
      collectionGroups: JSON.stringify(groups),
      ...values,
    },
  })
  const edited = (before: BusinessRecord, values: BusinessRecord["submittedValues"], name = before.name): BusinessRecord => ({ ...before, name, submittedValues: { ...before.submittedValues, ...values } })
  const withGroup = (id: string, over: Record<string, unknown>) => JSON.stringify(groups.map((group) => (group.id === id ? { ...group, ...over } : group)))
  // A route as the routes adapter files it: its group by web id, its day and start, its Planned Assignment by web id.
  const route = (id: string, group: string, serviceDate: string, status = "planned", over: Record<string, string> = {}): BusinessRecord => ({
    ...scheme(),
    id,
    name: id,
    status: statusLabel(status),
    recordKind: "Route",
    submittedValues: {
      schemeId: scheme().id,
      collectionGroupId: group,
      serviceDate,
      operatingDate: serviceDate,
      plannedStartTime: "06:30",
      vehicleId: group === "group-north" ? "vehicle-wh24" : "vehicle-wh31",
      driverId: group === "group-north" ? "driver-mads" : "driver-lars",
      trailerId: "",
      depotId: "depot-nordhavn",
      unloadingStationId: "station-arc",
      status,
      ...over,
    },
  })
  const routes = [
    route("route-south-today", "group-south", TODAY),
    route("route-north-1", "group-north", "2026-10-05"),
    route("route-south-2", "group-south", "2026-10-08"),
    route("route-north-2", "group-north", "2026-10-12"),
    route("route-north-past", "group-north", "2026-09-28"),
    route("route-other-scheme", "group-north", "2026-10-05", "planned", { schemeId: "scheme-01a0d2a4-a280-7016-8000-000000000002" }),
  ]

  test("the planned start moves every group's routes of the next collection, today's planned one included", () => {
    const before = scheme()
    assert.deepEqual(schemeOneOffOnApi(before, edited(before, { plannedStartTime: "08:15" }), routes, TODAY), {
      kind: "one-off",
      date: TODAY,
      moves: [{ routeId: "route-south-today", command: "reschedule", input: { plannedStartTime: "08:15" } }],
      scheme: null,
    })
  })

  test("a group's driver moves that group's next route alone, by an assign naming the driver alone: the command leaves the rest as the route stands", () => {
    const before = scheme()
    const after = edited(before, { collectionGroups: withGroup("group-north", { driverId: "driver-jonas", driverName: "Jonas Lind" }) })
    assert.deepEqual(schemeOneOffOnApi(before, after, routes, TODAY), {
      kind: "one-off",
      date: "2026-10-05",
      moves: [{ routeId: "route-north-1", command: "assign", input: { driverId: "driver-jonas" } }],
      scheme: null,
    })
  })

  test("the depot and a group's vehicle on the same route are one assign; a dispatched route is not the next collection", () => {
    const before = scheme()
    const after = edited(before, { depotId: "depot-amager", collectionGroups: withGroup("group-south", { vehicleId: "vehicle-wh40" }) })
    const onToday = schemeOneOffOnApi(before, after, routes, TODAY)
    assert.deepEqual(onToday.kind === "one-off" ? onToday.moves : null, [{ routeId: "route-south-today", command: "assign", input: { depotId: "depot-amager", vehicleId: "vehicle-wh40" } }])
    const ready = routes.map((row) => (row.id === "route-south-today" ? route("route-south-today", "group-south", TODAY, "ready") : row))
    const depotOnly = schemeOneOffOnApi(before, edited(before, { depotId: "depot-amager" }), ready, TODAY)
    assert.equal(depotOnly.kind === "one-off" ? depotOnly.date : null, "2026-10-05", "the next planned route the change reaches")
  })

  test("a group whose next route is on another day than the collection the rest moves is no one-off: one collection is one date, and its change would be lost", () => {
    const before = scheme()
    const both = edited(before, { plannedStartTime: "08:15", collectionGroups: withGroup("group-north", { driverId: "driver-jonas" }) })
    assert.deepEqual(schemeOneOffOnApi(before, both, routes, TODAY), { kind: "unavailable", message: ONE_OFF_SPLIT })
    const ready = routes.map((row) => (row.id === "route-south-today" ? route("route-south-today", "group-south", TODAY, "ready") : row))
    const twoGroups = edited(before, { collectionGroups: JSON.stringify(groups.map((group) => ({ ...group, driverId: "driver-jonas" }))) })
    assert.deepEqual(schemeOneOffOnApi(before, twoGroups, ready, TODAY), { kind: "unavailable", message: ONE_OFF_SPLIT }, "North next on Monday, South on the 8th")
  })

  test("a route that already stands as edited is told nothing, and a collection whose routes all do has nothing to move", () => {
    const before = scheme()
    const moved = routes.map((row) => (row.id === "route-south-today" ? route("route-south-today", "group-south", TODAY, "planned", { plannedStartTime: "08:15" }) : row))
    assert.deepEqual(schemeOneOffOnApi(before, edited(before, { plannedStartTime: "08:15" }), moved, TODAY), { kind: "unavailable", message: ONE_OFF_ALREADY })
    const decided = schemeOneOffOnApi(before, edited(before, { plannedStartTime: "08:15", depotId: "depot-amager" }), moved, TODAY)
    assert.deepEqual(decided.kind === "one-off" ? decided.moves : null, [{ routeId: "route-south-today", command: "assign", input: { depotId: "depot-amager" } }])
  })

  test("a collection shifted past a holiday is the next one while it runs on or after today", () => {
    const before = scheme()
    const shifted = [route("route-north-shifted", "group-north", "2026-09-28", "planned", { operatingDate: "2026-10-02" }), ...routes]
    const decided = schemeOneOffOnApi(before, edited(before, { collectionGroups: withGroup("group-north", { driverId: "driver-jonas" }) }), shifted, TODAY)
    assert.equal(decided.kind === "one-off" ? decided.moves[0]?.routeId : null, "route-north-shifted")
  })

  test("a start and a station on one route are a reschedule and an assign, in that order", () => {
    const before = scheme()
    const decided = schemeOneOffOnApi(before, edited(before, { plannedStartTime: "07:00", unloadingStationId: "station-amager" }), routes, TODAY)
    assert.deepEqual(decided.kind === "one-off" ? decided.moves.map((move) => move.command) : null, ["reschedule", "assign"])
  })

  test("the legacy shape's one group: its vehicle moves the scheme's next route", () => {
    const before = scheme({ sameAllDays: true, collectionGroups: "", plannedVehicleId: "vehicle-wh24", plannedDriverId: "driver-mads", serviceDays: "thursday" })
    const legacy = [route("route-today", "default", TODAY, "planned", { collectionGroupId: "group-01a0d2a4-a280-7018-8000-000000000001" })]
    const decided = schemeOneOffOnApi(before, edited(before, { plannedVehicleId: "vehicle-wh40" }), legacy, TODAY)
    assert.deepEqual(decided.kind === "one-off" ? decided.moves : null, [{ routeId: "route-today", command: "assign", input: { vehicleId: "vehicle-wh40" } }])
  })

  test("a rename or a policy change in the same save lands on the scheme, which keeps its shaping configuration", () => {
    const before = scheme()
    const decided = schemeOneOffOnApi(before, edited(before, { plannedStartTime: "08:15", editPolicy: "single" }, "RS-Central · Week A (renamed)"), routes, TODAY)
    assert.equal(decided.kind, "one-off")
    if (decided.kind !== "one-off") return
    assert.equal(decided.scheme?.name, "RS-Central · Week A (renamed)")
    assert.equal(decided.scheme?.submittedValues?.editPolicy, "single")
    assert.equal(decided.scheme?.submittedValues?.plannedStartTime, "06:30")
  })

  test("anything else an edit shapes cannot be carried by one collection's routes: the service days, a rule, a provider, a group added", () => {
    const before = scheme()
    for (const [what, values] of [
      ["the days", { serviceDays: "monday, friday", collectionGroups: withGroup("group-south", { days: ["friday"] }) }],
      ["a rule", { collectionGroups: withGroup("group-north", { fractions: ["Glass"] }) }],
      ["a provider", { collectionGroups: withGroup("group-north", { serviceProviderId: "service-provider-nord" }) }],
      ["a group added", { collectionGroups: JSON.stringify([...groups, { ...groups[0], id: "group-east", name: "East" }]) }],
      ["the period", { effectiveTo: "2026-12-31" }],
      ["a start beside the days", { plannedStartTime: "08:15", serviceDays: "monday" }],
    ] as const) {
      assert.deepEqual(schemeOneOffOnApi(before, edited(before, values), routes, TODAY), { kind: "unavailable", message: ONE_OFF_ONLY }, what)
    }
  })

  test("with no planned route from today on that the change reaches, there is nothing to move", () => {
    const before = scheme()
    const north = edited(before, { collectionGroups: withGroup("group-north", { driverId: "driver-jonas" }) })
    assert.deepEqual(schemeOneOffOnApi(before, north, routes.filter((row) => !row.id.startsWith("route-north-") || row.id === "route-north-past"), TODAY), { kind: "unavailable", message: ONE_OFF_NO_ROUTE })
  })

  test("the question offers the one-off where it can move a collection, naming the date it moves, and shows it disabled with the reason where it cannot", () => {
    const before = scheme()
    const north = schemeEditOnApi(before, edited(before, { collectionGroups: withGroup("group-north", { driverId: "driver-jonas" }) }), routes, TODAY)
    assert.equal(north.kind, "ask")
    if (north.kind !== "ask") return
    assert.equal(north.question.nextCollectionDate, "2026-10-05", "North's next route, not the scheme's next day")
    assert.equal(north.question.options.single.unavailable, undefined)
    const days = schemeEditOnApi(before, edited(before, { serviceDays: "monday, friday", collectionGroups: withGroup("group-south", { days: ["friday"] }) }), routes, TODAY)
    assert.equal(days.kind === "ask" ? days.question.options.single.unavailable : null, ONE_OFF_ONLY)
    assert.equal(days.kind === "ask" ? days.question.nextCollectionDate : null, "2026-10-05", "the scheme's next route after today")
  })
})
