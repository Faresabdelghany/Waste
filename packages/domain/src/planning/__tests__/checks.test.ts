// The structural rules of a validated Route Scheme (Issue #97), held over
// plain shapes: every sentence the API's 409 lists, in the order it lists
// them, and the two-groups-one-day rule that refuses a container by its
// position in the list.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  alreadyPicked,
  containerPickedTwice,
  manualWithoutContainer,
  NO_PLANNING_AREA_FOR_RULE,
  ruleWithoutFraction,
  schemeStructureIssues,
  serviceDaysWithoutGroup,
  type GroupStructure,
  type SchemeStructure,
} from "../checks"

const rule = (name: string, days: readonly string[], fractionCount = 1): GroupStructure => ({ name, days, stopSource: "rule", fractionCount, containerCount: 0 })
const manual = (name: string, days: readonly string[], containerCount = 1): GroupStructure => ({ name, days, stopSource: "manual", fractionCount: 0, containerCount })

const sound: SchemeStructure = {
  serviceDays: ["monday", "thursday"],
  hasPlanningArea: true,
  collectionGroups: [rule("Residual", ["monday", "thursday"]), manual("Glass", ["thursday"])],
}

describe("schemeStructureIssues", () => {
  test("a scheme whose every day has a group, whose rule groups name a fraction, whose manual groups pick a container and which has a planning area, stands", () => {
    assert.deepEqual(schemeStructureIssues(sound), [])
  })

  test("names the service days no group runs on, in weekday order and each once", () => {
    assert.deepEqual(
      schemeStructureIssues({ ...sound, serviceDays: ["friday", "monday", "tuesday", "thursday"], collectionGroups: [rule("Residual", ["thursday"])] }),
      ["Service days without a collection group: monday, tuesday, friday"],
    )
    assert.equal(serviceDaysWithoutGroup(["monday", "tuesday"]), "Service days without a collection group: monday, tuesday")
    const covered = schemeStructureIssues({ ...sound, collectionGroups: [rule("Residual", ["monday"]), manual("Glass", ["thursday"])] })
    assert.deepEqual(covered, [], "two groups may cover the week between them")
  })

  test("a group with no days covers nothing, and a scheme with no groups leaves every day uncovered", () => {
    assert.deepEqual(schemeStructureIssues({ ...sound, collectionGroups: [rule("Paused", [])] }), ["Service days without a collection group: monday, thursday"])
    assert.deepEqual(schemeStructureIssues({ ...sound, collectionGroups: [] }), ["Service days without a collection group: monday, thursday"])
  })

  test("a rule group without a fraction and a manual group without a container are each named, in group order", () => {
    assert.deepEqual(
      schemeStructureIssues({
        ...sound,
        collectionGroups: [manual("Glass", ["thursday"], 0), rule("Residual", ["monday", "thursday"], 0), rule("Paper", ["monday"])],
      }),
      ["Collection group Glass picks containers but names none", "Collection group Residual matches by rule but names no waste fraction"],
    )
    assert.equal(ruleWithoutFraction("Residual"), "Collection group Residual matches by rule but names no waste fraction")
    assert.equal(manualWithoutContainer("Glass"), "Collection group Glass picks containers but names none")
  })

  test("a rule group needs a planning area to match inside; the sentence is said once and a manual scheme does not need one", () => {
    assert.deepEqual(schemeStructureIssues({ ...sound, hasPlanningArea: false }), [NO_PLANNING_AREA_FOR_RULE])
    assert.deepEqual(
      schemeStructureIssues({ ...sound, hasPlanningArea: false, collectionGroups: [rule("Residual", ["monday", "thursday"]), rule("Paper", ["monday"])] }),
      ["The scheme has no planning area and a collection group matches by rule"],
    )
    assert.deepEqual(schemeStructureIssues({ ...sound, hasPlanningArea: false, collectionGroups: [manual("Glass", ["monday", "thursday"])] }), [])
  })

  test("lists every sentence that holds, the days first, the groups next, the planning area last", () => {
    assert.deepEqual(
      schemeStructureIssues({
        serviceDays: ["monday", "tuesday"],
        hasPlanningArea: false,
        collectionGroups: [rule("Residual", ["monday"], 0), manual("Glass", [], 0)],
      }),
      [
        "Service days without a collection group: tuesday",
        "Collection group Residual matches by rule but names no waste fraction",
        "Collection group Glass picks containers but names none",
        "The scheme has no planning area and a collection group matches by rule",
      ],
    )
  })
})

describe("containerPickedTwice", () => {
  const mondays = { group: "Mondays", days: ["monday", "wednesday"], containerIds: ["bin-1", "bin-2"] }
  const thursdays = { group: "Thursdays", days: ["thursday"], containerIds: ["bin-2", "bin-3"] }

  test("finds the first container another group picks on a day both run, by its position, the group and the first shared day in weekday order", () => {
    assert.deepEqual(containerPickedTwice([mondays, thursdays], { days: ["wednesday", "monday"], containerIds: ["bin-9", "bin-2"] }), {
      index: 1,
      group: "Mondays",
      day: "monday",
    })
    assert.equal(alreadyPicked({ group: "Mondays", day: "monday" }), "Already picked by Mondays on monday")
  })

  test("the same container on two groups with no day in common is free, and so is a group with no days", () => {
    assert.equal(containerPickedTwice([mondays], { days: ["thursday"], containerIds: ["bin-1", "bin-2"] }), undefined)
    assert.equal(containerPickedTwice([mondays, thursdays], { days: [], containerIds: ["bin-1", "bin-2", "bin-3"] }), undefined)
    assert.equal(containerPickedTwice([], { days: ["monday"], containerIds: ["bin-1"] }), undefined, "the first group of a scheme conflicts with nothing")
  })

  test("the earliest offending entry wins, whichever group holds it", () => {
    assert.deepEqual(containerPickedTwice([mondays, thursdays], { days: ["monday", "thursday"], containerIds: ["bin-3", "bin-1"] }), {
      index: 0,
      group: "Thursdays",
      day: "thursday",
    })
  })
})
