import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  SCHEME_SERVICE_TYPES,
  allowedContainerTypes,
  containerTypesOutsideServiceType,
  isSchemeServiceType,
} from "../scope"

describe("service type → allowed container types", () => {
  test("the three service types", () => {
    assert.deepEqual(SCHEME_SERVICE_TYPES, [
      "Container collection",
      "Underground collection",
      "Kerbside collection",
    ])
    assert.equal(isSchemeServiceType("Kerbside collection"), true)
    // Round 2's five values mapped to nothing; a stored "Collection" is unset.
    assert.equal(isSchemeServiceType("Collection"), false)
  })

  test("each service type allows its container types; no service type restricts nothing", () => {
    assert.deepEqual(allowedContainerTypes("Container collection"), [
      "Two-wheel bin · 240 L",
      "Four-wheel bin · 660 L",
      "Four-wheel bin · 1,100 L",
    ])
    assert.deepEqual(allowedContainerTypes("Underground collection"), ["Underground · 5,000 L"])
    assert.deepEqual(allowedContainerTypes("Kerbside collection"), [
      "Two-wheel bin · 140 L",
      "Two-wheel bin · 240 L",
    ])
    assert.equal(allowedContainerTypes(""), null)
    assert.equal(allowedContainerTypes("Collection"), null)
  })

  test("the container types of a group that fall outside the scheme's service type", () => {
    assert.deepEqual(
      containerTypesOutsideServiceType(
        ["Two-wheel bin · 240 L", "Four-wheel bin · 660 L"],
        "Kerbside collection",
      ),
      ["Four-wheel bin · 660 L"],
    )
    assert.deepEqual(
      containerTypesOutsideServiceType(["Four-wheel bin · 660 L"], "Container collection"),
      [],
    )
    assert.deepEqual(containerTypesOutsideServiceType(["Igloo · 2,500 L"], ""), [])
  })
})
