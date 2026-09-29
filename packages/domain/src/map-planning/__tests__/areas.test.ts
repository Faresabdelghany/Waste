import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../prototype-record"
import { AREA_LAYER_PALETTE, planningAreaLayers, planningAreaOutline } from "../areas"
import { pointInPolygon, type LngLat } from "../geo"
import { containerLocation } from "../positions"
import { TEST_GAZETTEER } from "./gazetteer-fixture"

function record(id: string, facts: Record<string, string>, extra: Partial<BusinessRecord> = {}): BusinessRecord {
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

const area = (id: string, name: string) => record(id, {}, { name })

function container(id: string, address: string, areaId: string | null, areaName = "—"): BusinessRecord {
  return record(
    id,
    { Address: address, Property: address.split(",")[0], "Planning area": areaName },
    { status: "Available", submittedValues: areaId ? { planningAreaId: areaId } : undefined },
  )
}

describe("planningAreaLayers", () => {
  const areas = [area("area-a", "Indre By Operations"), area("area-b", "Amager Zone 1"), area("area-empty", "Nowhere")]
  const containers = [
    container("c1", "Ryesgade 12, 2200 København N", "area-a"),
    container("c2", "Ryesgade 88, 2200 København N", "area-a"),
    container("c3", "Jagtvej 40, 2200 København N", "area-a"),
    container("c4", "Blegdamsvej 3, 2200 København N", "area-a"),
    // Linked by the display fact only — legacy-shaped record.
    container("c5", "Amagerbrogade 100, 2300 København S", null, "Amager Zone 1"),
    { ...container("stored", "Warehouse West", "area-a"), status: "In storage" },
  ]

  test("every visible area gets a row; geometry wraps its located containers", () => {
    const layers = planningAreaLayers(areas, containers, TEST_GAZETTEER)
    assert.deepEqual(layers.map((layer) => layer.id), ["area-a", "area-b", "area-empty"])
    const a = layers[0]
    assert.equal(a.name, "Indre By Operations")
    assert.equal(a.containerCount, 4, "the stored container is not on the map")
    assert.ok(a.polygon.length >= 3)
    assert.ok(a.bounds)
    for (const id of ["c1", "c2", "c3", "c4"]) {
      const spot = containerLocation(containers.find((c) => c.id === id)!, TEST_GAZETTEER)!
      assert.ok(pointInPolygon(spot, a.polygon), `${id} sits inside its area`)
    }
  })

  test("a single located container still yields a small box; none yields no geometry", () => {
    const layers = planningAreaLayers(areas, containers, TEST_GAZETTEER)
    const b = layers[1]
    assert.equal(b.containerCount, 1)
    assert.equal(b.polygon.length, 4)
    assert.ok(pointInPolygon(containerLocation(containers[4], TEST_GAZETTEER)!, b.polygon))
    const empty = layers[2]
    assert.equal(empty.containerCount, 0)
    assert.deepEqual(empty.polygon, [])
    assert.equal(empty.bounds, null)
  })

  test("an area's layer is the outline of its located containers' spots: the one helper the database seed derives boundaries with", () => {
    const [a, b] = planningAreaLayers(areas, containers, TEST_GAZETTEER)
    const spots = (ids: string[]) => ids.map((id) => containerLocation(containers.find((c) => c.id === id)!, TEST_GAZETTEER)!)
    assert.deepEqual(a.polygon, planningAreaOutline(spots(["c1", "c2", "c3", "c4"])))
    assert.deepEqual(b.polygon, planningAreaOutline(spots(["c5"])))
  })

  test("an area that carries its boundary from the server (submittedValues.geometry, a GeoJSON Polygon) is drawn as it stands, whatever containers are filed under it", () => {
    const ring: [number, number][] = [
      [12.56, 55.67],
      [12.58, 55.67],
      [12.58, 55.69],
      [12.56, 55.69],
      [12.56, 55.67],
    ]
    const stored = record("area-a", {}, { name: "Indre By Operations", submittedValues: { geometry: JSON.stringify({ type: "Polygon", coordinates: [ring] }) } })
    const [layer] = planningAreaLayers([stored], containers, TEST_GAZETTEER)
    assert.deepEqual(layer.polygon, ring.slice(0, 4).map(([lng, lat]) => ({ lng, lat })), "the outer ring, open, as the map draws every outline")
    assert.equal(layer.containerCount, 4, "the count still says what the map places among the area's records")
    assert.ok(layer.bounds)
    const garbage = record("area-x", {}, { name: "Nowhere", submittedValues: { geometry: "north of the river" } })
    assert.deepEqual(planningAreaLayers([garbage], containers, TEST_GAZETTEER)[0].polygon, [], "text that is no polygon leaves the containers to decide, and Nowhere has none")
  })

  test("colours cycle the palette in list order and soft-deleted areas are skipped", () => {
    const layers = planningAreaLayers(
      [...areas, record("gone", { "Registry visibility": "Soft deleted" }, { name: "Gone" })],
      containers,
      TEST_GAZETTEER,
    )
    assert.equal(layers.length, 3)
    assert.equal(layers[0].color, AREA_LAYER_PALETTE[0])
    assert.equal(layers[1].color, AREA_LAYER_PALETTE[1])
  })
})

/** Flat-earth metres between two spots, the scale the map's geometry works in: fine within a city. */
function metresBetween(a: LngLat, b: LngLat): number {
  const metresPerDegreeLat = 111_320
  const metresPerDegreeLng = metresPerDegreeLat * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180)
  return Math.hypot((b.lng - a.lng) * metresPerDegreeLng, (b.lat - a.lat) * metresPerDegreeLat)
}

describe("planningAreaOutline", () => {
  const ryesgade: LngLat = { lng: 12.5605, lat: 55.6905 }
  const blegdamsvej: LngLat = { lng: 12.5615, lat: 55.6935 }
  const jagtvej: LngLat = { lng: 12.5445, lat: 55.6935 }

  test("no spot has no outline", () => {
    assert.deepEqual(planningAreaOutline([]), [])
  })

  test("one or two spots are boxed 120 m past them", () => {
    const one = planningAreaOutline([ryesgade])
    assert.equal(one.length, 4)
    assert.ok(pointInPolygon(ryesgade, one))
    for (const corner of one) assert.ok(Math.abs(metresBetween(ryesgade, corner) - 120 * Math.SQRT2) < 1, "each corner 120 m east or west and 120 m north or south")

    const two = planningAreaOutline([ryesgade, blegdamsvej])
    assert.equal(two.length, 4)
    for (const spot of [ryesgade, blegdamsvej]) assert.ok(pointInPolygon(spot, two))
  })

  test("three or more spots are their hull pushed 80 m out: every spot inside, every vertex 80 m from the nearest", () => {
    const inside: LngLat = { lng: 12.556, lat: 55.6925 }
    const outline = planningAreaOutline([ryesgade, blegdamsvej, jagtvej, inside, ryesgade])
    assert.equal(outline.length, 3, "the hull of the three corners; the spot inside it and the repeat add no vertex")
    for (const spot of [ryesgade, blegdamsvej, jagtvej, inside]) assert.ok(pointInPolygon(spot, outline))
    for (const vertex of outline) {
      const nearest = Math.min(...[ryesgade, blegdamsvej, jagtvej, inside].map((spot) => metresBetween(spot, vertex)))
      assert.ok(Math.abs(nearest - 80) < 0.5, `a vertex ${nearest.toFixed(1)} m from the nearest spot`)
    }
  })
})
