// The order a route's stops are driven in: the active Plan's sequence where a
// stop has one, the generated position otherwise.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { stopNumber, stopsInOrder } from "../routes"

describe("a route's stops", () => {
  test("are numbered by their sequence where they have one, else by their position", () => {
    assert.equal(stopNumber({ position: 4, sequence: 2 }), 2)
    assert.equal(stopNumber({ position: 4 }), 4)
    assert.equal(stopNumber({ position: 4, sequence: null }), 4)
  })

  test("are driven in that order, a tie broken by position", () => {
    const stops = [
      { id: "c", position: 3, sequence: 1 },
      { id: "a", position: 1 },
      { id: "b", position: 2, sequence: 1 },
    ]
    assert.deepEqual(stopsInOrder(stops).map((stop) => stop.id), ["a", "b", "c"])
  })
})
