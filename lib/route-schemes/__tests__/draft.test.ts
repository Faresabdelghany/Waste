import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { draftGroups, validateGuidedScheme } from "../draft"
import type { CollectionGroup } from "../groups"
import { quickSchemeDraftFromValues, type GuidedSchemeData } from "../quick-create"

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

  test("quick create scopes the fraction only for a single-fraction rule", () => {
    const single = quickSchemeDraftFromValues({
      schemeName: "Quick",
      stopSelection: "rule",
      matchFractions: "Organic",
      frequency: "weekly",
      serviceDays: "monday",
      effectiveFrom: "2026-09-14",
    })
    assert.equal(single.wasteFraction, "Organic")
    assert.deepEqual(single.groups[0].fractions, ["Organic"])
    const several = quickSchemeDraftFromValues({
      schemeName: "Quick",
      stopSelection: "rule",
      matchFractions: "Paper, Cardboard",
      frequency: "weekly",
      serviceDays: "monday",
      effectiveFrom: "2026-09-14",
    })
    assert.equal(several.wasteFraction, "")
    assert.deepEqual(several.groups[0].fractions, ["Paper", "Cardboard"])
    assert.equal(several.serviceType, "")
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
