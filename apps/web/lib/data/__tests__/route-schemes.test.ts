// The status a scheme edit asks the API for on the Pilot (#177): the stored
// one, never lowered by the web's own reading, and Validated for a Draft the
// edit leaves without a blocking issue — the browser path's rule (D31) — so a
// scheme an edit refused midway left a Draft is validated again by the save
// that fixes it.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { validateGuidedScheme } from "@waste/domain/route-schemes/draft"
import type { GuidedSchemeData } from "@waste/domain/route-schemes/quick-create"

import { statusLabel } from "../../api/records/adapter"
import type { BusinessRecord } from "../business-modules"
import { licenceDayOf, ONE_OFF_NOT_KEPT, PREVIEW_CANNOT_PLACE, projectToday, ROUTES_NOT_READ, schemeEditOnApi, schemeEditStatusOnApi, STORED_ONE_OFF, validationOnApi } from "../route-schemes"

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

// The wizard's validation on the Pilot (#178): the preview's matcher places
// no container the API holds (#207), so its zero-match sentence says nothing
// about what generation will find; with the API's containers it does not
// block, a notice standing in its place, and every other issue still does.
describe("the wizard's validation where the containers are the API's", () => {
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
  // No container matches: the web cannot place the API's, and the draft is otherwise whole.
  const validated = (over?: Partial<GuidedSchemeData>) => validateGuidedScheme(draft(over), [], [], [], [vehicle as never])

  test("the zero-match sentence blocks the web's own validation, as it does in fixture mode", () => {
    const own = validated()
    assert.equal(own.status, "Draft")
    assert.equal(own.issues.length, 1, own.issues.join(" · "))
    assert.deepEqual(validationOnApi(own, false), { ...own, notice: null })
  })

  test("with the API's containers it does not block: the scheme is Validated and a notice stands in its place", () => {
    const onApi = validationOnApi(validated(), true)
    assert.deepEqual(onApi.issues, [])
    assert.equal(onApi.status, "Validated")
    assert.equal(onApi.notice, PREVIEW_CANNOT_PLACE)
  })

  test("the named sentence of several groups goes the same way", () => {
    const two = draft({
      groups: [
        { ...draft().groups[0], id: "group-a", name: "North", days: ["monday"] },
        { ...draft().groups[0], id: "group-b", name: "South", days: ["thursday"], vehicleId: vehicle.id, driverId: "driver-lars" },
      ],
    })
    const own = validateGuidedScheme(two, [], [], [], [vehicle as never])
    assert.ok(own.issues.some((issue) => issue.includes("North")), own.issues.join(" · "))
    assert.deepEqual(validationOnApi(own, true).issues, [])
  })

  test("every other issue still blocks, and the notice is said only when the zero-match sentence was there", () => {
    const withoutDriver = validationOnApi(validated({ groups: [{ ...draft().groups[0], driverId: undefined }] }), true)
    assert.equal(withoutDriver.status, "Draft")
    assert.deepEqual(withoutDriver.issues, ["Pick a driver"])
    assert.equal(withoutDriver.notice, PREVIEW_CANNOT_PLACE)
    const withoutArea = validationOnApi(validated({ planningAreaId: undefined }), true)
    assert.equal(withoutArea.status, "Draft")
    assert.ok(withoutArea.issues.length > 0, "a rule without a planning area to match inside blocks on the Pilot too")
    assert.equal(withoutArea.notice, null, "with no area the matcher never ran, so there is nothing to stand in for")
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
// none can. The API keeps no one-off yet (#209), so "This collection only" is
// shown disabled, and a scheme whose stored policy is that one-off refuses a
// shaping edit rather than applying it scheme-wide. Without the API's routes
// read (loading, failed) the question cannot be asked, so a shaping edit
// that would ask is refused until they are.
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
    assert.equal(question.nextCollectionDate, "2026-10-02")
    assert.equal(question.options.future.label, "Apply to future collections")
    assert.equal(question.options.single.label, "This collection only")
    assert.equal(question.options.single.unavailable, ONE_OFF_NOT_KEPT)
    assert.equal(question.options.future.unavailable, undefined)
  })

  test("the answer future saves, counting the routes that follow; the one-off, shown disabled, is refused", () => {
    const before = scheme()
    assert.deepEqual(schemeEditOnApi(before, shaped(before), routes, TODAY, "future"), { kind: "save", following: 2 })
    assert.deepEqual(schemeEditOnApi(before, shaped(before), routes, TODAY, "single"), { kind: "refuse", message: ONE_OFF_NOT_KEPT })
  })

  test("the stored policy decides: switching off Ask each time in the same save still asks, and a stored future saves without asking", () => {
    const before = scheme()
    const after = { ...shaped(before), submittedValues: { ...shaped(before).submittedValues, editPolicy: "future" } }
    assert.equal(schemeEditOnApi(before, after, routes, TODAY).kind, "ask")
    const stored = scheme({}, { editPolicy: "future" })
    assert.deepEqual(schemeEditOnApi(stored, shaped(stored), routes, TODAY), { kind: "save", following: 2 })
    assert.deepEqual(schemeEditOnApi(stored, shaped(stored), null, TODAY), { kind: "save", following: 0 }, "future needs no routes to decide")
  })

  test("a stored one-off policy refuses a shaping edit rather than applying it to every future collection", () => {
    const stored = scheme({}, { editPolicy: "single" })
    assert.deepEqual(schemeEditOnApi(stored, shaped(stored), routes, TODAY), { kind: "refuse", message: STORED_ONE_OFF })
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
