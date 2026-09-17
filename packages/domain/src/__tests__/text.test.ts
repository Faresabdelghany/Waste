import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { count } from "../text"

describe("count", () => {
  test("one of a noun stays singular; any other number takes the plural", () => {
    assert.equal(count(1, "route"), "1 route")
    assert.equal(count(0, "route"), "0 routes")
    assert.equal(count(3, "future route"), "3 future routes")
  })

  test("a noun ending in a consonant and y pluralises to -ies", () => {
    assert.equal(count(1, "property"), "1 property")
    assert.equal(count(2, "property"), "2 properties")
  })

  test("a noun ending in a vowel and y keeps the y", () => {
    assert.equal(count(2, "day"), "2 days")
    assert.equal(count(5, "holiday"), "5 holidays")
  })
})
