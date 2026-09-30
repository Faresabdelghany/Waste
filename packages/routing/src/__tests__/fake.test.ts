import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Position2D } from "@waste/contracts/geojson"

import { FakeProvider, FAKE_SPEED_METRES_PER_SECOND } from "../fake"
import type { ProviderAnswer } from "../provider"
import { quotaKnobs } from "../quota"
import { providerFromEnv, providerNameFromEnv } from "../select"

const depot: Position2D = [12.5683, 55.6761]
// Around inner Copenhagen; picked so nearest-neighbour from the depot differs from input order.
const stops: Position2D[] = [
  [12.61, 55.71],
  [12.575, 55.68],
  [12.59, 55.695],
]
const station: Position2D = [12.55, 55.72]
const RESET = "2026-10-01T03:00:00.000Z"

/** The result of an answered call; a refusal here is the test's failure, named. */
function answered<T>(answer: ProviderAnswer<T>): T {
  assert.equal(answer.kind, "answered", `expected an answer, got ${JSON.stringify(answer)}`)
  return (answer as Extract<ProviderAnswer<T>, { kind: "answered" }>).result
}

describe("the deterministic fake provider (#169, #131)", () => {
  const fake = new FakeProvider()

  test("measures one straight leg per consecutive pair, endpoints on the inputs, totals the sum of the legs", async () => {
    const { legs } = answered(await fake.measure({ profile: "driving-hgv", points: [depot, ...stops, station, depot] }))
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

  test("refuses a directions request over its fifty waypoints the way the provider does: a final refusal with a sentence", async () => {
    const points = Array.from({ length: 51 }, (_, index): Position2D => [12.5 + index / 1000, 55.7])
    const answer = await new FakeProvider().measure({ profile: "driving-hgv", points })
    assert.equal(answer.kind, "refused")
    assert.match(answer.kind === "refused" ? answer.sentence : "", /51 waypoints.*50/)
  })

  test("optimises by nearest-neighbour from the depot: an order visibly unlike the input's, deterministic", async () => {
    const result = answered(await fake.optimise({ profile: "driving-hgv", depot, stops, station }))
    // From the depot: stop 1 (12.575, 55.68) is nearest, then 2, then 0.
    assert.deepEqual(result.order, [1, 2, 0])
    // depot → three stops → station → depot: five legs.
    assert.equal(result.legs.length, 5)
    assert.deepEqual(result.legs[0].geometry.coordinates[0], depot)
    assert.deepEqual(result.legs[0].geometry.coordinates.at(-1), stops[1])
    assert.deepEqual(result.legs.at(-1)?.geometry.coordinates, [station, depot])
    const again = answered(await fake.optimise({ profile: "driving-hgv", depot, stops, station }))
    assert.deepEqual(result, again)
  })

  test("without a station, the trip closes from the last stop to the depot", async () => {
    const result = answered(await fake.optimise({ profile: "driving-hgv", depot, stops }))
    assert.equal(result.legs.length, 4)
    assert.deepEqual(result.legs.at(-1)?.geometry.coordinates, [stops[0], depot])
  })

  test("two stops at one address are one point of the trip: both ordered, no zero-length leg between them", async () => {
    const result = answered(await fake.optimise({ profile: "driving-hgv", depot, stops: [stops[1], stops[1], stops[0]] }))
    assert.deepEqual(result.order, [0, 1, 2])
    // depot → the shared address → stop 0 → depot: three legs, not four.
    assert.equal(result.legs.length, 3)
    for (const leg of result.legs) assert.notDeepEqual(leg.geometry.coordinates[0], leg.geometry.coordinates[1])
  })

  test("carries its provenance: the response-side facts #132 keeps off the fingerprint", async () => {
    const { provenance } = answered(await fake.measure({ profile: "driving-hgv", points: [depot, station] }))
    assert.deepEqual(provenance, { engineVersion: "fake", graphDate: null })
  })
})

describe("the fake's scripted quota states (#132 §7)", () => {
  const request = { profile: "driving-hgv", points: [depot, station] }

  test("reports no limit by default: every answer's reading is null throughout", async () => {
    const answer = await new FakeProvider().measure(request)
    assert.deepEqual(answer.kind === "answered" && answer.quota, { remaining: null, limit: null, resetAt: null })
  })

  test("a scripted reading counts down by one per answered call, per family, and never below zero", async () => {
    const fake = new FakeProvider({ quota: { directions: { remaining: 2, limit: 2000, resetAt: RESET } } })
    const readings = []
    for (let call = 0; call < 3; call += 1) {
      const answer = await fake.measure(request)
      readings.push(answer.kind === "answered" ? answer.quota.remaining : answer.kind)
    }
    assert.deepEqual(readings, [1, 0, 0])
    const optimised = await fake.optimise({ profile: "driving-hgv", depot, stops })
    assert.deepEqual(optimised.kind === "answered" && optimised.quota, { remaining: null, limit: null, resetAt: null })
  })

  test("scripted responses come one per call, in order, and then it answers as unscripted again", async () => {
    const fake = new FakeProvider({ responses: { directions: [{ status: 429, retryAfterSeconds: 7 }, { status: 429 }] } })
    const first = await fake.measure(request)
    const second = await fake.measure(request)
    const third = await fake.measure(request)
    assert.deepEqual([first.kind, second.kind, third.kind], ["rate-limited", "rate-limited", "answered"])
    assert.equal(first.kind === "rate-limited" && first.retryAfterSeconds, 7)
    assert.equal(second.kind === "rate-limited" && second.retryAfterSeconds, null)
  })

  test("a quota 403 reads the family exhausted: nothing remaining, until the scripted reset", async () => {
    const fake = new FakeProvider({ quota: { optimisation: { remaining: 40, limit: 500, resetAt: RESET } }, responses: { optimisation: [{ status: 403, quota: true }] } })
    const answer = await fake.optimise({ profile: "driving-hgv", depot, stops })
    assert.deepEqual(answer, { kind: "quota-exhausted", quota: { remaining: 0, limit: 500, resetAt: RESET } })
  })

  test("a scripted answer carries a reading of its own and keeps counting from it: the window after a reset", async () => {
    const next = "2026-10-02T03:00:00.000Z"
    const fake = new FakeProvider({
      quota: { directions: { remaining: 0, limit: 2000, resetAt: RESET } },
      responses: { directions: [{ status: 200, quota: { remaining: 2000, limit: 2000, resetAt: next } }] },
    })
    const probe = await fake.measure(request)
    const after = await fake.measure(request)
    assert.deepEqual(probe.kind === "answered" && probe.quota, { remaining: 1999, limit: 2000, resetAt: next })
    assert.deepEqual(after.kind === "answered" && after.quota, { remaining: 1998, limit: 2000, resetAt: next })
  })

  test("a 403 without rate-limit headers and a 401 are the key refused, and carry no reading", async () => {
    const fake = new FakeProvider({ responses: { directions: [{ status: 403 }, { status: 401 }] } })
    assert.deepEqual(await fake.measure(request), { kind: "key-refused", status: 403 })
    assert.deepEqual(await fake.measure(request), { kind: "key-refused", status: 401 })
  })

  test("a semantic refusal carries the provider's own sentence", async () => {
    const sentence = "Could not find routable point within a radius of 350.0 meters of specified coordinate 1"
    const fake = new FakeProvider({ responses: { directions: [{ status: 404, sentence }] } })
    assert.deepEqual(await fake.measure(request), { kind: "refused", status: 404, sentence, quota: { remaining: null, limit: null, resetAt: null } })
  })

  test("counts every call it was asked, answered or refused, per family, so a test can prove none was made", async () => {
    const fake = new FakeProvider({ responses: { directions: [{ status: 429 }] } })
    await fake.measure(request)
    await fake.measure(request)
    await fake.optimise({ profile: "driving-hgv", depot, stops })
    assert.deepEqual(fake.calls, { directions: 2, optimisation: 1 })
  })

  test("never mutates the script it was handed", async () => {
    const script = { responses: { directions: [{ status: 429 as const }] } }
    await new FakeProvider(script).measure(request)
    assert.equal(script.responses.directions.length, 1)
  })
})

describe("the provider switch (#131: an environment setting on the API and the worker)", () => {
  test("selects the fake by default and by name", () => {
    assert.equal(providerFromEnv({}).name, "fake")
    assert.equal(providerFromEnv({ ROUTING_PROVIDER: "fake" }).name, "fake")
    assert.equal(providerFromEnv({ ROUTING_PROVIDER: "" }).name, "fake")
  })

  test("refuses a provider it does not know, naming the knob and the two it knows", () => {
    assert.throws(() => providerFromEnv({ ROUTING_PROVIDER: "osrm" }), /ROUTING_PROVIDER=osrm.*"fake".*"openrouteservice"/)
  })

  test("selects OpenRouteService by name, with its key", () => {
    const provider = providerFromEnv({ ROUTING_PROVIDER: "openrouteservice", OPENROUTESERVICE_API_KEY: "test-only-not-a-key" })
    assert.equal(provider.name, "openrouteservice")
    assert.equal(provider.maxWaypoints, 50)
  })

  test("names the provider without its key, for a process that only keys fingerprints and reads rows by it: the API, until it calls", () => {
    assert.equal(providerNameFromEnv({}), "fake")
    assert.equal(providerNameFromEnv({ ROUTING_PROVIDER: "openrouteservice" }), "openrouteservice")
    assert.throws(() => providerNameFromEnv({ ROUTING_PROVIDER: "osrm" }), /ROUTING_PROVIDER=osrm/)
  })

  test("refuses OpenRouteService without its key, naming the variable, so a process never starts to fail every job", () => {
    assert.throws(() => providerFromEnv({ ROUTING_PROVIDER: "openrouteservice" }), /OPENROUTESERVICE_API_KEY/)
    assert.throws(() => providerFromEnv({ ROUTING_PROVIDER: "openrouteservice", OPENROUTESERVICE_API_KEY: " " }), /OPENROUTESERVICE_API_KEY/)
  })
})

describe("the quota knobs (#132 §1: the Pilot's environment, the Standard plan's figures where unset)", () => {
  test("unset knobs are the Standard plan's; a set one replaces its figure alone", () => {
    assert.deepEqual(quotaKnobs({}), { reserves: { directions: 500, optimisation: 100 }, callsPerMinute: 30 })
    assert.deepEqual(quotaKnobs({ directionsReserve: 800, callsPerMinute: 20 }), { reserves: { directions: 800, optimisation: 100 }, callsPerMinute: 20 })
    assert.deepEqual(quotaKnobs({ optimisationReserve: 0 }), { reserves: { directions: 500, optimisation: 0 }, callsPerMinute: 30 })
  })
})
