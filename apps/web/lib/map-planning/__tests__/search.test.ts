import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../data/business-modules"
import type { PlanningAreaLayer } from "@waste/domain/map-planning/areas"
import type { MapPoint } from "@waste/domain/map-planning/points"
import { searchMap } from "../search"

function record(id: string): BusinessRecord {
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
  }
}

function point(id: string, label: string, property: string, address: string, fraction = "Residual"): MapPoint {
  return {
    id,
    lngLat: { lng: 12.56, lat: 55.69 },
    fractions: [fraction],
    label,
    sublabel: address,
    propertyKey: property,
    containerIds: [id],
    record: record(id),
  }
}

const points = [
  point("asset-1", "BIN-91001", "Ryesgade 45", "Ryesgade 45, 2200 København N"),
  point("asset-2", "BIN-91002", "Ryesgade 45", "Ryesgade 45, 2200 København N", "Organic"),
  point("asset-3", "BIN-91010", "Jagtvej 10", "Jagtvej 10, 2200 København N"),
]
const areas: PlanningAreaLayer[] = [
  {
    id: "area-a",
    name: "Indre By Operations",
    color: "#000",
    containerCount: 3,
    polygon: [{ lng: 12.5, lat: 55.6 }, { lng: 12.6, lat: 55.6 }, { lng: 12.6, lat: 55.7 }],
    bounds: { west: 12.5, south: 55.6, east: 12.6, north: 55.7 },
  },
]

describe("searchMap", () => {
  test("an address query lists the property once — it stands for every container there", () => {
    const hits = searchMap("ryesgade", points, areas)
    assert.deepEqual(hits.map((hit) => [hit.kind, hit.label]), [["property", "Ryesgade 45"]])
    assert.equal(hits[0].sublabel, "2 containers · Ryesgade 45, 2200 København N")
    assert.deepEqual(hits[0].containerIds, ["asset-1", "asset-2"])
  })

  test("a container id matches directly and areas match by name with their bounds", () => {
    assert.deepEqual(searchMap("91010", points, areas).map((hit) => hit.label), ["BIN-91010"])
    const [area] = searchMap("indre", points, areas)
    assert.equal(area.kind, "area")
    assert.deepEqual(area.bounds, areas[0].bounds)
  })

  test("blank or unmatched queries return nothing; results are capped", () => {
    assert.deepEqual(searchMap("   ", points, areas), [])
    assert.deepEqual(searchMap("zzz", points, areas), [])
    const many = Array.from({ length: 30 }, (_, i) => point(`p${i}`, `BIN-${i}`, `Street ${i}`, `Street ${i}, City`))
    assert.equal(searchMap("street", many, [], 8).length, 8)
  })
})
