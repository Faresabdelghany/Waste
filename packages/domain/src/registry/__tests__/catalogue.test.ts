import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { serviceFrequencyShape } from "../catalogue"

describe("serviceFrequencyShape", () => {
  test("takes on demand, a rate on its own, and a rate with one interval", () => {
    assert.equal(serviceFrequencyShape({ collectionsPerWeek: null, weeksBetween: null, daysBetween: null }), true)
    assert.equal(serviceFrequencyShape({ collectionsPerWeek: 1, weeksBetween: null, daysBetween: null }), true)
    assert.equal(serviceFrequencyShape({ collectionsPerWeek: 1, weeksBetween: 2, daysBetween: null }), true)
    assert.equal(serviceFrequencyShape({ collectionsPerWeek: 3, weeksBetween: null, daysBetween: 2 }), true)
  })

  test("refuses an interval with no rate to belong to, and the two intervals at once", () => {
    assert.equal(serviceFrequencyShape({ collectionsPerWeek: null, weeksBetween: 2, daysBetween: null }), false)
    assert.equal(serviceFrequencyShape({ collectionsPerWeek: null, weeksBetween: null, daysBetween: 2 }), false)
    assert.equal(serviceFrequencyShape({ collectionsPerWeek: 1, weeksBetween: 2, daysBetween: 3 }), false)
  })

  test("says nothing about a rate it was not given, which is what a patch that leaves it alone gives", () => {
    assert.equal(serviceFrequencyShape({ weeksBetween: 2 }), true)
    assert.equal(serviceFrequencyShape({ daysBetween: 2 }), true)
    assert.equal(serviceFrequencyShape({ weeksBetween: 2, daysBetween: 3 }), false)
  })
})
