import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { worldPoint, type LngLat } from "@waste/domain/map-planning/geo"
import {
  ROAD_ORIGIN,
  ROAD_REF_ZOOM,
  chevronsAlong,
  localPathData,
  roadGeometryKey,
  roadGeometryOfLegs,
  roadOverlay,
  roadOverlayPath,
  roadPath,
  type WireLeg,
} from "../road-geometry"

const stops: LngLat[] = [
  { lng: 12.5683, lat: 55.6867 },
  { lng: 12.5723, lat: 55.6901 },
  { lng: 12.5801, lat: 55.6944 },
  { lng: 12.5867, lat: 55.6989 },
  { lng: 12.59, lat: 55.7 },
]

/** A vertex between two stops, bent 50 m or so off the straight line the way a real road is. */
const midpoint = (a: LngLat, b: LngLat): LngLat => ({ lng: (a.lng + b.lng) / 2, lat: (a.lat + b.lat) / 2 + 0.0005 })

/** The legs the API answers for these stops: one per pair, each through a bent midpoint, 100 m and 60 s. */
const legsThrough = (points: readonly LngLat[]): WireLeg[] =>
  points.slice(1).map((stop, index) => {
    const mid = midpoint(points[index], stop)
    return {
      path: { type: "LineString", coordinates: [[points[index].lng, points[index].lat], [mid.lng, mid.lat], [stop.lng, stop.lat]] },
      metres: 100,
      seconds: 60,
    }
  })

describe("roadGeometryKey", () => {
  test("the same stops give the same key, with coordinates rounded to five decimals", () => {
    const jittered = stops.map((stop) => ({ lng: stop.lng + 0.000001, lat: stop.lat - 0.000001 }))
    assert.equal(roadGeometryKey(jittered), roadGeometryKey(stops))
  })

  test("stop order is part of the key — a route driven backwards is a different road", () => {
    assert.notEqual(roadGeometryKey([...stops].reverse()), roadGeometryKey(stops))
  })
})

describe("roadGeometryOfLegs: the API's legs, a preview's or a Plan's, as the maps draw them (#173)", () => {
  const source = { provider: "openrouteservice", optimised: false }

  test("one leg per pair of stops, the stops where the legs meet, the totals their sums, and the source kept", () => {
    const road = roadGeometryOfLegs(legsThrough(stops), source)
    assert.ok(road)
    assert.equal(road.legs.length, stops.length - 1)
    assert.deepEqual(road.snappedStops, stops)
    assert.deepEqual(road.legs[0][1], midpoint(stops[0], stops[1]), "a bent vertex is a road's, and stays")
    assert.equal(road.distanceMetres, 400)
    assert.equal(road.durationSeconds, 240)
    assert.deepEqual(road.source, source)
  })

  test("a vertex on the straight line between its neighbours is dropped; a zero leg over a repeated stop stays one point pair", () => {
    const straight: WireLeg = { path: { type: "LineString", coordinates: [[12.5, 55.7], [12.505, 55.7], [12.51, 55.7]] }, metres: 630, seconds: 63 }
    const repeated: WireLeg = { path: { type: "LineString", coordinates: [[12.51, 55.7], [12.51, 55.7]] }, metres: 0, seconds: 0 }
    const road = roadGeometryOfLegs([straight, repeated], source)
    assert.deepEqual(road?.legs, [
      [
        { lng: 12.5, lat: 55.7 },
        { lng: 12.51, lat: 55.7 },
      ],
      [
        { lng: 12.51, lat: 55.7 },
        { lng: 12.51, lat: 55.7 },
      ],
    ])
    assert.deepEqual(road?.snappedStops.length, 3)
  })

  test("no legs is no road to draw", () => {
    assert.equal(roadGeometryOfLegs([], source), null)
  })

  test("roadPath joins the legs, each joint vertex once", () => {
    const road = roadGeometryOfLegs(legsThrough(stops.slice(0, 3)), source)
    assert.ok(road)
    assert.deepEqual(roadPath(road), [stops[0], midpoint(stops[0], stops[1]), stops[1], midpoint(stops[1], stops[2]), stops[2]])
  })
})

describe("localPathData", () => {
  test("an SVG path in world pixels at the reference zoom, relative to the origin", () => {
    const origin = { lng: 12.5683, lat: 55.6867 }
    const o = worldPoint(origin, 16)
    const a = worldPoint(stops[1], 16)
    const b = worldPoint(stops[2], 16)
    const fmt = (value: number) => value.toFixed(2)
    assert.equal(
      localPathData([stops[1], stops[2]], 16, origin),
      `M${fmt(a.x - o.x)} ${fmt(a.y - o.y)}L${fmt(b.x - o.x)} ${fmt(b.y - o.y)}`,
    )
    assert.equal(localPathData([], 16, origin), "")
  })
})

describe("roadOverlay", () => {
  /** A north-up camera at `zoom`, its centre `centre` at screen (400, 300). */
  const camera = (centre: LngLat, zoom: number) => (lngLat: LngLat) => {
    const c = worldPoint(centre, zoom)
    const p = worldPoint(lngLat, zoom)
    return { x: 400 + (p.x - c.x), y: 300 + (p.y - c.y) }
  }

  test("at the reference zoom the scale is 1 and the transform lands the origin at its screen point", () => {
    const overlay = roadOverlay(camera(ROAD_ORIGIN, ROAD_REF_ZOOM))
    assert.ok(overlay)
    assert.ok(Math.abs(overlay.scale - 1) < 1e-9)
    assert.equal(overlay.transform, `translate(400 300) scale(${overlay.scale})`)
  })

  test("two zoom levels out the scale is a quarter, and a path built once lands where the camera projects it", () => {
    const zoom = ROAD_REF_ZOOM - 2
    const project = camera(stops[2], zoom)
    const overlay = roadOverlay(project)
    assert.ok(overlay)
    assert.ok(Math.abs(overlay.scale - 0.25) < 1e-9)
    // The path's first vertex, run through the group transform, is the projected stop.
    const match = /^M(-?[\d.]+) (-?[\d.]+)/.exec(roadOverlayPath([stops[1], stops[2]]))
    assert.ok(match)
    const origin = project(ROAD_ORIGIN)
    const onScreen = { x: origin.x + Number(match[1]) * overlay.scale, y: origin.y + Number(match[2]) * overlay.scale }
    const expected = project(stops[1])
    assert.ok(Math.abs(onScreen.x - expected.x) < 0.01 && Math.abs(onScreen.y - expected.y) < 0.01, JSON.stringify({ onScreen, expected }))
  })

  test("no projection yet means no overlay", () => {
    assert.equal(roadOverlay(() => null), null)
  })
})

describe("chevronsAlong", () => {
  test("places a direction marker every `spacing` pixels along a screen path, starting half a step in", () => {
    const along = chevronsAlong(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
      80,
    )
    assert.deepEqual(along, [
      { x: 40, y: 0, angle: 0 },
      { x: 100, y: 20, angle: 90 },
      { x: 100, y: 100, angle: 90 },
    ])
  })

  test("a path shorter than half a step, or a single point, gets none", () => {
    assert.deepEqual(chevronsAlong([{ x: 0, y: 0 }, { x: 10, y: 0 }], 80), [])
    assert.deepEqual(chevronsAlong([{ x: 0, y: 0 }], 80), [])
  })
})
