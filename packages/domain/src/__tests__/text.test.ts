import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { count } from "../text"

describe("count", () => {
  test("one of a noun stays singular; any other number takes the plural", () => {
    assert.equal(count(1, "route"), "1 route")
    assert.equal(count(0, "route"), "0 routes")
    assert.equal(count(3, "future route"), "3 future routes")
    assert.equal(count(2, "day"), "2 days")
  })

  test("the caller spells an irregular plural; the default is a plain s", () => {
    assert.equal(count(1, "property", "properties"), "1 property")
    assert.equal(count(2, "property", "properties"), "2 properties")
    assert.equal(count(3, "box", "boxes"), "3 boxes")
    assert.equal(count(2, "address", "addresses"), "2 addresses")
  })
})
