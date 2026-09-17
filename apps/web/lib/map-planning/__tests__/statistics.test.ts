import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../data/business-modules"
import { routeStopIndex } from "../schedule"
import { selectionStatistics, type StatisticsInputs } from "../statistics"

function record(id: string, facts: Record<string, string>, extra: Partial<BusinessRecord> = {}): BusinessRecord {
  return {
    id,
    name: id,
    context: "",
    status: "Available",
    owner: "",
    value: "",
    updated: "",
    description: "",
    facts,
    related: [],
    source: "",
    freshness: "",
    ...extra,
  }
}

const TODAY = "2026-09-16"

const containerTypes: StatisticsInputs["containerTypes"] = [
  { name: "Two-wheel bin · 240 L", volume: 240, volumeUnit: "L", wasteFractionWeights: { residual: 18, organic: 22 } },
  { name: "Four-wheel bin · 660 L", volume: 660, volumeUnit: "L", wasteFractionWeights: { residual: 49 } },
]
const wasteFractions: StatisticsInputs["wasteFractions"] = [
  { id: "residual", name: "Residual", weightToVolumeRatio: 0.12 },
  { id: "organic", name: "Organic", weightToVolumeRatio: 0.12 },
  { id: "glass", name: "Glass", weightToVolumeRatio: 0.3 },
]

function bin(
  id: string,
  property: string,
  fraction: string,
  type: string,
  extraFacts: Record<string, string> = {},
): BusinessRecord {
  return record(id, {
    "Container ID": id.toUpperCase(),
    Property: property,
    Address: `${property}, 2200 København N`,
    "Waste fractions": fraction,
    "Container type": type,
    "Curb location": "Curbside",
    "Service frequency": "Every 2 weeks",
    "Next collection": "18 Sep 2026",
    Agreement: "AGR-2600 · Active",
    ...extraFacts,
  })
}

const containers = [
  bin("a", "Ryesgade 45", "Residual", "Two-wheel bin · 240 L"),
  bin("b", "Ryesgade 45", "Organic", "Two-wheel bin · 240 L", { "Curb location": "Courtyard", Agreement: "AGR-2601 · Active" }),
  bin("c", "Jagtvej 10", "Residual", "Four-wheel bin · 660 L", { "Service frequency": "Weekly", Agreement: "AGR-2600 · Active" }),
  // Glass has no per-type weight — falls back to volume × ratio (240 × 0.3 = 72 kg).
  bin("d", "Jagtvej 10", "Glass", "Two-wheel bin · 240 L", { Agreement: "AGR-2700 · Future", "Next collection": "Not scheduled" }),
]

const base = (range: StatisticsInputs["range"]): StatisticsInputs => ({
  containerTypes,
  wasteFractions,
  stopIndex: new Map(),
  pickups: [],
  range,
  today: TODAY,
})

describe("selectionStatistics — overview", () => {
  test("counts containers, distinct properties, and collection points (property + kerb spot)", () => {
    const stats = selectionStatistics(containers, base(null))
    assert.equal(stats.containers, 4)
    assert.equal(stats.properties, 2)
    assert.equal(stats.collectionPoints, 3, "Ryesgade has a kerb and a courtyard spot")
    assert.deepEqual(stats.byFraction, [["Residual", 2], ["Organic", 1], ["Glass", 1]])
    assert.equal(stats.activeAgreements, 2, "AGR-2600 twice, AGR-2601 once, the Future one not counted")
  })
})

describe("selectionStatistics — quantities", () => {
  test("without a range, quantities are one collection of every container", () => {
    const stats = selectionStatistics(containers, base(null))
    assert.equal(stats.collections, 4)
    assert.equal(stats.assumedWeightKg, 18 + 22 + 49 + 72)
    assert.equal(stats.assumedVolumeLitres, 240 + 240 + 660 + 240)
    assert.equal(stats.collectedWeightKg, 0)
  })

  test("with a range, collections repeat at the service frequency from the next date", () => {
    // 16 Sep → 30 Sep: a (every 2 weeks from 18 Sep) collects once; c (weekly from 18 Sep) twice: 18, 25.
    const stats = selectionStatistics(containers, base({ from: TODAY, to: "2026-09-30" }))
    assert.equal(stats.collections, 1 + 1 + 2 + 0, "d has no scheduled collection")
    assert.equal(stats.assumedWeightKg, 18 + 22 + 49 * 2)
    assert.equal(stats.assumedVolumeLitres, 240 + 240 + 660 * 2)
  })

  test("generated route stops win over the registry's frequency projection", () => {
    const routes = [
      record("route-1", {}, { status: "Planned", submittedValues: { serviceDate: "2026-09-20" } }),
      record("route-2", {}, { status: "Planned", submittedValues: { serviceDate: "2026-09-27" } }),
    ]
    const pickups = [
      record("p1", {}, { status: "Planned", submittedValues: { containerId: "a", routeId: "route-1" } }),
      record("p2", {}, { status: "Planned", submittedValues: { containerId: "a", routeId: "route-2" } }),
      record("p3", {}, { status: "Completed", submittedValues: { containerId: "c", routeId: "route-1" }, facts: { Weight: "51 kg" } }),
      // Completed with a display container id and a tonne weight, dated by its own service date.
      record("p4", { "Container ID": "B", Weight: "0.1 t" }, { status: "Completed", submittedValues: { serviceDate: "2026-09-17" } }),
      // Outside the range — ignored.
      record("p5", { "Container ID": "B", Weight: "999 kg" }, { status: "Completed", submittedValues: { serviceDate: "2026-10-05" } }),
    ]
    const stats = selectionStatistics(containers, {
      ...base({ from: TODAY, to: "2026-09-30" }),
      stopIndex: routeStopIndex(routes, pickups),
      pickups,
    })
    // a: two generated stops (20, 27); c: one generated (20); b: projected once; d: none.
    assert.equal(stats.collections, 2 + 1 + 1)
    assert.equal(stats.collectedWeightKg, 51 + 100)
  })

  test("volume falls back to the litres in the type name when Settings has no such type", () => {
    const stats = selectionStatistics(
      [bin("x", "Sandkaj 1", "Residual", "Igloo · 3,000 L")],
      base(null),
    )
    assert.equal(stats.assumedVolumeLitres, 3000)
    assert.equal(stats.assumedWeightKg, 360, "3,000 L × the fraction's 0.12 kg/L")
  })
})
