import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../prototype-record"
import { REGISTRY_VISIBILITY_FACT, SOFT_DELETED } from "../../record-visibility"
import {
  SERVICE_AREA_POLYGON_KEY,
  serviceAreaLayers,
  serviceAreaPolygon,
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

  test("prefills the project when uniform, the planning areas the containers name, and a boundary line", () => {
    const seed = serviceAreaSeedFromSelection({
      selected,
      shape: { kind: "rectangle", polygon: square },
      planningAreas,
      properties: 2,
    })
    assert.equal(seed.initialValues.projectId, "project-copenhagen")
    assert.equal(seed.initialValues.zoneIds, "area-osterbro,area-indreby", "typed id and named area, in planning-area order")
    assert.equal(seed.initialValues.boundary, "Drawn on Map Planning · 3 containers across 2 properties")
    assert.equal(seed.extraValues[SERVICE_AREA_POLYGON_KEY], JSON.stringify(square))
  })

  test("a mixed project is left blank and a hand-picked selection stores no polygon", () => {
    const mixed = [...selected, record("d", {}, { projectIds: ["project-harbor"] })]
    const seed = serviceAreaSeedFromSelection({ selected: mixed, shape: null, planningAreas, properties: 3 })
    assert.equal(seed.initialValues.projectId, undefined)
    assert.deepEqual(seed.extraValues, {})
    assert.equal(seed.initialValues.boundary, "Selected on Map Planning · 4 containers across 3 properties")
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
