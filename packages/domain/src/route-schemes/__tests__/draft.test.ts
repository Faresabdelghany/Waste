import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { candidateIssue, draftGroups, validateGuidedScheme } from "../draft"
import type { CollectionGroup } from "../groups"
import { quickSchemeDraftFromValues, type GuidedSchemeData } from "../quick-create"
import { recurrenceIssues } from "../validation"

const group = (id: string, fractions: string[]): CollectionGroup => ({
  id,
  name: id,
  days: ["monday"],
  fractions,
  stopSource: "rule",
  containerTypes: ["Two-wheel bin · 240 L"],
  containerIds: [],
})

const draft = (wasteFraction: string, groups: CollectionGroup[]): GuidedSchemeData => ({
  schemeName: "Scope",
  wasteFraction,
  serviceType: "Container collection",
  frequency: "weekly",
  weekRotation: "odd",
  serviceDays: ["monday"],
  effectiveFrom: "2026-09-14",
  effectiveTo: "",
  plannedStartTime: "06:30",
  holidayPolicy: "shift-next",
  createAs: "validated",
  editPolicy: "ask",
  groups,
})

describe("scheme-level waste fraction", () => {
  test("every group inherits the scheme's fraction", () => {
    const groups = draftGroups(draft("Residual", [group("a", []), group("b", ["Paper"])]))
    assert.deepEqual(
      groups.map((candidate) => candidate.fractions),
      [["Residual"], ["Residual"]],
    )
  })

  test("without a scheme-level fraction the groups keep their own", () => {
    const groups = draftGroups(draft("", [group("a", ["Paper", "Cardboard"])]))
    assert.deepEqual(groups[0].fractions, ["Paper", "Cardboard"])
  })

  test("quick create scopes the fraction and the service type from step 1's fields (issue #43)", () => {
    const quick = quickSchemeDraftFromValues({
      schemeName: "Quick",
      stopSelection: "rule",
      wasteFraction: "Organic",
      serviceType: "Kerbside collection",
      matchContainerTypes: "Two-wheel bin · 240 L",
      frequency: "weekly",
      serviceDays: "monday",
      effectiveFrom: "2026-09-14",
    })
    assert.equal(quick.wasteFraction, "Organic")
    assert.equal(quick.serviceType, "Kerbside collection")
    // The rule's one fraction is the scheme's — the form has no list of its own.
    assert.deepEqual(quick.groups[0].fractions, ["Organic"])
    assert.deepEqual(quick.groups[0].containerTypes, ["Two-wheel bin · 240 L"])
    // The retired multiselect is not read: a stray list cannot smuggle a second fraction in.
    const stray = quickSchemeDraftFromValues({
      schemeName: "Quick",
      stopSelection: "rule",
      wasteFraction: "Organic",
      matchFractions: "Paper, Cardboard",
      frequency: "weekly",
      serviceDays: "monday",
      effectiveFrom: "2026-09-14",
    })
    assert.deepEqual(stray.groups[0].fractions, ["Organic"])
    // Nothing picked: no fraction on the scheme or the group, no service type.
    const blank = quickSchemeDraftFromValues({
      schemeName: "Quick",
      stopSelection: "rule",
      frequency: "weekly",
      serviceDays: "monday",
      effectiveFrom: "2026-09-14",
    })
    assert.equal(blank.wasteFraction, "")
    assert.equal(blank.serviceType, "")
    assert.deepEqual(blank.groups[0].fractions, [])
    // A manual pick carries the scheme's fraction; the group's own list stays empty.
    const manual = quickSchemeDraftFromValues({
      schemeName: "Quick",
      stopSelection: "manual",
      wasteFraction: "Glass",
      frequency: "weekly",
      serviceDays: "monday",
      effectiveFrom: "2026-09-14",
    })
    assert.equal(manual.wasteFraction, "Glass")
    assert.deepEqual(manual.groups[0].fractions, [])
    assert.deepEqual(draftGroups(manual)[0].fractions, ["Glass"])
  })

  test("quick create carries the form's edit policy and asks when the form picked none (issue #38)", () => {
    const base = { schemeName: "Quick", stopSelection: "rule", frequency: "weekly", serviceDays: "monday", effectiveFrom: "2026-09-14" }
    assert.equal(quickSchemeDraftFromValues({ ...base, editPolicy: "single" }).editPolicy, "single")
    assert.equal(quickSchemeDraftFromValues({ ...base, editPolicy: "future" }).editPolicy, "future")
    assert.equal(quickSchemeDraftFromValues(base).editPolicy, "ask")
    assert.equal(quickSchemeDraftFromValues({ ...base, editPolicy: "always" }).editPolicy, "ask")
  })
})

describe("a route scheme plans one waste fraction", () => {
  const issuesOf = (data: GuidedSchemeData) => validateGuidedScheme(data, [], [], [], []).issues

  test("groups of different fractions block creation with one named issue", () => {
    const issues = issuesOf(draft("", [group("a", ["Paper", "Cardboard"])]))
    assert.ok(
      issues.includes("A route scheme plans one waste fraction — this one names Paper, Cardboard"),
      issues.join("\n"),
    )
    const twoGroups = issuesOf(draft("", [group("a", ["Paper"]), group("b", ["Glass"])]))
    assert.ok(twoGroups.some((issue) => issue.startsWith("A route scheme plans one waste fraction")))
  })

  test("a single fraction — scoped on the scheme or shared by every group — raises nothing of the kind", () => {
    for (const data of [
      draft("Residual", [group("a", []), group("b", ["Paper"])]),
      draft("", [group("a", ["Paper"]), group("b", ["Paper"])]),
    ]) {
      assert.equal(
        issuesOf(data).some((issue) => issue.startsWith("A route scheme plans one waste fraction")),
        false,
      )
    }
  })
})

describe("a step 2 simulation's candidate (issue #40)", () => {
  const today = "2026-09-26"
  const fields = draft("Residual", [])

  test("the draft's own recurrence, starting today or later, may be applied", () => {
    assert.equal(candidateIssue({ ...fields, effectiveFrom: today }, today), null)
    assert.equal(candidateIssue({ ...fields, effectiveFrom: "2026-12-21", effectiveTo: "2027-03-31" }, today), null)
  })

  test("a start before today is refused — the step 2 form's own bound", () => {
    assert.deepEqual(candidateIssue({ ...fields, effectiveFrom: "2026-09-14" }, today), {
      field: "effectiveFrom",
      text: "Effective from cannot be before today",
    })
    // The draft the wizard opened with may already start in the past; only
    // today's bound is judged, so a caller without a today refuses nothing.
    assert.equal(candidateIssue({ ...fields, effectiveFrom: "2026-09-14" }, ""), null)
  })

  test("the engine's recurrence checks come first, spelled as validateScheme spells them", () => {
    const noDays = { ...fields, serviceDays: [] }
    assert.equal(candidateIssue(noDays, today)?.text, "Pick at least one service day")
    assert.deepEqual(recurrenceIssues(noDays), [{ field: "serviceDays", text: "Pick at least one service day" }])
    assert.deepEqual(candidateIssue({ ...fields, effectiveFrom: "" }, today), {
      field: "effectiveFrom",
      text: "Set the effective from date",
    })
    const ended = { ...fields, effectiveFrom: "2026-12-21", effectiveTo: "2026-12-01" }
    assert.deepEqual(candidateIssue(ended, today), {
      field: "effectiveTo",
      text: "Effective to must be on or after effective from",
    })
    assert.deepEqual(validateGuidedScheme(ended, [], [], [], []).issues.slice(0, 1), [
      "Effective to must be on or after effective from",
    ])
  })
})
