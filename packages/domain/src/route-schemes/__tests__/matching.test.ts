import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  collectionGroupsOf,
  collectionGroupsToValues,
  parseCollectionGroups,
  resolveCollectionGroupPlans,
} from "../groups"
import {
  containerMatchProfile,
  containerTypeShortLabel,
  matchPlansFromValues,
  PLANNING_AREA_IDS_KEY,
  SERVES_TODAY_KEY,
  matchPlansToValues,
  resolveStopMatches,
  stopRuleSummary,
} from "../matching"

const container = (id: string, fraction: string, type: string, status = "Available") => ({
  id,
  name: id.toUpperCase(),
  status,
  facts: { "Waste fractions": fraction, "Container type": type },
  submittedValues: { planningAreaId: "area-indreby" },
  projectIds: ["project-copenhagen"],
})

const containers = [
  container("c1", "Residual", "Two-wheel bin · 240 L"),
  container("c2", "Residual", "Four-wheel bin · 660 L"),
  container("c3", "Residual", "Four-wheel bin · 1,100 L"),
  container("c4", "Organic", "Two-wheel bin · 240 L"),
  container("c5", "Residual", "Two-wheel bin · 240 L", "Defect"),
]

describe("container-type rule filter", () => {
  test("restricts matches to the listed types without listing the others as near-misses", () => {
    const result = resolveStopMatches({
      rule: { fractions: ["Residual"], containerTypes: ["Two-wheel bin · 240 L"] },
      areaId: "area-indreby",
      containers,
    })
    assert.deepEqual(result.matched.map((c) => c.id), ["c1"])
    // c5 (defect) matches type and fraction, so its exclusion stays visible.
    assert.deepEqual(result.excluded.map((c) => c.id), ["c5"])
  })

  test("an empty type list matches every type", () => {
    const result = resolveStopMatches({
      rule: { fractions: ["Residual"], containerTypes: [] },
      areaId: "area-indreby",
      containers,
    })
    assert.deepEqual(result.matched.map((c) => c.id), ["c1", "c2", "c3"])
  })

  test("round-trips through the legacy shared-rule values", () => {
    const values = matchPlansToValues({
      sameAllDays: true,
      sharedRule: { fractions: ["Residual"], containerTypes: ["Two-wheel bin · 240 L", "Four-wheel bin · 660 L"] },
      rulesByDay: {},
    })
    assert.equal(values.matchContainerTypes, "Two-wheel bin · 240 L, Four-wheel bin · 660 L")
    const plans = matchPlansFromValues(values)
    assert.deepEqual(plans.sharedRule.containerTypes, ["Two-wheel bin · 240 L", "Four-wheel bin · 660 L"])
  })

  test("round-trips through explicit collection groups and the implicit shape", () => {
    const groups = parseCollectionGroups(
      JSON.stringify([
        {
          id: "g1",
          name: "Residual small",
          days: ["monday"],
          fractions: ["Residual"],
          stopSource: "rule",
          containerTypes: ["Two-wheel bin · 240 L"],
          containerIds: [],
        },
      ]),
    )
    assert.deepEqual(groups[0].containerTypes, ["Two-wheel bin · 240 L"])

    const legacy = collectionGroupsToValues(groups, ["monday"])
    assert.equal(legacy.matchContainerTypes, "Two-wheel bin · 240 L")
    const implicit = collectionGroupsOf(legacy, { serviceDays: ["monday"] })
    assert.deepEqual(implicit[0].containerTypes, ["Two-wheel bin · 240 L"])

    const resolution = resolveCollectionGroupPlans({
      groups,
      serviceDays: ["monday"],
      areaId: "area-indreby",
      containers,
    })
    assert.deepEqual(resolution.plans[0].containerIds, ["c1"])
  })

  test("summary and chip labels", () => {
    assert.equal(
      stopRuleSummary({
        fractions: ["Residual"],
        containerTypes: ["Two-wheel bin · 240 L", "Underground · 5,000 L"],
        vehicleType: "Rear loader",
      }),
      "Residual · 240 L, Underground · Rear loader",
    )
    assert.equal(containerTypeShortLabel("Four-wheel bin · 1,100 L"), "1,100 L")
    assert.equal(containerTypeShortLabel("Igloo · 2,500 L"), "Igloo")
    assert.equal(containerTypeShortLabel("Wastewater tank · 3,000 L"), "Wastewater tank")
    assert.equal(containerTypeShortLabel("Skip"), "Skip")
  })
})

describe("container types with a thousands separator round-trip (issue #43)", () => {
  test("the stored comma list keeps 1,100 L and 2,500 L whole", () => {
    const plans = matchPlansToValues({
      sameAllDays: true,
      sharedRule: {
        fractions: ["Glass"],
        containerTypes: ["Igloo · 2,500 L", "Four-wheel bin · 1,100 L", "Two-wheel bin · 240 L"],
      },
      rulesByDay: {},
    })
    assert.equal(
      plans.matchContainerTypes,
      "Igloo · 2,500 L, Four-wheel bin · 1,100 L, Two-wheel bin · 240 L",
    )
    assert.deepEqual(matchPlansFromValues(plans).sharedRule.containerTypes, [
      "Igloo · 2,500 L",
      "Four-wheel bin · 1,100 L",
      "Two-wheel bin · 240 L",
    ])
    // A list written without the space after the comma splits the same way.
    assert.deepEqual(
      matchPlansFromValues({ matchContainerTypes: "Underground · 5,000 L,Wastewater tank · 3,000 L" })
        .sharedRule.containerTypes,
      ["Underground · 5,000 L", "Wastewater tank · 3,000 L"],
    )
    assert.deepEqual(
      matchPlansFromValues({ matchFractions: "Paper,Cardboard, Glass" }).sharedRule.fractions,
      ["Paper", "Cardboard", "Glass"],
    )
  })
})

describe("a container the API holds (#207)", () => {
  // As the web's containers adapter carries one: its typed fraction and type are master-data web ids, its facts their names,
  // its status the asset state (every seeded container has no movement yet), and its place read from its placement in force.
  const server = (id: string, over: { fraction?: string; type?: string; areas?: string; serves?: "yes" | "no" } = {}) => ({
    id,
    name: id.toUpperCase(),
    status: "No stock record",
    facts: { "Waste fractions": over.fraction ?? "Residual", "Container type": over.type ?? "Two-wheel bin · 240 L" },
    submittedValues: {
      wasteFraction: "fraction-01a0d2a4-a280-7007-8000-000000000001",
      containerType: "container-type-01a0d2a4-a280-7008-8000-000000000002",
      ...(over.areas === undefined ? {} : { planningAreaId: over.areas.split(",")[0], [PLANNING_AREA_IDS_KEY]: over.areas }),
      [SERVES_TODAY_KEY]: over.serves ?? "yes",
    },
    projectIds: ["project-copenhagen"],
  })

  test("is read by its names where its typed values are no form tokens, and is in service while a placement serves it today, whatever its asset state", () => {
    assert.deepEqual(containerMatchProfile(server("asset-1", { areas: "area-indreby" })), {
      id: "asset-1",
      name: "ASSET-1",
      status: "No stock record",
      inService: true,
      areaIds: ["area-indreby"],
      fractions: ["Residual"],
      containerType: "Two-wheel bin · 240 L",
      projectIds: ["project-copenhagen"],
    })
    const result = resolveStopMatches({ rule: { fractions: ["Residual"], vehicleType: "Rear loader" }, areaId: "area-indreby", projectIds: ["project-copenhagen"], containers: [server("asset-1", { areas: "area-indreby" })] })
    assert.deepEqual(result.matched.map((profile) => profile.id), ["asset-1"])
  })

  test("is in every area whose boundary contains it: where areas overlap it counts in each, as the worker's containment does", () => {
    const both = server("asset-2", { areas: "area-indreby,area-osterbro" })
    for (const areaId of ["area-indreby", "area-osterbro"]) {
      assert.deepEqual(resolveStopMatches({ rule: { fractions: ["Residual"] }, areaId, containers: [both] }).matched.map((profile) => profile.id), ["asset-2"], areaId)
    }
    assert.equal(resolveStopMatches({ rule: { fractions: ["Residual"] }, areaId: "area-amager", containers: [both] }).scopeTotal, 0)
  })

  test("held to a placement that serves it nowhere today, it is excluded with the reason where it is in scope, never matched", () => {
    const idle = server("asset-3", { areas: "area-indreby", serves: "no" })
    const result = resolveStopMatches({ rule: { fractions: ["Residual"] }, areaId: "area-indreby", containers: [idle] })
    assert.deepEqual(result.matched, [])
    assert.deepEqual(result.excluded, [{ id: "asset-3", name: "ASSET-3", reason: "No placement serves it today — not in service" }])
  })

  test("a fixture's container keeps its readings: its status the gate, its one area, its form tokens", () => {
    const fixture = { id: "c9", name: "C9", status: "Available", facts: {}, submittedValues: { wasteFraction: "glass", containerType: "two-wheel-240", planningAreaId: "area-indreby" }, projectIds: [] }
    const profile = containerMatchProfile(fixture)
    assert.deepEqual([profile.inService, profile.areaIds, profile.fractions, profile.containerType], [true, ["area-indreby"], ["Glass"], "Two-wheel bin · 240 L"])
    assert.equal(containerMatchProfile({ ...fixture, status: "Defect" }).inService, false)
    // A typed value the form labels do not know is read as it is typed, as the asset catalogue's tokens are.
    assert.deepEqual(containerMatchProfile({ ...fixture, submittedValues: { ...fixture.submittedValues, wasteFraction: "paper", secondaryWasteFraction: "glass" } }).fractions, ["paper", "Glass"])
  })
})
