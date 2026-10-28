import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { OPTIMISER_MAX_PARTS, partsNeeded, sweepParts, type PartPosition } from "../parts"

const depot: PartPosition = [12.57, 55.68]
/** A stop `metres` from the depot at a bearing of `degrees`, counter-clockwise from east, roughly. */
const at = (degrees: number, metres = 1_000): PartPosition => {
  const radians = (degrees * Math.PI) / 180
  return [depot[0] + (Math.cos(radians) * metres) / (111_320 * Math.cos((depot[1] * Math.PI) / 180)), depot[1] + (Math.sin(radians) * metres) / 111_320]
}

describe("routes above one optimisation's size, in parts (O15 of #290)", () => {
  test("as few requests as hold the stops, at most ten", () => {
    assert.deepEqual([partsNeeded(0, 49), partsNeeded(49, 49), partsNeeded(50, 49), partsNeeded(490, 49)], [1, 1, 2, 10])
    assert.equal(OPTIMISER_MAX_PARTS, 10)
  })

  test("stops that fit one request are one part, in the order given", () => {
    assert.deepEqual(sweepParts(depot, [at(10), at(200), at(90)], 49), [[0, 1, 2]])
  })

  test("swept by bearing from the depot and cut as evenly as the count allows, every stop in one part", () => {
    const stops = Array.from({ length: 101 }, (_, index) => at((index * 137) % 360, 500 + index * 10))
    const parts = sweepParts(depot, stops, 50)
    assert.deepEqual(
      parts.map((part) => part.length),
      [34, 34, 33],
    )
    assert.deepEqual(
      parts.flat().sort((a, b) => a - b),
      stops.map((_, index) => index),
    )
  })

  test("each part is a sector: no part's bearings interleave another's", () => {
    const stops = [at(5), at(95), at(185), at(275), at(15), at(105), at(195), at(285)]
    const parts = sweepParts(depot, stops, 2)
    assert.equal(parts.length, 4)
    for (const part of parts) assert.equal(new Set(part.map((index) => Math.floor(((index % 4) * 90 + 5) / 90))).size, 1, `part ${part.join(",")} spans one quadrant`)
  })

  test("starts after the widest gap around the depot, so the two ends of the area are not one part", () => {
    // Stops between 300° and 60° only: the sweep starts at 300°, never across the empty south.
    const stops = [at(30), at(330), at(0), at(60), at(300), at(15)]
    assert.deepEqual(sweepParts(depot, stops, 3), [
      [4, 1, 2],
      [5, 0, 3],
    ])
  })

  test("is the same for the same stops, ties to the stop listed first", () => {
    const stops = [at(45), at(45, 2_000), at(225), at(225, 2_000)]
    assert.deepEqual(sweepParts(depot, stops, 2), sweepParts(depot, stops, 2))
    assert.deepEqual(sweepParts(depot, [at(45), at(45)], 1), [[0], [1]])
  })
})
