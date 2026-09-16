import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { worldPoint, type LngLat } from "../geo"
import {
  ROAD_GEOMETRY_CACHE_MAX,
  chevronsAlong,
  chunkStops,
  fetchRoadGeometry,
  localPathData,
  osrmRouteUrl,
  parseOsrmRoute,
  parseRoadGeometryCache,
  rememberRoadGeometry,
  roadGeometryKey,
  roadPath,
  serializeRoadGeometryCache,
  type RoadGeometry,
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

/**
 * An OSRM "route" answer for these stops: the overview geometry visits every
 * stop with one bent vertex between neighbours, the waypoints are the stops
 * themselves, and each leg is 100 m / 60 s.
 */
function osrmAnswer(chunk: readonly LngLat[]) {
  const coordinates: [number, number][] = []
  chunk.forEach((stop, index) => {
    if (index > 0) {
      const mid = midpoint(chunk[index - 1], stop)
      coordinates.push([mid.lng, mid.lat])
    }
    coordinates.push([stop.lng, stop.lat])
  })
  return {
    code: "Ok",
    routes: [
      {
        distance: 100 * (chunk.length - 1),
        duration: 60 * (chunk.length - 1),
        geometry: { type: "LineString", coordinates },
        legs: chunk.slice(1).map(() => ({ distance: 100, duration: 60 })),
      },
    ],
    waypoints: chunk.map((stop) => ({ location: [stop.lng, stop.lat] })),
  }
}

/** Reads the stops back out of a request URL. */
function stopsInUrl(url: string): LngLat[] {
  const path = new URL(url).pathname.split("/driving/")[1]
  return path.split(";").map((pair) => {
    const [lng, lat] = pair.split(",").map(Number)
    return { lng, lat }
  })
}

describe("roadGeometryKey", () => {
  test("the same stops give the same key, with coordinates rounded to five decimals", () => {
    const jittered = stops.map((stop) => ({ lng: stop.lng + 0.000001, lat: stop.lat - 0.000001 }))
    assert.equal(roadGeometryKey(jittered), roadGeometryKey(stops))
  })

  test("stop order is part of the key — a route driven backwards is a different road", () => {
    assert.notEqual(roadGeometryKey([...stops].reverse()), roadGeometryKey(stops))
  })
})

describe("chunkStops", () => {
  test("chunks share their boundary stop so the legs join up", () => {
    assert.deepEqual(chunkStops([0, 1, 2, 3, 4, 5, 6], 3), [
      [0, 1, 2],
      [2, 3, 4],
      [4, 5, 6],
    ])
    assert.deepEqual(chunkStops([0, 1, 2, 3], 3), [
      [0, 1, 2],
      [2, 3],
    ])
  })

  test("a list that fits is one chunk", () => {
    assert.deepEqual(chunkStops([0, 1, 2], 3), [[0, 1, 2]])
    assert.deepEqual(chunkStops([0], 3), [[0]])
  })
})

describe("osrmRouteUrl", () => {
  test("asks the driving profile for the full GeoJSON overview without turn steps", () => {
    assert.equal(
      osrmRouteUrl(stops.slice(0, 2), "https://osrm.example"),
      "https://osrm.example/route/v1/driving/12.568300,55.686700;12.572300,55.690100?overview=full&geometries=geojson&steps=false",
    )
  })
})

describe("parseOsrmRoute", () => {
  test("splits the overview geometry into one leg per pair of stops at the snapped waypoints", () => {
    const geometry = parseOsrmRoute(osrmAnswer(stops.slice(0, 3)), 3)
    assert.equal(geometry.legs.length, 2)
    assert.deepEqual(geometry.legs[0], [stops[0], midpoint(stops[0], stops[1]), stops[1]])
    assert.deepEqual(geometry.legs[1], [stops[1], midpoint(stops[1], stops[2]), stops[2]])
    assert.deepEqual(geometry.snappedStops, stops.slice(0, 3))
    assert.equal(geometry.distanceMetres, 200)
    assert.equal(geometry.durationSeconds, 120)
  })

  test("rejects an answer that is not Ok or does not match the stops", () => {
    assert.throws(() => parseOsrmRoute({ code: "NoRoute", routes: [] }, 2), /NoRoute/)
    assert.throws(() => parseOsrmRoute(osrmAnswer(stops.slice(0, 3)), 4), /waypoints/)
  })
})

describe("fetchRoadGeometry", () => {
  test("a single stop needs no road and no request", async () => {
    let requests = 0
    const geometry = await fetchRoadGeometry(stops.slice(0, 1), {
      fetch: async () => {
        requests += 1
        return { ok: true, status: 200, json: async () => osrmAnswer([]) }
      },
    })
    assert.equal(requests, 0)
    assert.deepEqual(geometry, { legs: [], snappedStops: stops.slice(0, 1), distanceMetres: 0, durationSeconds: 0 })
  })

  test("long routes go out in overlapping chunks and come back as one geometry", async () => {
    const urls: string[] = []
    const geometry = await fetchRoadGeometry(stops, {
      chunkSize: 3,
      fetch: async (url) => {
        urls.push(url)
        return { ok: true, status: 200, json: async () => osrmAnswer(stopsInUrl(url)) }
      },
    })
    assert.equal(urls.length, 2)
    assert.deepEqual(stopsInUrl(urls[0]), stops.slice(0, 3))
    assert.deepEqual(stopsInUrl(urls[1]), stops.slice(2, 5))
    assert.equal(geometry.legs.length, 4)
    assert.deepEqual(geometry.snappedStops, stops)
    assert.equal(geometry.distanceMetres, 400)
    assert.equal(geometry.durationSeconds, 240)
    // The path runs through every stop once, midpoints between them.
    assert.equal(roadPath(geometry).length, 9)
    assert.deepEqual(roadPath(geometry)[4], stops[2])
  })

  test("a failed request rejects instead of inventing a road", async () => {
    await assert.rejects(
      fetchRoadGeometry(stops.slice(0, 2), {
        fetch: async () => ({ ok: false, status: 429, json: async () => ({}) }),
      }),
      /429/,
    )
  })
})

describe("road geometry cache", () => {
  const geometry: RoadGeometry = {
    legs: [[stops[0], stops[1]]],
    snappedStops: stops.slice(0, 2),
    distanceMetres: 100,
    durationSeconds: 60,
  }

  test("nothing stored, or garbage, is an empty cache", () => {
    assert.equal(parseRoadGeometryCache(null).size, 0)
    assert.equal(parseRoadGeometryCache("not json").size, 0)
    assert.equal(parseRoadGeometryCache(JSON.stringify({ entries: "nope" })).size, 0)
  })

  test("a serialized cache round-trips in insertion order", () => {
    const cache = new Map<string, RoadGeometry>()
    rememberRoadGeometry(cache, "a", geometry)
    rememberRoadGeometry(cache, "b", { ...geometry, distanceMetres: 200 })
    const parsed = parseRoadGeometryCache(serializeRoadGeometryCache(cache))
    assert.deepEqual([...parsed.keys()], ["a", "b"])
    assert.deepEqual(parsed.get("b"), { ...geometry, distanceMetres: 200 })
  })

  test("remembering a key again moves it to the end, and the oldest key is evicted past the cap", () => {
    const cache = new Map<string, RoadGeometry>()
    rememberRoadGeometry(cache, "a", geometry, 2)
    rememberRoadGeometry(cache, "b", geometry, 2)
    rememberRoadGeometry(cache, "a", geometry, 2)
    rememberRoadGeometry(cache, "c", geometry, 2)
    assert.deepEqual([...cache.keys()], ["a", "c"])
    assert.ok(ROAD_GEOMETRY_CACHE_MAX >= 100)
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
