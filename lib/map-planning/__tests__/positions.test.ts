import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../data/business-modules"
import {
  COPENHAGEN_BOUNDS,
  COPENHAGEN_CENTER,
  addressLocation,
  containerLocation,
} from "../positions"
import { inBounds, type LngLat } from "../geo"

function container(
  facts: Record<string, string>,
  extra: Partial<BusinessRecord> = {},
): BusinessRecord {
  return {
    id: "c",
    name: "BIN-1",
    context: "",
    status: "Available",
    owner: "",
    value: "",
    updated: "",
    description: "",
    facts: { Address: "Ryesgade 45, 2200 København N", Property: "Ryesgade 45", ...facts },
    related: [],
    source: "",
    freshness: "",
    ...extra,
  }
}

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
    const low = addressLocation("Ryesgade 3, 2200 København N", "Ryesgade 3")
    const high = addressLocation("Ryesgade 121, 2200 København N", "Ryesgade 121")
    assert.ok(metres(low, high) > 500, "house numbers spread along the street")
    assert.ok(metres(low, high) < 2000, "…but stay on one street")
    assert.ok(metres(low, COPENHAGEN_CENTER) < 6000, "inside the city")
  })

  test("the same address always yields the same spot", () => {
    assert.deepEqual(
      addressLocation("Jagtvej 10, 2200 København N", "Jagtvej 10"),
      addressLocation("Jagtvej 10, 2200 København N", "Jagtvej 10"),
    )
  })

  test("odd and even numbers sit on opposite sides of the street", () => {
    const odd = addressLocation("Amagerbrogade 11, 2300 København S", "Amagerbrogade 11")
    const even = addressLocation("Amagerbrogade 12, 2300 København S", "Amagerbrogade 12")
    assert.ok(metres(odd, even) > 10)
    assert.ok(metres(odd, even) < 60)
  })

  test("a number-less street keeps its last letter and a house letter still parses", () => {
    // "Harbor Offices, Dock 4" must hit the gazetteer's harbor offices anchor, not the hash.
    const offices = addressLocation("Harbor Offices, Dock 4", "Harbor Offices")
    assert.ok(Math.abs(offices.lng - 12.5975) < 0.01 && Math.abs(offices.lat - 55.7085) < 0.005, JSON.stringify(offices))
    const lettered = addressLocation("Ryesgade 45A, 2200 København N", "Ryesgade 45A")
    const plain = addressLocation("Ryesgade 45, 2200 København N", "Ryesgade 45")
    assert.deepEqual(lettered, plain)
  })

  test("an unknown address is hashed inside the Copenhagen bounds, deterministically", () => {
    const a = addressLocation("Somewhere 1, 9999 Nowhere", "Somewhere 1")
    const b = addressLocation("Somewhere 1, 9999 Nowhere", "Somewhere 1")
    const c = addressLocation("Elsewhere 2, 9999 Nowhere", "Elsewhere 2")
    assert.deepEqual(a, b)
    assert.notDeepEqual(a, c)
    assert.equal(inBounds(a, COPENHAGEN_BOUNDS), true)
    assert.equal(inBounds(c, COPENHAGEN_BOUNDS), true)
  })
})

describe("containerLocation", () => {
  test("containers at one property share one spot; different properties differ", () => {
    const a = containerLocation(container({}, { id: "a" }))
    const b = containerLocation(container({}, { id: "b" }))
    const other = containerLocation(
      container({ Address: "Jagtvej 10, 2200 København N", Property: "Jagtvej 10" }, { id: "c" }),
    )
    assert.ok(a && b && other)
    assert.deepEqual(a, b)
    assert.notDeepEqual(a, other)
  })

  test("out-of-service containers have no place on the map", () => {
    assert.equal(
      containerLocation(
        container({ Address: "Warehouse West · aisle C2", Property: "—" }, { status: "In storage" }),
      ),
      null,
    )
    assert.equal(containerLocation(container({}, { status: "In transit" })), null)
    assert.equal(containerLocation(container({}, { status: "Ended" })), null)
    assert.equal(containerLocation(container({ Address: "—", Property: "—" })), null)
  })

  test("typed coordinates win over the address", () => {
    const located = containerLocation(
      container({}, { submittedValues: { latitude: "55.7000", longitude: "12.6000" } }),
    )
    assert.deepEqual(located, { lng: 12.6, lat: 55.7 })
    const garbage = containerLocation(
      container({}, { submittedValues: { latitude: "north", longitude: "12.6" } }),
    )
    assert.ok(garbage && garbage.lat !== 55.7, "unparseable coordinates fall back to the address")
  })
})
