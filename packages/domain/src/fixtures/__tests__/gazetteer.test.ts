// The fixture gazetteer against the generator beside it: every seeded
// property stands on a street the table anchors, so no generated address
// falls back to a hashed spot on the web's map or to no point in the seed.
// The explicit fixtures' streets are the web's to pin
// (apps/web/lib/data/__tests__/street-gazetteer.test.ts), since only the web
// holds those records.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { knownAddressLocation } from "../../map-planning/positions"
import { FIXTURE_GAZETTEER } from "../gazetteer"
import { SEEDED_PROPERTY_COUNT, seededProperty } from "../seeded-registry"

describe("the fixture gazetteer", () => {
  test("every key is a street as the domain parses one: composed, lower-cased and trimmed", () => {
    for (const key of Object.keys(FIXTURE_GAZETTEER)) {
      assert.equal(key, key.normalize("NFC").toLowerCase().trim(), `${key} is not parsed that way`)
    }
  })

  test("every seeded property's address is placed on its own street", () => {
    const unplaced = Array.from({ length: SEEDED_PROPERTY_COUNT }, (_, index) => seededProperty(index))
      .filter((property) => knownAddressLocation(property.address, FIXTURE_GAZETTEER, property.name) === null)
      .map((property) => property.address)
    assert.deepEqual(unplaced, [])
  })

  test("the anchor of Ryesgade places property-seed-101 where the seed has stored it", () => {
    const at = knownAddressLocation("Ryesgade 3, 2200 København N", FIXTURE_GAZETTEER, "Ryesgade 3")
    assert.ok(at)
    assert.deepEqual([Math.round(at.lng * 1e6) / 1e6, Math.round(at.lat * 1e6) / 1e6], [12.560646, 55.69076])
  })
})
