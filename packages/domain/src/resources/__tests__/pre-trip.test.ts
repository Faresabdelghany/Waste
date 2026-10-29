// The pre-trip rules (O13 of #290): a check answers its vehicle type's
// checklist whole, a failed item is a defect, a critical one grounds the
// vehicle, and the office's ticket says what was found.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { ANSWERED_TWICE, defectTicket, isCheckIssue, judgeCheck, NOT_ON_THE_CHECKLIST, unanswered, type ChecklistItem } from "../pre-trip"

const checklist: ChecklistItem[] = [
  { id: "a", label: "Brakes", critical: true },
  { id: "b", label: "Lights", critical: false },
  { id: "c", label: "Tyres", critical: true },
]

describe("judgeCheck", () => {
  test("answers in any order come back in the checklist's, each with its label and weight", () => {
    const judged = judgeCheck(checklist, [
      { itemId: "c", passed: true },
      { itemId: "a", passed: true },
      { itemId: "b", passed: false, note: "Left indicator out" },
    ])
    assert.ok(!isCheckIssue(judged))
    assert.deepEqual(
      judged.items.map((item) => item.label),
      ["Brakes", "Lights", "Tyres"],
    )
    assert.deepEqual(judged.defects, [{ itemId: "b", label: "Lights", critical: false, passed: false, note: "Left indicator out" }])
    assert.equal(judged.grounds, false)
  })

  test("a failed critical item grounds the vehicle", () => {
    const judged = judgeCheck(checklist, [
      { itemId: "a", passed: false },
      { itemId: "b", passed: true },
      { itemId: "c", passed: true },
    ])
    assert.ok(!isCheckIssue(judged))
    assert.equal(judged.grounds, true)
  })

  test("an item off the list, an item twice and an item unanswered are each the issue, in that order", () => {
    assert.deepEqual(judgeCheck(checklist, [{ itemId: "z", passed: true }]), { path: "body.items.0.itemId", message: NOT_ON_THE_CHECKLIST })
    assert.deepEqual(
      judgeCheck(checklist, [
        { itemId: "a", passed: true },
        { itemId: "a", passed: true },
      ]),
      { path: "body.items.1.itemId", message: ANSWERED_TWICE },
    )
    assert.deepEqual(judgeCheck(checklist, [{ itemId: "a", passed: true }]), { path: "body.items", message: unanswered("Lights") })
  })

  test("an empty checklist takes an empty check", () => {
    assert.deepEqual(judgeCheck([], []), { items: [], defects: [], grounds: false })
  })
})

describe("defectTicket", () => {
  test("one ticket per check: high where the vehicle is grounded, medium where it stays on the road, the defects listed", () => {
    const grounded = defectTicket({ vehicleLabel: "WH-24", driverName: "Mads Jensen", routeLabel: "RC-1042", checkedAt: "Mon 5 Oct 07:30", defects: [{ label: "Brakes", critical: true, note: "Pulls left" }, { label: "Lights", critical: false, note: null }], grounds: true })
    assert.equal(grounded.kind, "vehicle-defect")
    assert.equal(grounded.priority, "high")
    assert.equal(grounded.subject, "Pre-trip check found 2 defects on WH-24")
    assert.match(grounded.description, /- Brakes \(critical\): Pulls left\n- Lights\n/)
    assert.match(grounded.description, /set to maintenance/)
    const minor = defectTicket({ vehicleLabel: "WH-24", driverName: "Mads Jensen", routeLabel: "RC-1042", checkedAt: "Mon 5 Oct 07:30", defects: [{ label: "Lights", critical: false, note: null }], grounds: false })
    assert.equal(minor.priority, "medium")
    assert.equal(minor.subject, "Pre-trip check found a defect on WH-24")
    assert.match(minor.description, /stays in service/)
  })
})
