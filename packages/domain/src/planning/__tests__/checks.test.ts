// The structural rules of a validated Route Scheme (Issue #97), held over
// plain shapes: every sentence the API's 409 lists, in the order it lists
// them, and the two-groups-one-day rule that refuses a container by its
// position in the list.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  alreadyPicked,
  containerPickedTwice,
  groupDriverIssue,
  manualWithoutContainer,
  NO_PLANNING_AREA_FOR_RULE,
  onTwoGroups,
  resourcesOnTwoGroups,
  ruleWithoutFraction,
  schemeLicenceDay,
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

  test("lists every sentence that holds, the days first, the groups next, the planning area, then the vehicles and drivers on two groups", () => {
    assert.deepEqual(
      schemeStructureIssues({
        serviceDays: ["monday", "tuesday"],
        hasPlanningArea: false,
        collectionGroups: [
          { ...rule("Residual", ["monday"], 0), vehicle: wh24 },
          { ...manual("Glass", [], 0), vehicle: wh24 },
          { ...manual("Paper", ["monday"]), vehicle: wh24 },
        ],
      }),
      [
        "Service days without a collection group: tuesday",
        "Collection group Residual matches by rule but names no waste fraction",
        "Collection group Glass picks containers but names none",
        "The scheme has no planning area and a collection group matches by rule",
        "Vehicle WH-24 is on two collection groups that run on monday: Residual, Paper",
      ],
    )
  })
})

const wh24 = { id: "vehicle-24", label: "WH-24" }
const wh25 = { id: "vehicle-25", label: "WH-25" }
const mads = { id: "driver-mads", label: "Mads Jensen" }

describe("resourcesOnTwoGroups", () => {
  test("names a vehicle two groups run with on a shared day, once per day in weekday order, the groups in group order", () => {
    const groups: GroupStructure[] = [
      { ...rule("South", ["thursday", "monday"]), vehicle: wh24, driver: null },
      { ...manual("North", ["monday", "thursday"]), vehicle: wh24, driver: null },
    ]
    assert.deepEqual(resourcesOnTwoGroups(groups), [
      "Vehicle WH-24 is on two collection groups that run on monday: South, North",
      "Vehicle WH-24 is on two collection groups that run on thursday: South, North",
    ])
    assert.equal(onTwoGroups("Vehicle", "WH-24", "monday", ["North", "South"]), "Vehicle WH-24 is on two collection groups that run on monday: North, South")
    assert.equal(onTwoGroups("Driver", "Mads Jensen", "friday", ["A", "B", "C"]), "Driver Mads Jensen is on three collection groups that run on friday: A, B, C")
  })

  test("the same vehicle on groups with no day in common is one truck on two days, and a group with no days conflicts with nothing", () => {
    assert.deepEqual(resourcesOnTwoGroups([{ ...rule("Mondays", ["monday"]), vehicle: wh24 }, { ...rule("Thursdays", ["thursday"]), vehicle: wh24 }]), [])
    assert.deepEqual(resourcesOnTwoGroups([{ ...rule("Mondays", ["monday"]), vehicle: wh24 }, { ...rule("Paused", []), vehicle: wh24 }]), [])
    assert.deepEqual(resourcesOnTwoGroups([{ ...rule("Mondays", ["monday"]), vehicle: wh24 }, { ...rule("Also Mondays", ["monday"]), vehicle: wh25 }]), [], "two trucks on one day")
  })

  test("vehicles before drivers, resources in the order the groups first name them, and a group naming neither is left out", () => {
    const groups: GroupStructure[] = [
      { ...rule("A", ["monday"]), vehicle: wh25, driver: mads },
      { ...rule("B", ["monday"]), vehicle: wh24, driver: null },
      { ...rule("C", ["monday"]) },
      { ...rule("D", ["monday"]), vehicle: wh24, driver: mads },
      { ...rule("E", ["monday"]), vehicle: wh25 },
    ]
    assert.deepEqual(resourcesOnTwoGroups(groups), [
      "Vehicle WH-25 is on two collection groups that run on monday: A, E",
      "Vehicle WH-24 is on two collection groups that run on monday: B, D",
      "Driver Mads Jensen is on two collection groups that run on monday: A, D",
    ])
  })
})

describe("schemeLicenceDay", () => {
  test("is the scheme's start or today, whichever is later, and says which it was; a scheme starting today is judged on its start", () => {
    assert.deepEqual(schemeLicenceDay("2027-03-01", "2026-09-25"), { day: "2027-03-01", meaning: "the scheme starts" })
    assert.deepEqual(schemeLicenceDay("2026-01-01", "2026-09-25"), { day: "2026-09-25", meaning: "today" })
    assert.deepEqual(schemeLicenceDay("2026-09-25", "2026-09-25"), { day: "2026-09-25", meaning: "the scheme starts" })
  })
})

describe("groupDriverIssue", () => {
  const vehicle = { label: "WH-24", requiredLicenceClass: "c" as const }

  test("spells the three licence refusals in the allocation's words, the expiry one ending with what the day meant", () => {
    const today = { day: "2026-09-25", meaning: "today" as const }
    const start = { day: "2027-03-01", meaning: "the scheme starts" as const }
    assert.equal(groupDriverIssue({ vehicle, driver: { name: "Jonas Lind", licenceClass: null, licenceExpiry: null } }, today), "Jonas Lind holds no licence class on record")
    assert.equal(groupDriverIssue({ vehicle, driver: { name: "Freja Holm", licenceClass: "b", licenceExpiry: null } }, today), "Freja Holm needs a C licence for WH-24")
    assert.equal(
      groupDriverIssue({ vehicle, driver: { name: "Sofie Nielsen", licenceClass: "c", licenceExpiry: "2026-09-05" } }, today),
      "Sofie Nielsen's licence expires on 2026-09-05, before today",
    )
    assert.equal(
      groupDriverIssue({ vehicle, driver: { name: "Sofie Nielsen", licenceClass: "c", licenceExpiry: "2026-12-31" } }, start),
      "Sofie Nielsen's licence expires on 2026-12-31, before the scheme starts",
    )
  })

  test("a driver who holds the class, or a higher one, on the judged day is no issue", () => {
    const today = { day: "2026-09-25", meaning: "today" as const }
    assert.equal(groupDriverIssue({ vehicle, driver: { name: "Mads Jensen", licenceClass: "ce", licenceExpiry: "2030-12-31" } }, today), undefined)
    assert.equal(groupDriverIssue({ vehicle, driver: { name: "Sofie Nielsen", licenceClass: "c", licenceExpiry: "2026-09-25" } }, today), undefined, "the expiry is the last day the licence holds")
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
