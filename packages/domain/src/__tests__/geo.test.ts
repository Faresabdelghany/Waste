// Positions and the great circle (geo.ts): one earth radius for every reader.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { distinctConsecutive, EARTH_RADIUS_METRES, haversineMetres, type Position2D, samePosition } from "../geo"

describe("haversineMetres", () => {
  test("is the great circle on the IUGG mean radius", () => {
    assert.equal(EARTH_RADIUS_METRES, 6_371_008.8)
    // A degree of longitude on the equator is the radius times π/180.
    assert.ok(Math.abs(haversineMetres([0, 0], [1, 0]) - (EARTH_RADIUS_METRES * Math.PI) / 180) < 1e-6)
    assert.equal(haversineMetres([12.5683, 55.6761], [12.5683, 55.6761]), 0)
  })

  test("is symmetric, and answers between antipodes where rounding carries the half-chord past one", () => {
    const copenhagen: Position2D = [12.5683, 55.6761]
    const aarhus: Position2D = [10.2039, 56.1629]
    assert.equal(haversineMetres(copenhagen, aarhus), haversineMetres(aarhus, copenhagen))
    assert.ok(Math.abs(haversineMetres(copenhagen, aarhus) - 156_000) < 1_000, "about 156 km as the crow flies")
    assert.ok(Number.isFinite(haversineMetres([0, 0], [180, 0])))
  })
})

describe("positions", () => {
  test("two positions are the same point only when both ordinates are", () => {
    assert.equal(samePosition([1, 2], [1, 2]), true)
    assert.equal(samePosition([1, 2], [2, 1]), false)
  })

  test("consecutive identical points collapse into one, non-consecutive ones do not", () => {
    assert.deepEqual(distinctConsecutive([[1, 1], [1, 1], [2, 2], [1, 1]]), [[1, 1], [2, 2], [1, 1]])
  })
})
