// OpenRouteService behind the adapter (#171), against a recording fetch: no
// test dials the provider, and no credential exists here (#131). The canned
// responses carry every field the provider sends, not just those read.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Position2D } from "@waste/contracts/geojson"

import { OPENROUTESERVICE_HOST, OpenRouteServiceProvider } from "../openrouteservice"
import type { ProviderAnswer } from "../provider"
import { encodePolyline } from "./polyline-encode"

/** Not a key anyone was issued: the shape HeiGIT's keys take (#118), to prove it travels in Authorization and nowhere else. */
const KEY = "eyJvcmciOiJ0ZXN0LW5vdC1hLWtleSJ9.test-only-not-a-key"

type Recorded = { url: string; method: string; headers: Headers; body: unknown }

/** A fetch that records each request and answers the next canned response, or throws the next error. */
function recording(...responses: (Response | Error)[]) {
  const requests: Recorded[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
    const next = responses.shift()
    if (next === undefined) throw new Error("the recording fetch has no more responses")
    if (next instanceof Error) throw next
    return next
  }
  return { fetch: fetch as typeof globalThis.fetch, requests }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json;charset=UTF-8", ...headers } })

/** 2026-10-01T03:00:00Z in Unix seconds, the way `x-ratelimit-reset` spells a reset. */
const RESET_SECONDS = "1790823600"
const RESET = "2026-10-01T03:00:00.000Z"
const QUOTA_HEADERS = { "x-ratelimit-limit": "2000", "x-ratelimit-remaining": "1487", "x-ratelimit-reset": RESET_SECONDS }

const points: Position2D[] = [
  [12.5, 55.7],
  [12.505, 55.7],
  [12.51, 55.7004],
]
const routed: Position2D[] = [
  [12.5, 55.7],
  [12.5003, 55.7002],
  [12.505, 55.7],
  [12.507, 55.7001],
  [12.509, 55.7003],
  [12.51, 55.7004],
]

/** A directions answer as `/v2/directions/{profile}/geojson` gives it with instructions on: a segment per leg, its turn-by-turn steps inside. */
const directionsBody = {
  type: "FeatureCollection",
  bbox: [12.5, 55.7, 12.51, 55.7004],
  features: [
    {
      bbox: [12.5, 55.7, 12.51, 55.7004],
      type: "Feature",
      properties: {
        segments: [
          {
            distance: 1234.5,
            duration: 98.6,
            steps: [
              { distance: 700.1, duration: 55.2, type: 11, instruction: "Head northeast on Østerbrogade", name: "Østerbrogade", way_points: [0, 1] },
              { distance: 534.4, duration: 43.4, type: 10, instruction: "Arrive at Østerbrogade, on the right", name: "-", way_points: [1, 2] },
            ],
          },
          {
            distance: 800.2,
            duration: 70.4,
            steps: [
              { distance: 800.2, duration: 70.4, type: 11, instruction: "Head east on Strandboulevarden", name: "Strandboulevarden", way_points: [2, 5] },
              { distance: 0, duration: 0, type: 10, instruction: "Arrive at Strandboulevarden, on the left", name: "-", way_points: [5, 5] },
            ],
          },
        ],
        way_points: [0, 2, 5],
        summary: { distance: 2034.7, duration: 169 },
      },
      geometry: { coordinates: routed, type: "LineString" },
    },
  ],
  metadata: {
    attribution: "openrouteservice.org | OpenStreetMap contributors",
    service: "routing",
    timestamp: 1790816400000,
    query: { coordinates: points, profile: "driving-hgv", profileName: "driving-hgv", format: "geojson" },
    engine: { version: "9.1.2", build_date: "2026-08-01T10:12:00Z", graph_date: "2026-09-14T08:41:22Z", osm_date: "2026-09-08T00:00:00Z" },
  },
}

const answered = <T>(answer: ProviderAnswer<T>): T => {
  assert.equal(answer.kind, "answered", `expected an answer, got ${JSON.stringify(answer)}`)
  return (answer as Extract<ProviderAnswer<T>, { kind: "answered" }>).result
}

describe("OpenRouteService directions (#171)", () => {
  test("POSTs the points to the directions endpoint for the profile with instructions on — the per-leg segments come only with them — and the key in Authorization and nowhere else", async () => {
    const server = recording(json(200, directionsBody, QUOTA_HEADERS))
    await new OpenRouteServiceProvider({ apiKey: KEY, fetch: server.fetch }).measure({ profile: "driving-hgv", points })
    const [request] = server.requests
    assert.equal(request.url, "https://api.heigit.org/openrouteservice/v2/directions/driving-hgv/geojson")
    assert.equal(request.method, "POST")
    assert.equal(request.headers.get("authorization"), KEY)
    assert.equal(request.headers.get("content-type"), "application/json")
    assert.deepEqual(request.body, { coordinates: points, instructions: true })
    assert.ok(!request.url.includes(KEY) && !JSON.stringify(request.body).includes(KEY))
    assert.equal(OPENROUTESERVICE_HOST, "https://api.heigit.org")
  })

  test("splits the line at its way_points into one leg per pair, metres and seconds rounded from the segments, the provenance from the engine", async () => {
    const server = recording(json(200, directionsBody, QUOTA_HEADERS))
    const result = answered(await new OpenRouteServiceProvider({ apiKey: KEY, fetch: server.fetch }).measure({ profile: "driving-hgv", points }))
    assert.deepEqual(result, {
      legs: [
        { geometry: { type: "LineString", coordinates: routed.slice(0, 3) }, metres: 1235, seconds: 99 },
        { geometry: { type: "LineString", coordinates: routed.slice(2) }, metres: 800, seconds: 70 },
      ],
      provenance: { engineVersion: "9.1.2", graphDate: "2026-09-14" },
    })
  })

  test("reads the family's quota off the headers: remaining, limit and the reset from Unix seconds; none sent is no reading", async () => {
    const server = recording(json(200, directionsBody, QUOTA_HEADERS), json(200, directionsBody))
    const provider = new OpenRouteServiceProvider({ apiKey: KEY, fetch: server.fetch })
    const first = await provider.measure({ profile: "driving-hgv", points })
    assert.deepEqual(first.kind === "answered" && first.quota, { remaining: 1487, limit: 2000, resetAt: RESET })
    const second = await provider.measure({ profile: "driving-hgv", points })
    assert.deepEqual(second.kind === "answered" && second.quota, { remaining: null, limit: null, resetAt: null })
  })

  test("drops elevation where the line carries it: a leg is two-dimensional", async () => {
    const withHeight = structuredClone(directionsBody)
    withHeight.features[0].geometry.coordinates = routed.map(([lon, lat]) => [lon, lat, 11.4]) as unknown as Position2D[]
    const server = recording(json(200, withHeight))
    const result = answered(await new OpenRouteServiceProvider({ apiKey: KEY, fetch: server.fetch }).measure({ profile: "driving-hgv", points }))
    assert.deepEqual(result.legs[0].geometry.coordinates, routed.slice(0, 3))
  })
})

describe("OpenRouteService's refusals, told apart as #132 §4 reads them", () => {
  const measure = (response: Response) => new OpenRouteServiceProvider({ apiKey: KEY, fetch: recording(response).fetch }).measure({ profile: "driving-hgv", points })

  test("429 is the minute's limit, with the Retry-After it named and the reading beside it", async () => {
    assert.deepEqual(await measure(json(429, { error: "Rate limit exceeded" }, { ...QUOTA_HEADERS, "retry-after": "12" })), {
      kind: "rate-limited",
      retryAfterSeconds: 12,
      quota: { remaining: 1487, limit: 2000, resetAt: RESET },
    })
    assert.deepEqual(await measure(json(429, { error: "Rate limit exceeded" })), { kind: "rate-limited", retryAfterSeconds: null, quota: null })
  })

  test("a 403 carrying the rate-limit headers is the day's quota", async () => {
    assert.deepEqual(await measure(json(403, { error: "Quota exceeded" }, { ...QUOTA_HEADERS, "x-ratelimit-remaining": "0" })), {
      kind: "quota-exhausted",
      quota: { remaining: 0, limit: 2000, resetAt: RESET },
    })
  })

  test("a 403 without them, and a 401, are the key refused", async () => {
    assert.deepEqual(await measure(json(403, { error: "Key not authorised" })), { kind: "key-refused", status: 403 })
    assert.deepEqual(await measure(json(401, { error: "Authorization field missing" })), { kind: "key-refused", status: 401 })
  })

  test("a 400 or 404 is final, in the provider's own sentence, whichever shape its error takes", async () => {
    const sentence = "Could not find routable point within a radius of 350.0 meters of specified coordinate 1: 12.5000000 55.7000000."
    assert.deepEqual(await measure(json(404, { error: { code: 2010, message: sentence }, info: { engine: { version: "9.1.2" }, timestamp: 1790816400000 } }, QUOTA_HEADERS)), {
      kind: "refused",
      status: 404,
      sentence,
      quota: { remaining: 1487, limit: 2000, resetAt: RESET },
    })
    assert.deepEqual(await measure(json(400, { code: 2, error: "Invalid profile: driving-hgvx." })), { kind: "refused", status: 400, sentence: "Invalid profile: driving-hgvx.", quota: null })
    assert.deepEqual(await measure(new Response("<html>Bad Request</html>", { status: 400, headers: { "content-type": "text/html" } })), {
      kind: "refused",
      status: 400,
      sentence: "the routing provider refused the request (HTTP 400)",
      quota: null,
    })
  })

  test("a 5xx and a failed connection throw, for pg-boss to retry; neither message carries the key", async () => {
    await assert.rejects(measure(json(502, { error: "Bad gateway" })), (error: Error) => /HTTP 502/.test(error.message) && !error.message.includes(KEY))
    const unreachable = new OpenRouteServiceProvider({ apiKey: KEY, fetch: recording(new TypeError("fetch failed")).fetch })
    await assert.rejects(unreachable.measure({ profile: "driving-hgv", points }), (error: Error) => !error.message.includes(KEY))
  })

  test("a success that does not fit the request is a refusal in so many words, carrying the reading — never a leg invented, never retried to pay for it again", async () => {
    const short = structuredClone(directionsBody)
    short.features[0].properties.way_points = [0, 5]
    const answer = await measure(json(200, short, QUOTA_HEADERS))
    assert.equal(answer.kind, "refused")
    assert.match(answer.kind === "refused" ? answer.sentence : "", /way_points/)
    assert.deepEqual(answer.kind === "refused" && answer.quota, { remaining: 1487, limit: 2000, resetAt: RESET })
  })

  test("a body that is not JSON at all is thrown, a cut connection's to retry", async () => {
    await assert.rejects(measure(new Response("{\"type\":\"FeatureColl", { status: 200, headers: { "content-type": "application/json" } })))
  })

  test("every refusal's body is read or let go, so no pooled connection is left holding one", async () => {
    for (const response of [
      json(429, { error: "Rate limit exceeded" }),
      json(403, { error: "Quota exceeded" }, QUOTA_HEADERS),
      json(403, { error: "Key not authorised" }),
      json(401, { error: "Authorization field missing" }),
    ]) {
      await measure(response)
      assert.equal(response.bodyUsed, true, `HTTP ${response.status}`)
    }
    const failing = json(502, { error: "Bad gateway" })
    await assert.rejects(measure(failing))
    assert.equal(failing.bodyUsed, true, "HTTP 502")
  })
})

describe("OpenRouteService optimisation, VROOM behind /vroom/v0 (#171)", () => {
  const depot: Position2D = [12.5, 55.7]
  const b: Position2D = [12.51, 55.7]
  const a: Position2D = [12.505, 55.7]
  const station: Position2D = [12.52, 55.705]
  const line: Position2D[] = [depot, [12.5025, 55.7], a, b, [12.51, 55.7006], [12.5, 55.7006], depot]

  const step = (type: string, location: Position2D, extra: Record<string, unknown>) => ({ type, location, setup: 0, service: 0, waiting_time: 0, violations: [], ...extra })
  /** VROOM's answer with `g`: the steps with cumulative travel and distance, the whole route as one polyline. */
  const vroomBody = (steps: unknown[], geometry: Position2D[], unassigned: unknown[] = []) => ({
    code: 0,
    summary: { cost: 170, routes: 1, unassigned: unassigned.length, setup: 0, service: 0, duration: 170, waiting_time: 0, priority: 0, distance: 1300, violations: [], computing_times: { loading: 12, solving: 1, routing: 30 } },
    unassigned,
    routes: [{ vehicle: 1, cost: 170, setup: 0, service: 0, duration: 170, waiting_time: 0, priority: 0, distance: 1300, steps, violations: [], geometry: encodePolyline(geometry) }],
  })
  const roundTrip = vroomBody(
    [
      step("start", depot, { arrival: 0, duration: 0, distance: 0 }),
      step("job", a, { id: 2, job: 2, arrival: 40, duration: 40, distance: 320 }),
      step("job", b, { id: 1, job: 1, arrival: 80, duration: 80, distance: 640 }),
      step("end", depot, { arrival: 170, duration: 170, distance: 1300 }),
    ],
    line,
  )

  test("POSTs one vehicle starting and ending at the depot, a job per stop numbered from one, geometry asked for, the key in Authorization", async () => {
    const server = recording(json(200, roundTrip, { ...QUOTA_HEADERS, "x-ratelimit-limit": "500" }))
    await new OpenRouteServiceProvider({ apiKey: KEY, fetch: server.fetch }).optimise({ profile: "driving-hgv", depot, stops: [b, a] })
    const [request] = server.requests
    assert.equal(request.url, "https://api.heigit.org/vroom/v0")
    assert.equal(request.method, "POST")
    assert.equal(request.headers.get("authorization"), KEY)
    assert.deepEqual(request.body, {
      jobs: [
        { id: 1, location: b },
        { id: 2, location: a },
      ],
      vehicles: [{ id: 1, profile: "driving-hgv", start: depot, end: depot }],
      options: { g: true },
    })
  })

  test("answers the solver's order, and the closed trip's legs cut from its polyline at each step, measured by the steps' own travel", async () => {
    const server = recording(json(200, roundTrip, QUOTA_HEADERS))
    const result = answered(await new OpenRouteServiceProvider({ apiKey: KEY, fetch: server.fetch }).optimise({ profile: "driving-hgv", depot, stops: [b, a] }))
    assert.deepEqual(result.order, [1, 0])
    assert.deepEqual(result.legs, [
      { geometry: { type: "LineString", coordinates: line.slice(0, 3) }, metres: 320, seconds: 40 },
      { geometry: { type: "LineString", coordinates: line.slice(2, 4) }, metres: 320, seconds: 40 },
      { geometry: { type: "LineString", coordinates: line.slice(3) }, metres: 660, seconds: 90 },
    ])
    assert.deepEqual(result.provenance, { engineVersion: null, graphDate: null })
  })

  test("holds the station last with a time window no stop can reach, so one request orders the whole trip and spends no directions call", async () => {
    const withStation = vroomBody(
      [
        step("start", depot, { arrival: 0, duration: 0, distance: 0 }),
        step("job", a, { id: 2, job: 2, arrival: 40, duration: 40, distance: 320 }),
        step("job", b, { id: 1, job: 1, arrival: 80, duration: 80, distance: 640 }),
        step("job", station, { id: 3, job: 3, arrival: 604_800, duration: 200, distance: 1400, waiting_time: 604_600 }),
        step("end", depot, { arrival: 604_990, duration: 390, distance: 2900 }),
      ],
      [depot, a, b, station, depot],
    )
    const server = recording(json(200, withStation))
    const result = answered(await new OpenRouteServiceProvider({ apiKey: KEY, fetch: server.fetch }).optimise({ profile: "driving-hgv", depot, stops: [b, a], station }))
    assert.deepEqual(server.requests[0].body, {
      jobs: [
        { id: 1, location: b, time_windows: [[0, 604_799]] },
        { id: 2, location: a, time_windows: [[0, 604_799]] },
        { id: 3, location: station, time_windows: [[604_800, 691_200]] },
      ],
      vehicles: [{ id: 1, profile: "driving-hgv", start: depot, end: depot, time_window: [0, 777_600] }],
      options: { g: true },
    })
    assert.deepEqual(result.order, [1, 0])
    // Seconds are travel: the station's wait for its window is never a leg's.
    assert.deepEqual(
      result.legs.map((leg) => [leg.metres, leg.seconds]),
      [
        [320, 40],
        [320, 40],
        [760, 120],
        [1500, 190],
      ],
    )
  })

  test("two stops at one address are both ordered and one point of the trip: no leg between them", async () => {
    const shared = vroomBody(
      [
        step("start", depot, { arrival: 0, duration: 0, distance: 0 }),
        step("job", a, { id: 1, job: 1, arrival: 40, duration: 40, distance: 320 }),
        step("job", a, { id: 2, job: 2, arrival: 40, duration: 40, distance: 320 }),
        step("end", depot, { arrival: 80, duration: 80, distance: 640 }),
      ],
      [depot, a, depot],
    )
    const server = recording(json(200, shared))
    const result = answered(await new OpenRouteServiceProvider({ apiKey: KEY, fetch: server.fetch }).optimise({ profile: "driving-hgv", depot, stops: [a, a] }))
    assert.deepEqual(result.order, [0, 1])
    assert.equal(result.legs.length, 2)
  })

  test("an answer that leaves a stop unassigned, or visits the station before a stop, is a refusal in so many words, not a Plan", async () => {
    const unassigned = vroomBody(
      [step("start", depot, { arrival: 0, duration: 0, distance: 0 }), step("job", a, { id: 2, job: 2, arrival: 40, duration: 40, distance: 320 }), step("end", depot, { arrival: 80, duration: 80, distance: 640 })],
      [depot, a, depot],
      [{ id: 1, location: b, type: "job" }],
    )
    const left = await new OpenRouteServiceProvider({ apiKey: KEY, fetch: recording(json(200, unassigned)).fetch }).optimise({ profile: "driving-hgv", depot, stops: [b, a] })
    assert.equal(left.kind, "refused")
    assert.match(left.kind === "refused" ? left.sentence : "", /left 1 stop unassigned/)
    const early = vroomBody(
      [
        step("start", depot, { arrival: 0, duration: 0, distance: 0 }),
        step("job", station, { id: 3, job: 3, arrival: 60, duration: 60, distance: 700 }),
        step("job", a, { id: 2, job: 2, arrival: 90, duration: 90, distance: 1000 }),
        step("job", b, { id: 1, job: 1, arrival: 120, duration: 120, distance: 1300 }),
        step("end", depot, { arrival: 200, duration: 200, distance: 2000 }),
      ],
      [depot, station, a, b, depot],
    )
    const misordered = await new OpenRouteServiceProvider({ apiKey: KEY, fetch: recording(json(200, early)).fetch }).optimise({ profile: "driving-hgv", depot, stops: [b, a], station })
    assert.equal(misordered.kind, "refused")
    assert.match(misordered.kind === "refused" ? misordered.sentence : "", /station/)
  })

  test("VROOM's own error is the provider's sentence", async () => {
    const answer = await new OpenRouteServiceProvider({ apiKey: KEY, fetch: recording(json(400, { code: 2, error: "Too many locations (53) in query, maximum is set to 50" })).fetch }).optimise({ profile: "driving-hgv", depot, stops: [b, a] })
    assert.deepEqual(answer, { kind: "refused", status: 400, sentence: "Too many locations (53) in query, maximum is set to 50", quota: null })
  })
})
