// The status a scheme edit asks the API for on the Pilot (#177): the stored
// one, never lowered by the web's own reading, and Validated for a Draft the
// edit leaves without a blocking issue — the browser path's rule (D31) — so a
// scheme an edit refused midway left a Draft is validated again by the save
// that fixes it.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { validateGuidedScheme } from "@waste/domain/route-schemes/draft"
import type { GuidedSchemeData } from "@waste/domain/route-schemes/quick-create"

import { licenceDayOf, PREVIEW_CANNOT_PLACE, projectToday, schemeEditStatusOnApi, validationOnApi } from "../route-schemes"

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
