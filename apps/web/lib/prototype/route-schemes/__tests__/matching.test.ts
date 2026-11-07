import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  collectionGroupsOf,
  collectionGroupsToValues,
  parseCollectionGroups,
  resolveCollectionGroupPlans,
} from "../groups"
import {
  containerAreaIds,
  containerInService,
  containerMatchProfile,
  containerTypeShortLabel,
  matchPlansFromValues,
  SERVING_KEY,
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

describe("a rule group's own planning area (O30 of #290, row 2.17)", () => {
  const north = { ...container("n1", "Residual", "Two-wheel bin · 240 L"), submittedValues: { planningAreaId: "area-north" } }
  const own = (planningAreaId?: string) =>
    parseCollectionGroups(JSON.stringify([{ id: "g1", name: "Residual", days: ["monday"], fractions: ["Residual"], stopSource: "rule", containerIds: [], ...(planningAreaId ? { planningAreaId } : {}) }]))

  test("is read from the stored group and matches within that area instead of the scheme's", () => {
    const groups = own("area-north")
    assert.equal(groups[0].planningAreaId, "area-north")
    const resolution = resolveCollectionGroupPlans({ groups, serviceDays: ["monday"], areaId: "area-indreby", containers: [...containers, north] })
    assert.deepEqual(resolution.plans[0].containerIds, ["n1"])
    const onScheme = resolveCollectionGroupPlans({ groups: own(), serviceDays: ["monday"], areaId: "area-indreby", containers: [...containers, north] })
    assert.deepEqual(onScheme.plans[0].containerIds, ["c1", "c2", "c3"], "no area of its own: the scheme's")
  })

  test("keeps the explicit group shape, since the legacy keys have no home for it", () => {
    const values = collectionGroupsToValues(own("area-north"), ["monday"])
    assert.equal(values.stopSelection, "")
    assert.equal(collectionGroupsOf(values, { serviceDays: ["monday"] })[0].planningAreaId, "area-north")
    assert.equal(collectionGroupsToValues(own(), ["monday"]).stopSelection, "rule", "without one, the one group running every day is the legacy shape as before")
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

describe("a container the API holds (#207, #232)", () => {
  // As the web's containers adapter carries one: its typed fraction and type are master-data web ids, its facts their names,
  // its status the asset state (every seeded container has no movement yet), and its serving: for each placement not ended
  // by the day read, the period it serves the container in and the areas its place lies in.
  const ASOF = "2026-10-24"
  type Period = { from: string; until?: string | null; areas?: string[]; fractions?: string[]; place?: string }
  const serving = (...periods: Period[]) =>
    JSON.stringify({ asOf: ASOF, periods: periods.map((period) => ({ from: period.from, until: period.until ?? null, areaIds: period.areas ?? ["area-indreby"], fractions: period.fractions ?? ["Residual"], ...(period.place === undefined ? {} : { place: period.place }) })) })
  const server = (id: string, periods: Period[] = [{ from: "2026-01-01" }], over: { fraction?: string; type?: string } = {}) => ({
    id,
    name: id.toUpperCase(),
    status: "No stock record",
    facts: { "Waste fractions": over.fraction ?? "Residual", "Container type": over.type ?? "Two-wheel bin · 240 L" },
    submittedValues: {
      wasteFraction: "fraction-01a0d2a4-a280-7007-8000-000000000001",
      containerType: "container-type-01a0d2a4-a280-7008-8000-000000000002",
      [SERVING_KEY]: serving(...periods),
    },
    projectIds: ["project-copenhagen"],
  })
  const preview = (containers: ReturnType<typeof server>[], areaId = "area-indreby", from?: string, fractions = ["Residual"]) =>
    resolveStopMatches({ rule: { fractions }, areaId, projectIds: ["project-copenhagen"], ...(from === undefined ? {} : { from }), containers })
  const matched = (result: ReturnType<typeof preview>) => result.matched.map((profile) => profile.id)
  const reasons = (result: ReturnType<typeof preview>) => result.excluded.map((exclusion) => exclusion.reason)

  test("is read by its names where its typed values are no form tokens, and is in service while a placement serves it, whatever its asset state", () => {
    assert.deepEqual(containerMatchProfile(server("asset-1")), {
      id: "asset-1",
      name: "ASSET-1",
      status: "No stock record",
      inService: true,
      areaIds: ["area-indreby"],
      fractions: ["Residual"],
      containerType: "Two-wheel bin · 240 L",
      projectIds: ["project-copenhagen"],
    })
    const result = resolveStopMatches({ rule: { fractions: ["Residual"], vehicleType: "Rear loader" }, areaId: "area-indreby", projectIds: ["project-copenhagen"], containers: [server("asset-1")] })
    assert.deepEqual(matched(result), ["asset-1"])
  })

  test("is in every area its place lies in: where areas overlap it counts in each, as the worker's containment does", () => {
    const both = server("asset-2", [{ from: "2026-01-01", areas: ["area-indreby", "area-osterbro"] }])
    for (const areaId of ["area-indreby", "area-osterbro"]) assert.deepEqual(matched(preview([both], areaId)), ["asset-2"], areaId)
    assert.equal(preview([both], "area-amager").scopeTotal, 0)
  })

  test("is judged on the scheme's first day where that is ahead of the day read: a placement that starts with a new scheme matches it", () => {
    const starting = server("asset-3", [{ from: "2026-11-02", until: "2026-12-01" }])
    assert.deepEqual(matched(preview([starting], "area-indreby", "2026-11-02")), ["asset-3"], "from the scheme's first day")
    assert.deepEqual(matched(preview([starting], "area-indreby", "2026-11-30")), ["asset-3"], "its last day in")
    assert.equal(containerMatchProfile(starting, "2026-11-02").inService, true)
    assert.equal(containerMatchProfile(starting).inService, false, "without a first day, the day read")
  })

  test("a running scheme is judged on the day read, not on a first day behind it", () => {
    assert.deepEqual(matched(preview([server("asset-4", [{ from: "2026-11-02" }])], "area-indreby", "2026-09-01")), [])
    assert.deepEqual(matched(preview([server("asset-5", [{ from: "2026-01-01", until: "2026-10-25" }])], "area-indreby", "2026-09-01")), ["asset-5"])
  })

  test("a renewal or a move is judged on the placement serving on the scheme's first day, in the scheme's own area", () => {
    const renewed = server("asset-6", [{ from: "2026-01-01", until: "2026-11-01" }, { from: "2026-11-01" }])
    assert.deepEqual(matched(preview([renewed], "area-indreby", "2026-11-02")), ["asset-6"], "the renewal serves then")
    const moved = server("asset-7", [{ from: "2026-01-01", until: "2026-11-01", areas: ["area-indreby"] }, { from: "2026-11-01", areas: ["area-osterbro"] }])
    assert.deepEqual(matched(preview([moved], "area-osterbro", "2026-11-02")), ["asset-7"], "where it moves to, from its first day there")
    assert.deepEqual(reasons(preview([moved], "area-indreby", "2026-11-02")), ["Served until 2026-10-31 — not in service"], "where it was")
    assert.deepEqual(reasons(preview([moved], "area-osterbro")), ["Serves from 2026-11-01 — not in service"], "judged today, where it is not yet")
  })

  test("each placement serves its own fraction, and a match names the place it is matched at", () => {
    const moved = server("asset-9", [
      { from: "2026-01-01", until: "2026-11-01", areas: ["area-indreby"], fractions: ["Residual"], place: "Parkvej 18" },
      { from: "2026-11-01", areas: ["area-osterbro"], fractions: ["Organic"], place: "Kongens Nytorv" },
    ])
    assert.deepEqual(matched(preview([moved], "area-osterbro", "2026-11-02", ["Organic"])), ["asset-9"], "its fraction there")
    assert.deepEqual(matched(preview([moved], "area-osterbro", "2026-11-02", ["Residual"])), [], "not today's fraction where it moves to")
    const [profile] = preview([moved], "area-osterbro", "2026-11-02", ["Organic"]).matched
    assert.deepEqual([profile?.fractions, profile?.place], [["Organic"], "Kongens Nytorv"])
  })

  test("is judged on the first collection: the first of the group's days on or after the scheme's first day", () => {
    // A scheme from Monday 2 November that collects on Thursdays first collects on the 5th.
    const starting = server("asset-10", [{ from: "2026-11-05" }])
    const onThursdays = resolveStopMatches({ rule: { fractions: ["Residual"] }, areaId: "area-indreby", from: "2026-11-02", days: ["thursday"], containers: [starting] })
    assert.deepEqual(matched(onThursdays), ["asset-10"])
    assert.deepEqual(reasons(preview([starting], "area-indreby", "2026-11-02")), ["Serves from 2026-11-05 — not in service"], "without the days, the first day itself")
  })

  test("a period it cannot read serves nowhere: an unreadable end is no open end", () => {
    const record = { ...server("asset-11"), submittedValues: { ...server("asset-11").submittedValues, [SERVING_KEY]: JSON.stringify({ asOf: ASOF, periods: [{ from: "2026-01-01", until: "2026-13-01", areaIds: ["area-indreby"], fractions: ["Residual"] }] }) } }
    assert.equal(preview([record]).scopeTotal, 0)
  })

  test("out of service on the day judged, it is in scope and excluded with the reason, never matched", () => {
    const result = (period: Period, from?: string) => {
      const answer = preview([server("asset-8", [period])], "area-indreby", from)
      assert.deepEqual([answer.matched, answer.scopeTotal], [[], 1])
      return reasons(answer)
    }
    assert.deepEqual(result({ from: "2026-11-02" }), ["Serves from 2026-11-02 — not in service"])
    assert.deepEqual(result({ from: "2026-11-02", until: "2026-12-01" }, "2026-12-01"), ["Served until 2026-11-30 — not in service"])
  })

  test("where and whether it serves today is the placement serving on the day read, for the map's readers (#232)", () => {
    const today = server("asset-12", [{ from: "2026-01-01", until: "2026-11-01", areas: ["area-indreby", "area-osterbro"] }, { from: "2026-11-01", areas: ["area-amager"] }])
    assert.deepEqual([containerAreaIds(today), containerInService(today)], [["area-indreby", "area-osterbro"], true])
    const later = server("asset-13", [{ from: "2026-11-02", areas: ["area-amager"] }])
    assert.deepEqual([containerAreaIds(later), containerInService(later)], [[], false], "not yet in any area today, nor in service")
  })

  test("a fixture's container keeps its readings: its status the gate, its one area, its form tokens", () => {
    const fixture = { id: "c9", name: "C9", status: "Available", facts: {}, submittedValues: { wasteFraction: "glass", containerType: "two-wheel-240", planningAreaId: "area-indreby" }, projectIds: [] }
    const profile = containerMatchProfile(fixture)
    assert.deepEqual([profile.inService, profile.areaIds, profile.fractions, profile.containerType], [true, ["area-indreby"], ["Glass"], "Two-wheel bin · 240 L"])
    assert.equal(containerMatchProfile({ ...fixture, status: "Defect" }).inService, false)
    assert.deepEqual([containerAreaIds(fixture), containerInService(fixture), containerInService({ ...fixture, status: "Defect" })], [["area-indreby"], true, false], "the map's readers read it the same")
    // A typed value the form labels do not know is read as it is typed, as the asset catalogue's tokens are.
    assert.deepEqual(containerMatchProfile({ ...fixture, submittedValues: { ...fixture.submittedValues, wasteFraction: "paper", secondaryWasteFraction: "glass" } }).fractions, ["paper", "Glass"])
  })
})
