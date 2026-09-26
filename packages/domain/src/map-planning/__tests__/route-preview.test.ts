import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../prototype-record"
import { inBounds } from "../geo"
import { containerLocation, placeLocation } from "../positions"
import { previewsBounds, routePreview } from "../route-preview"
import { TEST_GAZETTEER } from "./gazetteer-fixture"

function record(id: string, facts: Record<string, string>, extra: Partial<BusinessRecord> = {}): BusinessRecord {
  return {
    id,
    name: id.toUpperCase(),
    context: "",
    status: "Available",
    owner: "",
    value: "",
    updated: "",
    description: "",
    facts,
    related: [],
    source: "",
    freshness: "",
    ...extra,
  }
}

const ryesgade = record("bin-1", { Address: "Ryesgade 45, 2200 København N", Property: "Ryesgade 45" })
const jagtvej = record("bin-2", { Address: "Jagtvej 10, 2200 København N", Property: "Jagtvej 10" })
const stored = record("bin-3", { Address: "Warehouse West · aisle C2", Property: "—" }, { status: "In storage" })
const depot = record("depot", { Address: "Sundkrogsgade 21, 2100 København Ø" }, { name: "Nordhavn Depot" })
const station = record(
  "station",
  { Address: "Kraftværksvej 31" },
  { name: "ARC Amager", submittedValues: { latitude: "55.6512", longitude: "12.6180" } },
)
const unplacedDepot = record("depot-2", { Address: "Gammel Køge Landevej 1" }, { name: "Valby Depot" })

describe("placeLocation", () => {
  test("typed coordinates place a depot or a station; an address does so only on a gazetteer street", () => {
    assert.deepEqual(placeLocation(station, TEST_GAZETTEER), { lng: 12.618, lat: 55.6512 })
    const placed = placeLocation(depot, TEST_GAZETTEER)
    assert.ok(placed && inBounds(placed, { west: 12.58, south: 55.7, east: 12.6, north: 55.72 }), JSON.stringify(placed))
  })

  test("a base the gazetteer cannot place is null, never a hashed spot", () => {
    assert.equal(placeLocation(unplacedDepot, TEST_GAZETTEER), null)
    assert.equal(placeLocation(record("nowhere", {}), TEST_GAZETTEER), null)
    // The form's typed address counts when no display fact carries one.
    const typedAddress = record("typed", {}, { submittedValues: { address: "Jagtvej 4, 2200 København N" } })
    assert.deepEqual(placeLocation(typedAddress, TEST_GAZETTEER), placeLocation(record("f", { Address: "Jagtvej 4" }), TEST_GAZETTEER))
  })

  test("garbage coordinates fall back to the address", () => {
    const garbage = record("g", { Address: "Ryesgade 3, 2200 København N" }, { submittedValues: { latitude: "north", longitude: "12" } })
    assert.deepEqual(placeLocation(garbage, TEST_GAZETTEER), placeLocation(record("h", { Address: "Ryesgade 3, 2200 København N" }), TEST_GAZETTEER))
  })
})

describe("routePreview", () => {
  const containers = [ryesgade, jagtvej, stored]

  test("depot first, the located containers in the given order, station last", () => {
    const preview = routePreview({ containerIds: ["bin-2", "bin-1"], containers, depot, station, gazetteer: TEST_GAZETTEER })
    assert.deepEqual(
      preview.stops.map((stop) => [stop.kind, stop.containerId, stop.label]),
      [
        ["depot", null, "Nordhavn Depot"],
        ["container", "bin-2", "BIN-2"],
        ["container", "bin-1", "BIN-1"],
        ["station", null, "ARC Amager"],
      ],
    )
    assert.deepEqual(preview.stops[1].lngLat, containerLocation(jagtvej, TEST_GAZETTEER))
    assert.equal(preview.fromDepot, true)
    assert.equal(preview.toStation, true)
    assert.equal(preview.unplaced, 0)
    assert.ok(preview.bounds)
    for (const stop of preview.stops) assert.ok(inBounds(stop.lngLat, preview.bounds))
  })

  test("a container the registry cannot place, or does not hold, is counted and left off the line", () => {
    const preview = routePreview({
      containerIds: ["bin-1", "bin-3", "bin-gone"],
      containers,
      depot: null,
      station: undefined,
      gazetteer: TEST_GAZETTEER,
    })
    assert.deepEqual(preview.stops.map((stop) => stop.containerId), ["bin-1"])
    assert.equal(preview.unplaced, 2)
    assert.equal(preview.fromDepot, false)
    assert.equal(preview.toStation, false)
  })

  test("a named base the gazetteer cannot place is left off and reported, not hashed onto the map", () => {
    const preview = routePreview({ containerIds: ["bin-1"], containers, depot: unplacedDepot, station, gazetteer: TEST_GAZETTEER })
    assert.deepEqual(preview.stops.map((stop) => stop.kind), ["container", "station"])
    assert.equal(preview.fromDepot, false)
    assert.equal(preview.toStation, true)
  })

  test("no drawable stop means no bounds", () => {
    const preview = routePreview({ containerIds: ["bin-3"], containers, depot: null, station: null, gazetteer: TEST_GAZETTEER })
    assert.deepEqual(preview.stops, [])
    assert.equal(preview.bounds, null)
    assert.equal(previewsBounds([preview]), null)
  })

  test("previewsBounds frames every route of the day together", () => {
    const a = routePreview({ containerIds: ["bin-1"], containers, depot: null, station: null, gazetteer: TEST_GAZETTEER })
    const b = routePreview({ containerIds: ["bin-2"], containers, depot: null, station: station, gazetteer: TEST_GAZETTEER })
    const bounds = previewsBounds([a, b])
    assert.ok(bounds)
    for (const stop of [...a.stops, ...b.stops]) assert.ok(inBounds(stop.lngLat, bounds))
    assert.ok(bounds.east - bounds.west > 0.01, "the station in the south-east widens the frame")
  })
})
