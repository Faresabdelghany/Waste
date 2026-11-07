import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../prototype-record"
import { containerLocation } from "../positions"
import { TEST_GAZETTEER } from "./gazetteer-fixture"

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

describe("containerLocation", () => {
  test("containers at one property share one spot; different properties differ", () => {
    const a = containerLocation(container({}, { id: "a" }), TEST_GAZETTEER)
    const b = containerLocation(container({}, { id: "b" }), TEST_GAZETTEER)
    const other = containerLocation(
      container({ Address: "Jagtvej 10, 2200 København N", Property: "Jagtvej 10" }, { id: "c" }), TEST_GAZETTEER)
    assert.ok(a && b && other)
    assert.deepEqual(a, b)
    assert.notDeepEqual(a, other)
  })

  test("out-of-service containers have no place on the map", () => {
    assert.equal(
      containerLocation(
        container({ Address: "Warehouse West · aisle C2", Property: "—" }, { status: "In storage" }), TEST_GAZETTEER),
      null,
    )
    assert.equal(containerLocation(container({}, { status: "In transit" }), TEST_GAZETTEER), null)
    assert.equal(containerLocation(container({}, { status: "Ended" }), TEST_GAZETTEER), null)
    assert.equal(containerLocation(container({ Address: "—", Property: "—" }), TEST_GAZETTEER), null)
  })

  test("typed coordinates win over the address", () => {
    const located = containerLocation(
      container({}, { submittedValues: { latitude: "55.7000", longitude: "12.6000" } }), TEST_GAZETTEER)
    assert.deepEqual(located, { lng: 12.6, lat: 55.7 })
    const garbage = containerLocation(
      container({}, { submittedValues: { latitude: "north", longitude: "12.6" } }), TEST_GAZETTEER)
    assert.ok(garbage && garbage.lat !== 55.7, "unparseable coordinates fall back to the address")
  })
})
