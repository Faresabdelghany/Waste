import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { Latitude, LinearRing, Longitude, Point, Polygon, Position } from "../geojson"

const cph: [number, number] = [12.5683, 55.6761]

describe("Longitude and Latitude", () => {
  test("stay inside the WGS 84 ranges", () => {
    assert.ok(Longitude.safeParse(-180).success)
    assert.ok(Longitude.safeParse(180).success)
    assert.equal(Longitude.safeParse(180.0001).success, false)
    assert.ok(Latitude.safeParse(90).success)
    assert.equal(Latitude.safeParse(-90.5).success, false)
    assert.equal(Latitude.safeParse(Number.NaN).success, false)
    assert.equal(Longitude.safeParse("12.5").success, false, "no coercion on the wire")
  })
})

describe("Position", () => {
  test("is [longitude, latitude] with an optional altitude, in that order", () => {
    assert.deepEqual(Position.parse(cph), cph)
    assert.deepEqual(Position.parse([12.5683, 55.6761, 3]), [12.5683, 55.6761, 3])
    assert.equal(Position.safeParse([55.6761, 12.5683]).success, true, "a swapped pair is still in range")
    assert.equal(Position.safeParse([100, 55.6761]).success, true)
    assert.equal(Position.safeParse([12.5683, 100]).success, false, "latitude beyond 90")
  })

  test("rejects too few or too many elements and non-numbers", () => {
    assert.equal(Position.safeParse([12.5683]).success, false)
    assert.equal(Position.safeParse([12.5683, 55.6761, 3, 4]).success, false)
    assert.equal(Position.safeParse(["12.5683", "55.6761"]).success, false)
    assert.equal(Position.safeParse({ lng: 12.5683, lat: 55.6761 }).success, false)
    assert.equal(Position.safeParse(null).success, false)
  })
})

describe("Point", () => {
  test("is a GeoJSON Point geometry", () => {
    assert.deepEqual(Point.parse({ type: "Point", coordinates: cph }), { type: "Point", coordinates: cph })
    assert.equal(Point.safeParse({ type: "Polygon", coordinates: cph }).success, false)
    assert.equal(Point.safeParse({ type: "Point", coordinates: [cph] }).success, false)
  })
})

describe("LinearRing", () => {
  const square = [
    [12.5, 55.6],
    [12.6, 55.6],
    [12.6, 55.7],
    [12.5, 55.7],
    [12.5, 55.6],
  ]

  test("has at least four positions and closes on its first one", () => {
    assert.ok(LinearRing.safeParse(square).success)
    assert.ok(LinearRing.safeParse([cph, [12.6, 55.6], [12.6, 55.7], cph]).success, "a triangle")
  })

  test("rejects an open ring and a ring too short to enclose anything", () => {
    assert.equal(LinearRing.safeParse(square.slice(0, 4)).success, false, "open")
    assert.equal(LinearRing.safeParse([cph, [12.6, 55.6], cph]).success, false, "three positions")
    assert.equal(LinearRing.safeParse([]).success, false)
  })

  test("rejects a ring whose positions enclose no area", () => {
    assert.equal(LinearRing.safeParse([[0, 0], [0, 0], [0, 0], [0, 0]]).success, false, "one point four times")
    assert.equal(LinearRing.safeParse([[0, 0], [1, 1], [0, 0], [1, 1], [0, 0]]).success, false, "two points")
    assert.ok(LinearRing.safeParse([[0, 0], [1, 1], [0, 0], [2, 2], [0, 0]]).success, "three distinct, degenerate or not")
  })

  test("compares the whole position when checking closure", () => {
    assert.equal(LinearRing.safeParse([[12.5, 55.6, 0], [12.6, 55.6], [12.6, 55.7], [12.5, 55.6]]).success, false)
  })
})

describe("Polygon", () => {
  const outer = [
    [12.5, 55.6],
    [12.6, 55.6],
    [12.6, 55.7],
    [12.5, 55.7],
    [12.5, 55.6],
  ]
  const hole = [
    [12.52, 55.62],
    [12.54, 55.62],
    [12.54, 55.64],
    [12.52, 55.62],
  ]

  test("is a GeoJSON Polygon: an outer ring and any number of holes", () => {
    assert.ok(Polygon.safeParse({ type: "Polygon", coordinates: [outer] }).success)
    assert.ok(Polygon.safeParse({ type: "Polygon", coordinates: [outer, hole] }).success)
  })

  test("needs at least one ring and only closed rings", () => {
    assert.equal(Polygon.safeParse({ type: "Polygon", coordinates: [] }).success, false)
    assert.equal(Polygon.safeParse({ type: "Polygon", coordinates: [outer.slice(0, 4)] }).success, false)
    assert.equal(Polygon.safeParse({ type: "Polygon", coordinates: outer }).success, false, "a bare ring")
    assert.equal(Polygon.safeParse({ type: "Point", coordinates: [outer] }).success, false)
  })
})
