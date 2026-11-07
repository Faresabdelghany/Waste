// The place a body names (served-places.ts): a property and a shared
// collection point are counted, a null or absent id naming neither, so each
// context can say how many it takes.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { placesNamed } from "../served-places"

const PROPERTY = "01a0d3a5-e5e0-7000-8000-000000000001"
const POINT = "01a0d3a5-e5e0-7000-8000-000000000002"

describe("placesNamed", () => {
  test("counts the ids given, a null as none, as a form with both fields sends it", () => {
    assert.equal(placesNamed({}), 0)
    assert.equal(placesNamed({ propertyId: null, sharedCollectionPointId: null }), 0)
    assert.equal(placesNamed({ propertyId: PROPERTY, sharedCollectionPointId: null }), 1)
    assert.equal(placesNamed({ sharedCollectionPointId: POINT }), 1)
    assert.equal(placesNamed({ propertyId: PROPERTY, sharedCollectionPointId: POINT }), 2)
  })
})
