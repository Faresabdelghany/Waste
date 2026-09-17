import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  boundsFromPolygon,
  inBounds,
  pointInPolygon,
  simplifyPath,
  worldPoint,
  type LngLat,
} from "../geo"

const square: LngLat[] = [
  { lng: 12.5, lat: 55.6 },
  { lng: 12.6, lat: 55.6 },
  { lng: 12.6, lat: 55.7 },
  { lng: 12.5, lat: 55.7 },
]

describe("web mercator", () => {
  test("the null island sits at the centre of a 512 px world at zoom 0", () => {
    assert.deepEqual(worldPoint({ lng: 0, lat: 0 }, 0), { x: 256, y: 256 })
  })

  test("the world doubles per zoom level", () => {
    assert.equal(worldPoint({ lng: 180, lat: 0 }, 0).x, 512)
    assert.equal(worldPoint({ lng: 180, lat: 0 }, 1).x, 1024)
  })

  test("north is up: higher latitude has the smaller y", () => {
    assert.ok(worldPoint({ lng: 0, lat: 55 }, 3).y < worldPoint({ lng: 0, lat: 50 }, 3).y)
  })
})

describe("point in polygon", () => {
  test("inside, outside, and a degenerate polygon", () => {
    assert.equal(pointInPolygon({ lng: 12.55, lat: 55.65 }, square), true)
    assert.equal(pointInPolygon({ lng: 12.7, lat: 55.65 }, square), false)
    assert.equal(pointInPolygon({ lng: 12.55, lat: 55.65 }, square.slice(0, 2)), false)
  })

  test("a concave shape keeps its notch outside", () => {
    const notched: LngLat[] = [
      { lng: 0, lat: 0 },
      { lng: 4, lat: 0 },
      { lng: 4, lat: 4 },
      { lng: 2, lat: 1 },
      { lng: 0, lat: 4 },
    ]
    assert.equal(pointInPolygon({ lng: 2, lat: 3 }, notched), false)
    assert.equal(pointInPolygon({ lng: 1, lat: 1 }, notched), true)
  })
})

describe("bounds", () => {
  test("the polygon's bounding box and membership", () => {
    const bounds = boundsFromPolygon(square)
    assert.deepEqual(bounds, { west: 12.5, south: 55.6, east: 12.6, north: 55.7 })
    assert.equal(inBounds({ lng: 12.55, lat: 55.65 }, bounds), true)
    assert.equal(inBounds({ lng: 12.45, lat: 55.65 }, bounds), false)
  })
})

describe("simplifyPath", () => {
  test("drops vertices that sit on the line between their neighbours and keeps the corners", () => {
    const path: LngLat[] = [
      { lng: 12.5, lat: 55.6 },
      { lng: 12.55, lat: 55.6 },
      { lng: 12.6, lat: 55.6 },
      { lng: 12.6, lat: 55.65 },
      { lng: 12.6, lat: 55.7 },
    ]
    assert.deepEqual(simplifyPath(path, 2), [
      { lng: 12.5, lat: 55.6 },
      { lng: 12.6, lat: 55.6 },
      { lng: 12.6, lat: 55.7 },
    ])
  })

  test("keeps a bend wider than the tolerance and a short path untouched", () => {
    const bend: LngLat[] = [
      { lng: 12.5, lat: 55.6 },
      { lng: 12.55, lat: 55.601 },
      { lng: 12.6, lat: 55.6 },
    ]
    assert.deepEqual(simplifyPath(bend, 2), bend)
    assert.deepEqual(simplifyPath(bend.slice(0, 2), 2), bend.slice(0, 2))
  })
})
