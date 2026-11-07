import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { inBounds, type LngLat } from "@waste/domain/map-planning/geo"
import { FIXTURE_GAZETTEER } from "../gazetteer"
import { COPENHAGEN_BOUNDS, COPENHAGEN_CENTER, addressLocation, knownAddressLocation } from "../positions"

/** Great-circle distance in metres, enough for a sanity bound. */
function metres(a: LngLat, b: LngLat): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.sqrt(h))
}

describe("addressLocation", () => {
  test("a fixture street lands near its anchor and moves with the house number", () => {
    const low = addressLocation("Ryesgade 3, 2200 København N", FIXTURE_GAZETTEER, "Ryesgade 3")
    const high = addressLocation("Ryesgade 121, 2200 København N", FIXTURE_GAZETTEER, "Ryesgade 121")
    assert.ok(metres(low, high) > 500, "house numbers spread along the street")
    assert.ok(metres(low, high) < 2000, "…but stay on one street")
    assert.ok(metres(low, COPENHAGEN_CENTER) < 6000, "inside the city")
  })

  test("the same address always yields the same spot", () => {
    assert.deepEqual(
      addressLocation("Jagtvej 10, 2200 København N", FIXTURE_GAZETTEER, "Jagtvej 10"),
      addressLocation("Jagtvej 10, 2200 København N", FIXTURE_GAZETTEER, "Jagtvej 10"),
    )
  })

  test("odd and even numbers sit on opposite sides of the street", () => {
    const odd = addressLocation("Amagerbrogade 11, 2300 København S", FIXTURE_GAZETTEER, "Amagerbrogade 11")
    const even = addressLocation("Amagerbrogade 12, 2300 København S", FIXTURE_GAZETTEER, "Amagerbrogade 12")
    assert.ok(metres(odd, even) > 10)
    assert.ok(metres(odd, even) < 60)
  })

  test("a number-less street keeps its last letter and a house letter still parses", () => {
    // "Harbor Offices, Dock 4" must hit the gazetteer's harbor offices anchor, not the hash.
    const offices = addressLocation("Harbor Offices, Dock 4", FIXTURE_GAZETTEER, "Harbor Offices")
    assert.ok(Math.abs(offices.lng - 12.5975) < 0.01 && Math.abs(offices.lat - 55.7085) < 0.005, JSON.stringify(offices))
    const lettered = addressLocation("Ryesgade 45A, 2200 København N", FIXTURE_GAZETTEER, "Ryesgade 45A")
    const plain = addressLocation("Ryesgade 45, 2200 København N", FIXTURE_GAZETTEER, "Ryesgade 45")
    assert.deepEqual(lettered, plain)
  })

  test("an unknown address is hashed inside the Copenhagen bounds, deterministically", () => {
    const a = addressLocation("Somewhere 1, 9999 Nowhere", FIXTURE_GAZETTEER, "Somewhere 1")
    const b = addressLocation("Somewhere 1, 9999 Nowhere", FIXTURE_GAZETTEER, "Somewhere 1")
    const c = addressLocation("Elsewhere 2, 9999 Nowhere", FIXTURE_GAZETTEER, "Elsewhere 2")
    assert.deepEqual(a, b)
    assert.notDeepEqual(a, c)
    assert.equal(inBounds(a, COPENHAGEN_BOUNDS), true)
    assert.equal(inBounds(c, COPENHAGEN_BOUNDS), true)
  })
})

describe("the gazetteer is the caller's", () => {
  test("a street the given gazetteer does not list is unknown, whatever other gazetteers say", () => {
    const address = "Ryesgade 45, 2200 København N"
    assert.ok(knownAddressLocation(address, FIXTURE_GAZETTEER), "the test gazetteer lists Ryesgade")
    assert.equal(knownAddressLocation(address, {}), null, "an empty gazetteer knows no street")
    assert.equal(
      knownAddressLocation(address, { jagtvej: FIXTURE_GAZETTEER.jagtvej }),
      null,
      "a gazetteer without Ryesgade does not place a Ryesgade address",
    )
  })

  test("a street name that is only an Object.prototype key is unknown, not an anchor", () => {
    assert.equal(knownAddressLocation("Constructor 5, 2100 København Ø", FIXTURE_GAZETTEER), null)
    assert.equal(knownAddressLocation("__proto__ 3, 2100 København Ø", FIXTURE_GAZETTEER), null)
    assert.equal(knownAddressLocation("toString 1", FIXTURE_GAZETTEER), null)
  })

  test("a decomposed (NFD) spelling of an accented street finds the composed key", () => {
    const composed = "Falkoner Allé 12, 2000 Frederiksberg"
    const decomposed = composed.normalize("NFD")
    assert.notEqual(composed, decomposed, "the specimen really is spelled differently")
    assert.deepEqual(knownAddressLocation(decomposed, FIXTURE_GAZETTEER), knownAddressLocation(composed, FIXTURE_GAZETTEER))
    assert.ok(knownAddressLocation(decomposed, FIXTURE_GAZETTEER))
  })

  test("a street the given gazetteer lists is placed at that gazetteer's anchor", () => {
    const elsewhere = { ryesgade: { start: { lng: 10.2, lat: 56.15 }, bearing: 90 } }
    const placed = knownAddressLocation("Ryesgade 1, 8000 Aarhus C", elsewhere)
    assert.ok(placed)
    assert.ok(Math.abs(placed.lng - 10.2) < 0.01 && Math.abs(placed.lat - 56.15) < 0.005, JSON.stringify(placed))
  })
})
