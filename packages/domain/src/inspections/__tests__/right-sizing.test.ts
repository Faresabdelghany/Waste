// Right-sizing's rule (M23 of #293): the latest estimates read, overflow
// before the median, the next size the catalogue sells, and the frequency
// where it sells none.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { changesTheProduct, directionOf, fillReadingOf, nextSize, RIGHT_SIZING_WINDOW } from "../right-sizing"

describe("fillReadingOf", () => {
  test("says nothing on fewer than four estimates", () => {
    assert.deepEqual(fillReadingOf(["empty", "empty", "quarter"]), { need: "none", counted: 3 })
  })

  test("a median at half full or below is too big; above it, nothing to change", () => {
    assert.deepEqual(fillReadingOf(["quarter", "half", "quarter", "three-quarters"]), { need: "smaller", medianShare: 37.5, overflowing: 0, counted: 4 })
    assert.deepEqual(fillReadingOf(["full", "three-quarters", "half", "full"]), { need: "none", counted: 4 })
  })

  test("overflowing twice among the latest four is too small, whatever the quieter weeks say", () => {
    assert.equal(fillReadingOf(["overflowing", "empty", "overflowing", "empty", "empty", "empty"]).need, "bigger")
    assert.equal(fillReadingOf(["empty", "empty", "empty", "empty", "overflowing", "overflowing"]).need, "smaller", "an old overflow is past the four")
  })

  test("reads no more than the window", () => {
    const old = Array.from({ length: 10 }, () => "overflowing" as const)
    assert.equal(fillReadingOf(["half", "half", "half", "half", "half", "half", ...old]).counted, RIGHT_SIZING_WINDOW)
  })
})

describe("nextSize and the direction", () => {
  const sold = [
    { id: "b", volumeLitres: 140 },
    { id: "a", volumeLitres: 140 },
    { id: "c", volumeLitres: 370 },
    { id: "d", volumeLitres: 660 },
  ]
  test("is the nearest volume in the direction, the lowest id among equals", () => {
    assert.equal(nextSize(240, sold, "smaller")?.id, "a")
    assert.equal(nextSize(240, sold, "bigger")?.id, "c")
    assert.equal(nextSize(140, sold, "smaller"), undefined)
  })

  test("a size where one is sold, else the frequency; only a size changes the product", () => {
    assert.deepEqual([directionOf("smaller", true), directionOf("smaller", false), directionOf("bigger", true), directionOf("bigger", false)], ["smaller", "less-frequent", "bigger", "more-frequent"])
    assert.deepEqual(["smaller", "bigger", "less-frequent", "more-frequent"].map((direction) => changesTheProduct(direction as never)), [true, true, false, false])
  })
})
