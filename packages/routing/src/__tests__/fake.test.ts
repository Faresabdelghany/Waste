import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Position2D } from "@waste/contracts/geojson"

import { FakeProvider, FAKE_SPEED_METRES_PER_SECOND } from "../fake"
import { providerFromEnv } from "../select"

const depot: Position2D = [12.5683, 55.6761]
// Around inner Copenhagen; picked so nearest-neighbour from the depot differs from input order.
const stops: Position2D[] = [
  [12.61, 55.71],
  [12.575, 55.68],
  [12.59, 55.695],
]
const station: Position2D = [12.55, 55.72]

describe("the deterministic fake provider (#169, #131)", () => {
  const fake = new FakeProvider()

  test("measures one straight leg per consecutive pair, endpoints on the inputs, totals the sum of the legs", async () => {
    const { legs } = await fake.measure({ profile: "driving-hgv", points: [depot, ...stops, station, depot] })
    assert.equal(legs.length, 5)
    for (const [index, leg] of legs.entries()) {
      assert.deepEqual(leg.geometry.type, "LineString")
      assert.deepEqual(leg.geometry.coordinates[0], index === 0 ? depot : legs[index - 1].geometry.coordinates.at(-1))
      assert.ok(Number.isInteger(leg.metres) && leg.metres > 0)
      assert.equal(leg.seconds, Math.round(leg.metres / FAKE_SPEED_METRES_PER_SECOND))
    }
    assert.deepEqual(legs.at(-1)?.geometry.coordinates.at(-1), depot)
  })

  test("measures the same request to the same bytes, twice", async () => {
    const first = await fake.measure({ profile: "driving-hgv", points: [depot, ...stops] })
    const second = await fake.measure({ profile: "driving-hgv", points: [depot, ...stops] })
    assert.deepEqual(first, second)
  })

  test("refuses fewer than two points, which no leg can span", async () => {
    await assert.rejects(fake.measure({ profile: "driving-hgv", points: [depot] }), /at least two points/)
  })

  test("optimises by nearest-neighbour from the depot: an order visibly unlike the input's, deterministic", async () => {
    const result = await fake.optimise({ profile: "driving-hgv", depot, stops, station })
    // From the depot: stop 1 (12.575, 55.68) is nearest, then 2, then 0.
    assert.deepEqual(result.order, [1, 2, 0])
    // depot → three stops → station → depot: five legs.
    assert.equal(result.legs.length, 5)
    assert.deepEqual(result.legs[0].geometry.coordinates[0], depot)
    assert.deepEqual(result.legs[0].geometry.coordinates.at(-1), stops[1])
    assert.deepEqual(result.legs.at(-1)?.geometry.coordinates, [station, depot])
    const again = await fake.optimise({ profile: "driving-hgv", depot, stops, station })
    assert.deepEqual(result, again)
  })

  test("without a station, the trip closes from the last stop to the depot", async () => {
    const result = await fake.optimise({ profile: "driving-hgv", depot, stops })
    assert.equal(result.legs.length, 4)
    assert.deepEqual(result.legs.at(-1)?.geometry.coordinates, [stops[0], depot])
  })

  test("carries its provenance: the response-side facts #132 keeps off the fingerprint", async () => {
    const { provenance } = await fake.measure({ profile: "driving-hgv", points: [depot, station] })
    assert.deepEqual(provenance, { engineVersion: "fake", graphDate: null })
  })

  test("reports no quota limit by default, and a scripted state verbatim (S3's tests drive the rest)", () => {
    assert.deepEqual(fake.quota("directions"), { remaining: null, limit: null, resetAt: null })
    const scripted = new FakeProvider({
      quota: { optimisation: { remaining: 12, limit: 500, resetAt: "2026-09-30T03:00:00Z" } },
    })
    assert.deepEqual(scripted.quota("optimisation"), { remaining: 12, limit: 500, resetAt: "2026-09-30T03:00:00Z" })
    assert.deepEqual(scripted.quota("directions"), { remaining: null, limit: null, resetAt: null })
  })
})

describe("the provider switch (#131: an environment setting on the API and the worker)", () => {
  test("selects the fake by default and by name", () => {
    assert.equal(providerFromEnv({}).name, "fake")
    assert.equal(providerFromEnv({ ROUTING_PROVIDER: "fake" }).name, "fake")
    assert.equal(providerFromEnv({ ROUTING_PROVIDER: "" }).name, "fake")
  })

  test("refuses a provider it does not know, naming the knob", () => {
    assert.throws(() => providerFromEnv({ ROUTING_PROVIDER: "osrm" }), /ROUTING_PROVIDER.*osrm.*fake/)
    // openrouteservice is S3's (#171); until it lands, the name is refused with the same sentence.
    assert.throws(() => providerFromEnv({ ROUTING_PROVIDER: "openrouteservice" }), /ROUTING_PROVIDER/)
  })
})
