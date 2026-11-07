import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { pointInPolygon, type LngLat } from "@waste/domain/map-planning/geo"
import { planningAreaOutline } from "../areas"

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
