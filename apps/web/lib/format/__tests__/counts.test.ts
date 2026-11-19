import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { MODULES } from "../../modules/manifest"
import { countedOf, pluralOf } from "../counts"

describe("pluralOf", () => {
  test("a noun ending in a consonant and y takes -ies, one ending in a vowel and y takes -s (#653)", () => {
    assert.equal(pluralOf("property"), "properties")
    assert.equal(pluralOf("service provider activity"), "service provider activities")
    assert.equal(pluralOf("Property"), "Properties")
    assert.equal(pluralOf("day"), "days")
    assert.equal(pluralOf("key"), "keys")
  })

  test("a noun ending in s, x, z, ch or sh takes -es", () => {
    assert.equal(pluralOf("address"), "addresses")
    assert.equal(pluralOf("box"), "boxes")
    assert.equal(pluralOf("batch"), "batches")
    assert.equal(pluralOf("dispatch"), "dispatches")
    assert.equal(pluralOf("route"), "routes")
  })

  test("each side of an \"or\" is made plural", () => {
    assert.equal(pluralOf("area or zone"), "areas or zones")
    assert.equal(pluralOf("contact or company"), "contacts or companies")
  })

  test("no module's entity label reads as a naive plural", () => {
    const labels = Object.values(MODULES).map((module) => module.entityLabel.toLowerCase())
    assert.ok(labels.length > 20)
    for (const label of labels) {
      for (const plural of pluralOf(label).split(" or ")) {
        assert.doesNotMatch(plural, /[^aeiou]ys$/, `${label} → ${plural}`)
        assert.doesNotMatch(plural, /(s|x|ch|sh)s$/, `${label} → ${plural}`)
      }
    }
  })
})

describe("countedOf", () => {
  test("one is singular, every other count plural through pluralOf", () => {
    assert.equal(countedOf(1, "property"), "1 property")
    assert.equal(countedOf(0, "property"), "0 properties")
    assert.equal(countedOf(1_204, "pickup"), "1,204 pickups")
  })
})
