import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../prototype-record"
import { REGISTRY_VISIBILITY_FACT, SOFT_DELETED } from "../../record-visibility"
import {
  SERVICE_AREA_POLYGON_KEY,
  serviceAreaLayers,
  serviceAreaPolygon,
  serviceAreaPolygonValue,
  serviceAreaSeedFromSelection,
} from "../service-areas"

function record(id: string, facts: Record<string, string> = {}, extra: Partial<BusinessRecord> = {}): BusinessRecord {
  return {
    id,
    name: id,
    context: "",
    status: "Active",
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

const square = [
  { lng: 12.5, lat: 55.6 },
  { lng: 12.6, lat: 55.6 },
  { lng: 12.6, lat: 55.7 },
  { lng: 12.5, lat: 55.7 },
]

const planningAreas = [
  record("area-osterbro", {}, { name: "Østerbro Zone 2" }),
  record("area-indreby", {}, { name: "Indre By Operations" }),
  record("area-amager", {}, { name: "Amager Zone 1" }),
]

describe("serviceAreaPolygon", () => {
  test("reads back exactly the polygon serviceAreaPolygonValue stored", () => {
    const stored = record("sa-0", {}, { submittedValues: { [SERVICE_AREA_POLYGON_KEY]: serviceAreaPolygonValue(square) } })
    assert.deepEqual(serviceAreaPolygon(stored), square)
  })

  test("reads the stored polygon; anything missing, malformed, or too short is null", () => {
    const stored = record("sa-1", {}, { submittedValues: { [SERVICE_AREA_POLYGON_KEY]: JSON.stringify(square) } })
    assert.deepEqual(serviceAreaPolygon(stored), square)
    assert.equal(serviceAreaPolygon(record("sa-2")), null)
    assert.equal(serviceAreaPolygon(record("sa-3", {}, { submittedValues: { [SERVICE_AREA_POLYGON_KEY]: "nope" } })), null)
    assert.equal(
      serviceAreaPolygon(record("sa-4", {}, { submittedValues: { [SERVICE_AREA_POLYGON_KEY]: JSON.stringify(square.slice(0, 2)) } })),
      null,
    )
  })
})

describe("serviceAreaSeedFromSelection", () => {
  const selected = [
    record("a", { "Planning area": "Østerbro Zone 2" }, { projectIds: ["project-copenhagen"] }),
    record("b", {}, { projectIds: ["project-copenhagen"], submittedValues: { planningAreaId: "area-indreby" } }),
    record("c", { "Planning area": "Østerbro Zone 2" }, { projectIds: ["project-copenhagen"] }),
  ]

  test("names the uniform project, the planning areas the containers name, a boundary line, and the drawn polygon", () => {
    const seed = serviceAreaSeedFromSelection({
      selected,
      shape: { kind: "rectangle", polygon: square },
      planningAreas,
      properties: 2,
    })
    assert.deepEqual(seed, {
      projectId: "project-copenhagen",
      planningAreaIds: ["area-osterbro", "area-indreby"],
      boundary: "Drawn on Map Planning · 3 containers across 2 properties",
      polygon: square,
    })
  })

  test("a mixed project is null and a hand-picked selection has no polygon", () => {
    const mixed = [...selected, record("d", {}, { projectIds: ["project-harbor"] })]
    const seed = serviceAreaSeedFromSelection({ selected: mixed, shape: null, planningAreas, properties: 3 })
    assert.equal(seed.projectId, null)
    assert.equal(seed.polygon, null)
    assert.equal(seed.boundary, "Selected on Map Planning · 4 containers across 3 properties")
  })

  test("one container at one property reads in the singular", () => {
    const seed = serviceAreaSeedFromSelection({ selected: selected.slice(0, 1), shape: null, planningAreas, properties: 1 })
    assert.equal(seed.boundary, "Selected on Map Planning · 1 container across 1 property")
  })

  test("a typed placeholder is not a project, and an empty record scope is null rather than blank", () => {
    const placeholder = serviceAreaSeedFromSelection({
      selected: [record("g", {}, { projectIds: ["project-copenhagen"], submittedValues: { projectId: "—" } })],
      shape: null,
      planningAreas,
      properties: 1,
    })
    assert.equal(placeholder.projectId, "project-copenhagen", "the placeholder falls back to record scope")
    const blank = serviceAreaSeedFromSelection({
      selected: [record("h", {}, { projectIds: [""] }), record("i", {}, { projectIds: [""] })],
      shape: null,
      planningAreas,
      properties: 2,
    })
    assert.equal(blank.projectId, null)
  })

  test("a typed project wins over record scope, and containers naming no known area contribute none", () => {
    const seed = serviceAreaSeedFromSelection({
      selected: [
        record("e", { "Planning area": "Nowhere Zone" }, { projectIds: ["project-harbor"], submittedValues: { projectId: "project-copenhagen" } }),
        record("f", {}, { projectIds: ["project-copenhagen"] }),
      ],
      shape: null,
      planningAreas,
      properties: 2,
    })
    assert.equal(seed.projectId, "project-copenhagen")
    assert.deepEqual(seed.planningAreaIds, [])
  })
})

describe("serviceAreaLayers", () => {
  test("one layer per area with a polygon, coloured in order, skipping deleted and polygon-less areas", () => {
    const areas = [
      record("sa-1", { "Service provider": "NordRen ApS" }, { name: "CA-1", submittedValues: { [SERVICE_AREA_POLYGON_KEY]: JSON.stringify(square) } }),
      record("sa-2", {}, { name: "CA-2" }),
      record("sa-3", { [REGISTRY_VISIBILITY_FACT]: SOFT_DELETED }, { name: "CA-3", submittedValues: { [SERVICE_AREA_POLYGON_KEY]: JSON.stringify(square) } }),
      record("sa-4", {}, { name: "CA-4", submittedValues: { [SERVICE_AREA_POLYGON_KEY]: JSON.stringify(square) } }),
    ]
    const layers = serviceAreaLayers(areas)
    assert.deepEqual(layers.map((layer) => layer.id), ["sa-1", "sa-4"])
    assert.equal(layers[0].serviceProvider, "NordRen ApS")
    assert.equal(layers[1].serviceProvider, "Unassigned")
    assert.notEqual(layers[0].color, layers[1].color)
    assert.deepEqual(layers[0].bounds, { west: 12.5, south: 55.6, east: 12.6, north: 55.7 })
  })
})
