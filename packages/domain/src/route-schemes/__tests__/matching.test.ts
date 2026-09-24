import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  collectionGroupsOf,
  collectionGroupsToValues,
  parseCollectionGroups,
  resolveCollectionGroupPlans,
} from "../groups"
import {
  containerTypeShortLabel,
  matchPlansFromValues,
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
