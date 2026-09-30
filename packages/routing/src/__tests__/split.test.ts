import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Position2D } from "@waste/contracts/geojson"

import { legsBetween, waypointIndices } from "../split"

describe("waypointIndices: where each stop of an optimised route falls on its one polyline (#171)", () => {
  test("waypoints on vertices fall on those vertices, the first and last on the line's ends", () => {
    const line: Position2D[] = [
      [12.5, 55.7],
      [12.501, 55.7],
      [12.502, 55.7],
      [12.503, 55.7],
      [12.504, 55.7],
    ]
    // About 62.8 m per thousandth of a degree of longitude at this latitude.
    const indices = waypointIndices(line, [
      { at: [12.5, 55.7], metres: 0 },
      { at: [12.502, 55.7], metres: 126 },
      { at: [12.504, 55.7], metres: 251 },
    ])
    assert.deepEqual(indices, [0, 2, 4])
  })

  test("a later pass closer to a stop's address than its visit does not take the stop: the route's own distance says where it was", () => {
    // The route visits B on the southern road, 100 m south of B's address, drives on to C, and comes back along a northern
    // road that passes 33 m from B's address. Nearest-vertex alone would put B on the way back and break every leg after it.
    const line: Position2D[] = [
      [12.5, 55.7], // the depot
      [12.505, 55.7], // B as visited
      [12.51, 55.7], // C
      [12.51, 55.7012],
      [12.505, 55.7012], // the northern pass, 33 m from B's address
      [12.5, 55.7012],
      [12.5, 55.7], // home
    ]
    const indices = waypointIndices(line, [
      { at: [12.5, 55.7], metres: 0 },
      { at: [12.505, 55.7009], metres: 314 },
      { at: [12.51, 55.7], metres: 627 },
      { at: [12.5, 55.7], metres: 1521 },
    ])
    assert.deepEqual(indices, [0, 1, 2, 6])
  })

  test("never goes back: a stop whose nearest vertex lies behind the stop before it is placed at that stop, not behind it", () => {
    const line: Position2D[] = [
      [12.5, 55.7],
      [12.501, 55.7],
      [12.502, 55.7],
    ]
    const indices = waypointIndices(line, [
      { at: [12.5, 55.7], metres: 0 },
      { at: [12.501, 55.7], metres: 63 },
      // 6 m from the first vertex, 56 m from the second: the route has already left the first behind.
      { at: [12.5001, 55.7], metres: 63 },
      { at: [12.502, 55.7], metres: 126 },
    ])
    assert.deepEqual(indices, [0, 1, 1, 2])
  })
})

describe("legsBetween: one leg per consecutive pair of waypoints, cut from the routed line", () => {
  const line: Position2D[] = [
    [12.5, 55.7],
    [12.5005, 55.7003],
    [12.501, 55.7],
    [12.502, 55.7],
  ]
  const points: Position2D[] = [
    [12.5, 55.7],
    [12.501, 55.7],
    [12.502, 55.7],
  ]

  test("each leg is the line from its waypoint to the next, both ends included, with the measure it was given", () => {
    assert.deepEqual(
      legsBetween(line, [0, 2, 3], points, [
        { metres: 81, seconds: 9 },
        { metres: 63, seconds: 7 },
      ]),
      [
        {
          geometry: {
            type: "LineString",
            coordinates: [
              [12.5, 55.7],
              [12.5005, 55.7003],
              [12.501, 55.7],
            ],
          },
          metres: 81,
          seconds: 9,
        },
        {
          geometry: {
            type: "LineString",
            coordinates: [
              [12.501, 55.7],
              [12.502, 55.7],
            ],
          },
          metres: 63,
          seconds: 7,
        },
      ],
    )
  })

  test("a leg the router spans with no distance — two points snapped to one — is the straight line between the two waypoints, never a one-point LineString", () => {
    const [leg] = legsBetween(line, [1, 1], [points[0], points[1]], [{ metres: 0, seconds: 0 }])
    assert.deepEqual(leg.geometry.coordinates, [points[0], points[1]])
    assert.equal(leg.metres, 0)
  })

  test("refuses indices and measures that do not match the waypoints", () => {
    assert.throws(() => legsBetween(line, [0, 3], points, [{ metres: 1, seconds: 1 }]), /3 waypoints/)
    assert.throws(() => legsBetween(line, [0, 2, 3], points, [{ metres: 1, seconds: 1 }]), /2 legs/)
  })
})
