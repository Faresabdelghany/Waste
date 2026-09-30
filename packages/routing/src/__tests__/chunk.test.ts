import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Position2D } from "@waste/contracts/geojson"

import { chunkPoints } from "../chunk"

/** `count` distinct points along a parallel, so every consecutive pair is a leg of its own. */
const line = (count: number): Position2D[] => Array.from({ length: count }, (_, index): Position2D => [12 + index / 1000, 55.7])

/** The legs a sequence of points spans: its consecutive pairs, derived from the points alone. */
const pairsOf = (points: readonly Position2D[]): [Position2D, Position2D][] => points.slice(1).map((point, index) => [points[index], point])

describe("chunked directions (#124 §4): consecutive chunks share exactly one waypoint", () => {
  test("fifty points are one chunk, the request unchanged", () => {
    const points = line(50)
    assert.deepEqual(chunkPoints(points, 50), [points])
  })

  test("fifty-one points are two chunks, fifty and two, the second starting where the first ends", () => {
    const points = line(51)
    const chunks = chunkPoints(points, 50)
    assert.deepEqual(
      chunks.map((chunk) => chunk.length),
      [50, 2],
    )
    assert.deepEqual(chunks[0].at(-1), points[49])
    assert.deepEqual(chunks[1], [points[49], points[50]])
  })

  test("a 200-stop full trip, 202 points, is five calls — #118's ceil((W − 1) / 49)", () => {
    assert.deepEqual(
      chunkPoints(line(202), 50).map((chunk) => chunk.length),
      [50, 50, 50, 50, 6],
    )
  })

  test("no leg is duplicated or missing: the chunks' pairs are exactly the points' pairs, in order", () => {
    for (const count of [2, 3, 49, 50, 51, 98, 99, 100, 101, 147, 148, 202]) {
      const points = line(count)
      const chunked = chunkPoints(points, 50).flatMap((chunk) => pairsOf(chunk))
      assert.deepEqual(chunked, pairsOf(points), `${count} points`)
    }
  })

  test("refuses what spans no leg, and a chunk that could not advance", () => {
    assert.throws(() => chunkPoints(line(1), 50), /at least two points/)
    assert.throws(() => chunkPoints(line(5), 1), /at least two waypoints/)
  })
})
