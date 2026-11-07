import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  convexHull,
  expandPolygon,
  offsetMetres,
  planningAreaOutline,
  pointInPolygon,
  polygonAreaSquareMetres,
  polygonCentroid,
  type LngLat,
} from "../geo"

const origin: LngLat = { lng: 12.56, lat: 55.69 }
const square = [
  origin,
  offsetMetres(origin, 100, 0),
  offsetMetres(origin, 100, 100),
  offsetMetres(origin, 0, 100),
]

describe("polygonAreaSquareMetres", () => {
  test("a 100 m square is 10,000 m² whichever way it winds", () => {
    const area = polygonAreaSquareMetres(square)
    assert.ok(Math.abs(area - 10_000) < 50, `got ${area}`)
    assert.ok(Math.abs(polygonAreaSquareMetres([...square].reverse()) - 10_000) < 50)
  })

  test("fewer than three vertices have no area", () => {
    assert.equal(polygonAreaSquareMetres([]), 0)
    assert.equal(polygonAreaSquareMetres(square.slice(0, 2)), 0)
  })
})

describe("convexHull", () => {
  test("drops interior and duplicate points and keeps the corners", () => {
    const inside = offsetMetres(origin, 40, 60)
    const hull = convexHull([...square, inside, origin, square[2]])
    assert.equal(hull.length, 4)
    for (const corner of square) {
      assert.ok(hull.some((p) => Math.abs(p.lng - corner.lng) < 1e-9 && Math.abs(p.lat - corner.lat) < 1e-9))
    }
    assert.ok(!hull.some((p) => Math.abs(p.lng - inside.lng) < 1e-9 && Math.abs(p.lat - inside.lat) < 1e-9))
  })

  test("fewer than three distinct points come back as they are", () => {
    assert.deepEqual(convexHull([origin, origin]), [origin])
    assert.equal(convexHull([origin, square[1]]).length, 2)
    assert.deepEqual(convexHull([]), [])
  })
})

describe("polygonCentroid and expandPolygon", () => {
  test("the centroid of the square is its middle", () => {
    const centre = polygonCentroid(square)
    const expected = offsetMetres(origin, 50, 50)
    assert.ok(Math.abs(centre.lng - expected.lng) < 1e-6)
    assert.ok(Math.abs(centre.lat - expected.lat) < 1e-6)
  })

  test("expanding pushes every vertex away from the centroid by the metres given", () => {
    const grown = expandPolygon(square, 50)
    assert.equal(grown.length, 4)
    const before = polygonAreaSquareMetres(square)
    const after = polygonAreaSquareMetres(grown)
    // 100 m square → corners move 50 m outward along the diagonals ≈ 170.7 m square.
    assert.ok(after > before * 2.5 && after < before * 3.2, `got ${after / before}`)
    assert.deepEqual(expandPolygon([], 50), [])
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
