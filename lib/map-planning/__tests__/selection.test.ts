import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../data/business-modules"
import { MAP_FILTER_READERS } from "../filters"
import type { MapPoint } from "../points"
import { parseSavedViews, serializeSavedViews, type SavedMapView } from "../saved-views"
import { schemeDraftFromSelection, selectionSummary } from "../selection"
import { emptyBusinessFilters } from "../../data/business-filters"

function record(id: string, extra: Partial<BusinessRecord> = {}): BusinessRecord {
  return {
    id,
    name: id,
    context: "",
    status: "Available",
    owner: "",
    value: "",
    updated: "",
    description: "",
    facts: {},
    related: [],
    source: "",
    freshness: "",
    ...extra,
  }
}

function point(id: string, propertyKey: string, fraction: string, values: Record<string, string> = {}): MapPoint {
  return {
    id,
    kind: "container",
    lngLat: { lng: 12.5, lat: 55.6 },
    fractions: [fraction],
    label: id,
    sublabel: "",
    propertyKey,
    containerIds: [id],
    record: record(id, { submittedValues: values }),
  }
}

describe("selectionSummary", () => {
  test("counts containers, distinct properties, and fractions by frequency", () => {
    const points = [
      point("a", "Ryesgade 45", "Organic"),
      point("b", "Ryesgade 45", "Residual"),
      point("c", "Jagtvej 10", "Residual"),
      point("d", "Jagtvej 10", "Glass"),
    ]
    const summary = selectionSummary(points, new Set(["a", "b", "c"]))
    assert.equal(summary.containers, 3)
    assert.equal(summary.properties, 2)
    assert.deepEqual(summary.byFraction, [["Residual", 2], ["Organic", 1]])
  })
})

describe("schemeDraftFromSelection", () => {
  test("a uniform selection seeds fraction, planning area, and project", () => {
    const points = [
      point("a", "P1", "Organic", { planningAreaId: "area-indreby", projectId: "project-copenhagen" }),
      point("b", "P2", "Organic", { planningAreaId: "area-indreby", projectId: "project-copenhagen" }),
    ]
    assert.deepEqual(schemeDraftFromSelection(points, new Set(["a", "b"])), {
      wasteFraction: "Organic",
      planningAreaId: "area-indreby",
      projectId: "project-copenhagen",
    })
  })

  test("a mixed selection seeds nothing it cannot decide", () => {
    const points = [
      point("a", "P1", "Organic", { planningAreaId: "area-indreby" }),
      point("b", "P2", "Glass", { planningAreaId: "area-amager-1" }),
    ]
    assert.deepEqual(schemeDraftFromSelection(points, new Set(["a", "b"])), {})
  })

  test("the project falls back to the record scope when nothing is typed", () => {
    const points = [
      { ...point("a", "P1", "Paper"), record: record("a", { projectIds: ["project-harbor"] }) },
    ]
    assert.deepEqual(schemeDraftFromSelection(points, new Set(["a"])), {
      wasteFraction: "Paper",
      projectId: "project-harbor",
    })
  })
})

describe("MAP_FILTER_READERS", () => {
  test("reads the container facts the popover and the map both filter by", () => {
    const container = record("c", {
      status: "Available",
      facts: {
        "Container type": "Two-wheel bin · 240 L",
        "Waste fractions": "Residual · Mixed",
        "Planning area": "Indre By Operations",
        "Property type": "Residential",
        "Service frequency": "Every 2 weeks",
        "Route scheme": "Østerbro Organic B",
      },
    })
    assert.deepEqual(MAP_FILTER_READERS.statuses?.(container), ["Available"])
    assert.deepEqual(MAP_FILTER_READERS.wasteFractions?.(container), ["Residual", "Mixed"])
    assert.deepEqual(MAP_FILTER_READERS.planningAreas?.(container), ["Indre By Operations"])
    assert.deepEqual(MAP_FILTER_READERS.propertyTypes?.(container), ["Residential"])
    assert.deepEqual(MAP_FILTER_READERS.planningAreas?.(record("x", { facts: { "Planning area": "—" } })), [])
  })
})

describe("saved views", () => {
  const view: SavedMapView = {
    id: "view-1",
    name: "Residual · Indre By",
    mode: "containers",
    window: "next-7",
    filters: { ...emptyBusinessFilters, wasteFractions: ["Residual"] },
    createdAt: "2026-09-16T10:00:00.000Z",
  }

  test("round-trips through storage", () => {
    assert.deepEqual(parseSavedViews(serializeSavedViews([view])), [view])
  })

  test("tolerates garbage and drops malformed entries", () => {
    assert.deepEqual(parseSavedViews(null), [])
    assert.deepEqual(parseSavedViews("not json"), [])
    assert.deepEqual(parseSavedViews('{"views": "nope"}'), [])
    const mixed = JSON.stringify({ views: [view, { id: "broken" }, { ...view, id: "v2", window: "weird" }] })
    const parsed = parseSavedViews(mixed)
    assert.deepEqual(parsed.map((entry) => entry.id), ["view-1", "v2"])
    assert.equal(parsed[1].window, "any", "an unknown window falls back to any date")
  })
})
