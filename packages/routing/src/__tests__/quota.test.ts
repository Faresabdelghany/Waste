import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Position2D } from "@waste/contracts/geojson"

import { FakeProvider, type FakeScript } from "../fake"
import { KEY_REFUSED, QuotaEngine, RoutingRetryable, STANDARD_PLAN, type QuotaKnobs, type QuotaState } from "../quota"

const T0 = new Date("2026-10-01T01:00:00.000Z")
const RESET = "2026-10-01T03:00:00.000Z"
const NEXT_RESET = "2026-10-02T03:00:30.000Z"
const depot: Position2D = [12.5683, 55.6761]
const stops: Position2D[] = [
  [12.61, 55.71],
  [12.575, 55.68],
  [12.59, 55.695],
]
const PROFILE = "driving-hgv"

/** `count` distinct points along a parallel, so every consecutive pair is a leg of its own. */
const line = (count: number): Position2D[] => Array.from({ length: count }, (_, index): Position2D => [12.5 + index / 1000, 55.7])

/** An engine over a scripted fake, on a clock the test moves: a sleep advances it and is recorded. The jitter is half a minute. */
function harness(script: FakeScript = {}, knobs: Partial<QuotaKnobs> & { waits?: boolean } = {}) {
  const clock = { now: T0.getTime() }
  const slept: number[] = []
  const lines: { level: "warn" | "error"; line: string }[] = []
  const fake = new FakeProvider(script)
  const engine = new QuotaEngine(fake, {
    ...STANDARD_PLAN,
    ...knobs,
    now: () => new Date(clock.now),
    sleep: async (ms) => {
      slept.push(ms)
      clock.now += ms
    },
    random: () => 0.5,
    warn: (text) => void lines.push({ level: "warn", line: text }),
    error: (text) => void lines.push({ level: "error", line: text }),
  })
  return { engine, fake, slept, lines, advance: (ms: number) => void (clock.now += ms), at: () => new Date(clock.now) }
}

const stored = (state: Partial<QuotaState>): QuotaState => ({ remaining: null, limit: null, resetAt: null, exhaustedAt: null, keyRefusedAt: null, observedAt: T0, ...state })

describe("pacing: thirty calls a minute per family (#132 §1)", () => {
  test("the call past the minute's allowance waits for the oldest to leave the window, and the other family does not wait", async () => {
    const { engine, slept } = harness({}, { callsPerMinute: 3 })
    for (let call = 0; call < 3; call += 1) await engine.measure([depot, stops[0]], { class: "batch" })
    assert.deepEqual(slept, [])
    await engine.measure([depot, stops[0]], { class: "batch" })
    assert.deepEqual(slept, [60_000])
    await engine.optimise({ profile: PROFILE, depot, stops }, { class: "batch" })
    assert.deepEqual(slept, [60_000])
  })

  test("calls spread over more than a minute never wait", async () => {
    const { engine, slept, advance } = harness({}, { callsPerMinute: 3 })
    for (let call = 0; call < 4; call += 1) {
      await engine.measure([depot, stops[0]], { class: "batch" })
      advance(20_000)
    }
    assert.deepEqual(slept, [])
  })

  test("defaults to the Standard plan: reserves of 500 directions and 100 optimisations, 30 calls a minute", () => {
    assert.deepEqual(STANDARD_PLAN, { reserves: { directions: 500, optimisation: 100 }, callsPerMinute: 30 })
  })
})

describe("the reserve, read off the provider before each call (#132 §1)", () => {
  test("batch runs while the family stays at or above its reserve, then defers to the reset without a call; interactive spends on", async () => {
    const { engine, fake } = harness({ quota: { directions: { remaining: 501, limit: 2000, resetAt: RESET } } })
    assert.equal((await engine.measure([depot, stops[0]], { class: "batch" })).kind, "answered")
    assert.deepEqual(await engine.measure([depot, stops[0]], { class: "batch" }), { kind: "deferred", family: "directions", cause: "reserve", until: new Date("2026-10-01T03:00:30.000Z") })
    assert.equal(fake.calls.directions, 1)
    assert.equal((await engine.measure([depot, stops[0]], { class: "interactive" })).kind, "answered")
    assert.equal(fake.calls.directions, 2)
  })

  test("interactive spends down to zero and defers only when nothing remains", async () => {
    const { engine, fake } = harness({ quota: { directions: { remaining: 1, limit: 2000, resetAt: RESET } } })
    assert.equal((await engine.measure([depot, stops[0]], { class: "interactive" })).kind, "answered")
    assert.deepEqual(await engine.measure([depot, stops[0]], { class: "interactive" }), { kind: "deferred", family: "directions", cause: "exhausted", until: new Date("2026-10-01T03:00:30.000Z") })
    assert.equal(fake.calls.directions, 1)
  })

  test("the reserve is the family's own: optimisation stops batch at a hundred", async () => {
    const { engine } = harness({ quota: { optimisation: { remaining: 101, limit: 500, resetAt: RESET } } })
    assert.equal((await engine.optimise({ profile: PROFILE, depot, stops }, { class: "batch" })).kind, "answered")
    assert.deepEqual(await engine.optimise({ profile: PROFILE, depot, stops }, { class: "batch" }), { kind: "deferred", family: "optimisation", cause: "reserve", until: new Date("2026-10-01T03:00:30.000Z") })
  })

  test("a chunked measurement counts every call it needs: a batch that would cross the reserve midway defers before its first", async () => {
    const short = harness()
    short.engine.adopt("directions", stored({ remaining: 502, limit: 2000, resetAt: new Date(RESET) }))
    assert.equal((await short.engine.measure(line(101), { class: "batch" })).kind, "deferred")
    assert.equal(short.fake.calls.directions, 0)
    const enough = harness()
    enough.engine.adopt("directions", stored({ remaining: 503, limit: 2000, resetAt: new Date(RESET) }))
    assert.equal((await enough.engine.measure(line(101), { class: "batch" })).kind, "answered")
    assert.equal(enough.fake.calls.directions, 3)
  })

  test("an interactive job that would run out midway defers too, rather than spend into a refusal — told apart from a family exhausted", async () => {
    const { engine, fake } = harness()
    engine.adopt("directions", stored({ remaining: 2, limit: 2000, resetAt: new Date(RESET) }))
    assert.deepEqual(await engine.measure(line(101), { class: "interactive" }), { kind: "deferred", family: "directions", cause: "insufficient", until: new Date("2026-10-01T03:00:30.000Z") })
    assert.equal(fake.calls.directions, 0)
  })

  test("a reset more than a day away names no daily window: a deferral waits an hour and then asks, never for years", async () => {
    const { engine } = harness()
    engine.adopt("directions", stored({ remaining: 400, limit: 2000, resetAt: new Date("2081-01-01T00:00:00.000Z") }))
    assert.deepEqual(await engine.measure([depot, stops[0]], { class: "batch" }), { kind: "deferred", family: "directions", cause: "reserve", until: new Date("2026-10-01T02:00:30.000Z") })
  })

  test("a reading whose reset has passed describes a window that is gone: the call goes ahead", async () => {
    const { engine, fake } = harness()
    engine.adopt("directions", stored({ remaining: 0, limit: 2000, resetAt: new Date(T0.getTime() - 60_000) }))
    assert.equal((await engine.measure([depot, stops[0]], { class: "batch" })).kind, "answered")
    assert.equal(fake.calls.directions, 1)
  })
})

describe("429, the minute: wait inside the adapter and retry once, then fail to pg-boss (#132 §4)", () => {
  test("waits the Retry-After the provider gave, retries once and answers, with a warning line and no error", async () => {
    const { engine, fake, slept, lines } = harness({ responses: { directions: [{ status: 429, retryAfterSeconds: 7 }] } })
    assert.equal((await engine.measure([depot, stops[0]], { class: "batch" })).kind, "answered")
    assert.deepEqual(slept, [7_000])
    assert.equal(fake.calls.directions, 2)
    assert.deepEqual(
      lines.map((entry) => entry.level),
      ["warn"],
    )
  })

  test("without a Retry-After it waits the minute's window out, and a longer one is held to the minute", async () => {
    const bare = harness({ responses: { directions: [{ status: 429 }] } })
    await bare.engine.measure([depot, stops[0]], { class: "batch" })
    assert.deepEqual(bare.slept, [60_000])
    const long = harness({ responses: { directions: [{ status: 429, retryAfterSeconds: 600 }] } })
    await long.engine.measure([depot, stops[0]], { class: "batch" })
    assert.deepEqual(long.slept, [60_000])
  })

  test("a second 429 fails the job to pg-boss's retries, and spends nothing of the day's reading", async () => {
    const { engine, fake } = harness({ quota: { directions: { remaining: 900, limit: 2000, resetAt: RESET } }, responses: { directions: [{ status: 429 }, { status: 429 }] } })
    await assert.rejects(engine.measure([depot, stops[0]], { class: "batch" }), RoutingRetryable)
    assert.equal(fake.calls.directions, 2)
    assert.equal(engine.state("directions").remaining, 900)
  })
})

describe("403, the day: refused and never retried; the job waits for the reset (#132 §4)", () => {
  test("defers to the reset plus the jitter, and marks the family exhausted from now", async () => {
    const { engine } = harness({ quota: { optimisation: { remaining: 3, limit: 500, resetAt: RESET } }, responses: { optimisation: [{ status: 403, quota: true }] } })
    assert.deepEqual(await engine.optimise({ profile: PROFILE, depot, stops }, { class: "interactive" }), {
      kind: "deferred",
      family: "optimisation",
      cause: "exhausted",
      until: new Date("2026-10-01T03:00:30.000Z"),
    })
    assert.deepEqual(engine.state("optimisation"), stored({ remaining: 0, limit: 500, resetAt: new Date(RESET), exhaustedAt: T0 }))
  })

  test("while the family reads exhausted every job of it defers without an attempt, and the other family is untouched", async () => {
    const { engine, fake } = harness({ quota: { optimisation: { remaining: 3, limit: 500, resetAt: RESET } }, responses: { optimisation: [{ status: 403, quota: true }] } })
    await engine.optimise({ profile: PROFILE, depot, stops }, { class: "interactive" })
    assert.equal((await engine.optimise({ profile: PROFILE, depot, stops }, { class: "interactive" })).kind, "deferred")
    assert.equal((await engine.optimise({ profile: PROFILE, depot, stops }, { class: "batch" })).kind, "deferred")
    assert.equal(fake.calls.optimisation, 1)
    assert.equal((await engine.measure([depot, stops[0]], { class: "batch" })).kind, "answered")
  })

  test("the first job after the reset is the probe that re-opens the family", async () => {
    const { engine, fake, advance } = harness({
      quota: { optimisation: { remaining: 3, limit: 500, resetAt: RESET } },
      responses: { optimisation: [{ status: 403, quota: true }, { status: 200, quota: { remaining: 500, limit: 500, resetAt: NEXT_RESET } }] },
    })
    await engine.optimise({ profile: PROFILE, depot, stops }, { class: "batch" })
    advance(2 * 60 * 60 * 1000 + 1_000)
    assert.equal((await engine.optimise({ profile: PROFILE, depot, stops }, { class: "batch" })).kind, "answered")
    const reopened = engine.state("optimisation")
    assert.equal(reopened.exhaustedAt, null)
    assert.equal(reopened.remaining, 499)
    assert.equal((await engine.optimise({ profile: PROFILE, depot, stops }, { class: "batch" })).kind, "answered")
    assert.equal(fake.calls.optimisation, 3)
  })

  test("a quota 403 whose reset has already passed closes the family for an hour after the refusal: every job waits, no second refusal is asked for", async () => {
    const { engine, fake, advance } = harness({ quota: { directions: { remaining: 3, limit: 2000, resetAt: "2026-10-01T00:59:00.000Z" } }, responses: { directions: [{ status: 403, quota: true }] } })
    assert.deepEqual(await engine.measure([depot, stops[0]], { class: "interactive" }), { kind: "deferred", family: "directions", cause: "exhausted", until: new Date("2026-10-01T02:00:30.000Z") })
    advance(30 * 60 * 1000)
    assert.equal((await engine.measure([depot, stops[0]], { class: "interactive" })).kind, "deferred", "half an hour on, still closed")
    assert.equal(fake.calls.directions, 1)
    advance(31 * 60 * 1000)
    assert.equal((await engine.measure([depot, stops[0]], { class: "interactive" })).kind, "answered", "the hour passed: the next job is the probe")
    assert.equal(fake.calls.directions, 2)
  })

  test("a quota 403 that names no reset defers an hour, since the window cannot be read", async () => {
    const { engine } = harness({ quota: { directions: { remaining: 3, limit: 2000, resetAt: null } }, responses: { directions: [{ status: 403, quota: true }] } })
    const outcome = await engine.measure([depot, stops[0]], { class: "interactive" })
    assert.deepEqual(outcome, { kind: "deferred", family: "directions", cause: "exhausted", until: new Date("2026-10-01T02:00:30.000Z") })
  })

  test("a chunked measurement refused midway defers whole: nothing it measured before the refusal is answered", async () => {
    const { engine, fake } = harness({ quota: { directions: { remaining: 900, limit: 2000, resetAt: RESET } }, responses: { directions: [{ status: 200, quota: { remaining: 900, limit: 2000, resetAt: RESET } }, { status: 403, quota: true }] } })
    assert.equal((await engine.measure(line(101), { class: "interactive" })).kind, "deferred")
    assert.equal(fake.calls.directions, 2)
  })
})

describe("the key refused: a 401, or a 403 without rate-limit headers (#132 §4)", () => {
  test("is final, answered with the sentence the office reads, on an error line; the family is marked refused from now", async () => {
    const { engine, lines } = harness({ responses: { directions: [{ status: 401 }] } })
    assert.deepEqual(await engine.measure([depot, stops[0]], { class: "interactive" }), { kind: "key-refused", sentence: KEY_REFUSED })
    assert.equal(engine.state("directions").keyRefusedAt?.toISOString(), T0.toISOString())
    assert.deepEqual(
      lines.map((entry) => entry.level),
      ["error"],
    )
  })

  test("later jobs of the family are refused without a call, while the other family still asks for itself", async () => {
    const { engine, fake } = harness({ responses: { directions: [{ status: 403 }] } })
    await engine.measure([depot, stops[0]], { class: "interactive" })
    assert.equal((await engine.measure([depot, stops[0]], { class: "batch" })).kind, "key-refused")
    assert.equal(fake.calls.directions, 1)
    assert.equal((await engine.optimise({ profile: PROFILE, depot, stops }, { class: "batch" })).kind, "answered")
  })

  test("an hour after the refusal the next job asks again, in case the key was restored; an answer clears the refusal", async () => {
    const { engine, fake, advance } = harness({ responses: { directions: [{ status: 401 }] } })
    await engine.measure([depot, stops[0]], { class: "interactive" })
    advance(59 * 60 * 1000)
    assert.equal((await engine.measure([depot, stops[0]], { class: "batch" })).kind, "key-refused")
    assert.equal(fake.calls.directions, 1)
    advance(2 * 60 * 1000)
    assert.equal((await engine.measure([depot, stops[0]], { class: "batch" })).kind, "answered")
    assert.equal(engine.state("directions").keyRefusedAt, null)
  })

  test("a fresh process asks again: a stored refusal is reported, never obeyed, since the key may have been replaced — and an answer clears it", async () => {
    const { engine, fake } = harness()
    engine.adopt("directions", stored({ keyRefusedAt: new Date(T0.getTime() - 60_000) }))
    assert.equal((await engine.measure([depot, stops[0]], { class: "batch" })).kind, "answered")
    assert.equal(fake.calls.directions, 1)
    assert.equal(engine.state("directions").keyRefusedAt, null)
  })
})

describe("a semantic refusal is final (#132 §4)", () => {
  test("a 400 or 404 answers the provider's own sentence, and the reading it carried is the family's", async () => {
    const sentence = "Could not find routable point within a radius of 350.0 meters of specified coordinate 2"
    const { engine } = harness({ quota: { directions: { remaining: 900, limit: 2000, resetAt: RESET } }, responses: { directions: [{ status: 404, sentence }] } })
    assert.deepEqual(await engine.measure([depot, stops[0]], { class: "batch" }), { kind: "refused", sentence })
    assert.deepEqual(engine.state("directions"), stored({ remaining: 900, limit: 2000, resetAt: new Date(RESET) }))
  })
})

describe("chunked directions above fifty waypoints (#124 §4)", () => {
  test("a 101-point trip is three calls, and its hundred legs join end to start: none duplicated, none missing", async () => {
    const { engine, fake } = harness()
    const points = line(101)
    const outcome = await engine.measure(points, { class: "batch" })
    assert.equal(outcome.kind, "answered")
    const legs = outcome.kind === "answered" ? outcome.result.legs : []
    assert.equal(legs.length, 100)
    for (const [index, leg] of legs.entries()) assert.deepEqual([leg.geometry.coordinates[0], leg.geometry.coordinates.at(-1)], [points[index], points[index + 1]], `leg ${index + 1}`)
    assert.equal(fake.calls.directions, 3)
  })

  test("fewer than two points span no leg and make no call", async () => {
    const { engine, fake } = harness()
    assert.deepEqual(await engine.measure([depot], { class: "batch" }), { kind: "answered", result: { legs: [], provenance: { engineVersion: null, graphDate: null } } })
    assert.equal(fake.calls.directions, 0)
  })
})

describe("the readings the worker stores (#132 §5)", () => {
  test("after an answer the family's state is the provider's reading, when it was learned, and nothing exhausted or refused", async () => {
    const { engine } = harness({ quota: { directions: { remaining: 10, limit: 2000, resetAt: RESET } } })
    await engine.measure([depot, stops[0]], { class: "batch" })
    assert.deepEqual(engine.state("directions"), stored({ remaining: 9, limit: 2000, resetAt: new Date(RESET) }))
    assert.deepEqual(engine.state("optimisation"), stored({ observedAt: null }))
  })

  test("a stored row seeds a family this process has not heard of, and never overrides what it learned itself, whoever's clock stamped the row", async () => {
    const { engine } = harness({ quota: { directions: { remaining: 10, limit: 2000, resetAt: RESET } } })
    engine.adopt("optimisation", stored({ remaining: 60, limit: 500, resetAt: new Date(RESET) }))
    assert.equal(engine.state("optimisation").remaining, 60)
    await engine.measure([depot, stops[0]], { class: "batch" })
    engine.adopt("directions", stored({ remaining: 3, limit: 2000, resetAt: new Date(RESET), observedAt: new Date(T0.getTime() + 60_000) }))
    assert.equal(engine.state("directions").remaining, 9)
  })

  test("carries the provider's name, the one the fingerprint and the rows are kept under", () => {
    assert.equal(harness().engine.name, "fake")
  })
})

describe("refresh: a stored row newer than what the process learned (#173, the API's preview)", () => {
  test("takes a newer row after the process learned the family itself, so the worker's exhaustion defers the next call without a 403 spent to learn it", async () => {
    const { engine, fake, advance } = harness({ quota: { directions: { remaining: 10, limit: 2000, resetAt: RESET } } })
    await engine.measure([depot, stops[0]], { class: "interactive" })
    advance(60_000)
    const exhausted = new Date(T0.getTime() + 30_000)
    engine.refresh("directions", stored({ remaining: 0, limit: 2000, resetAt: new Date(RESET), exhaustedAt: exhausted, observedAt: exhausted }))
    assert.deepEqual(await engine.measure([depot, stops[0]], { class: "interactive" }), { kind: "deferred", family: "directions", cause: "exhausted", until: new Date("2026-10-01T03:00:30.000Z") })
    assert.equal(fake.calls.directions, 1)
  })

  test("leaves a row no newer than what the process learned: its own reading stands", async () => {
    const { engine } = harness({ quota: { directions: { remaining: 10, limit: 2000, resetAt: RESET } } })
    await engine.measure([depot, stops[0]], { class: "interactive" })
    engine.refresh("directions", stored({ remaining: 3, limit: 2000, resetAt: new Date(RESET), observedAt: T0 }))
    engine.refresh("directions", stored({ remaining: 3, limit: 2000, resetAt: new Date(RESET), observedAt: new Date(T0.getTime() - 1) }))
    assert.equal(engine.state("directions").remaining, 9)
  })

  test("seeds a family the process never heard of, as adopt does, and a newer row that clears the exhaustion reopens it", async () => {
    const { engine, fake } = harness()
    engine.refresh("directions", stored({ remaining: 0, limit: 2000, resetAt: new Date(RESET), exhaustedAt: T0 }))
    assert.equal((await engine.measure([depot, stops[0]], { class: "interactive" })).kind, "deferred")
    engine.refresh("directions", stored({ remaining: 2000, limit: 2000, resetAt: new Date(NEXT_RESET), observedAt: new Date(T0.getTime() + 1_000) }))
    assert.equal((await engine.measure([depot, stops[0]], { class: "interactive" })).kind, "answered")
    assert.equal(fake.calls.directions, 1)
  })

  test("a newer row's key refusal is reported, never obeyed: the process's own key is asked", async () => {
    const { engine, fake } = harness()
    engine.refresh("directions", stored({ keyRefusedAt: T0 }))
    assert.equal((await engine.measure([depot, stops[0]], { class: "interactive" })).kind, "answered")
    assert.equal(fake.calls.directions, 1)
  })

  test("a row that says nothing learned is no reading: it is left", () => {
    const { engine } = harness()
    engine.refresh("directions", stored({ remaining: 5, observedAt: null }))
    assert.equal(engine.state("directions").remaining, null)
  })
})

describe("an engine that does not wait: a request a person is looking at (#173, `waits: false`)", () => {
  test("a 429 answers deferred to the minute's window, sleeping nothing and asking no second time", async () => {
    const { engine, fake, slept } = harness({ responses: { directions: [{ status: 429, retryAfterSeconds: 7 }] } }, { waits: false })
    assert.deepEqual(await engine.measure([depot, stops[0]], { class: "interactive" }), { kind: "deferred", family: "directions", cause: "minute", until: new Date(T0.getTime() + 7_000 + 30_000) })
    assert.deepEqual(slept, [])
    assert.equal(fake.calls.directions, 1)
  })

  test("a 429 without a Retry-After, or with a longer one, is the minute: deferred a minute on at most", async () => {
    const bare = harness({ responses: { directions: [{ status: 429 }] } }, { waits: false })
    assert.deepEqual(await bare.engine.measure([depot, stops[0]], { class: "interactive" }), { kind: "deferred", family: "directions", cause: "minute", until: new Date(T0.getTime() + 60_000 + 30_000) })
    const long = harness({ responses: { directions: [{ status: 429, retryAfterSeconds: 600 }] } }, { waits: false })
    assert.deepEqual(await long.engine.measure([depot, stops[0]], { class: "interactive" }), { kind: "deferred", family: "directions", cause: "minute", until: new Date(T0.getTime() + 60_000 + 30_000) })
  })

  test("the minute's allowance spent defers the next request to when its oldest call leaves the window, without a call or a sleep", async () => {
    const { engine, fake, slept } = harness({}, { callsPerMinute: 3, waits: false })
    for (let call = 0; call < 3; call += 1) await engine.measure([depot, stops[0]], { class: "interactive" })
    assert.deepEqual(await engine.measure([depot, stops[0]], { class: "interactive" }), { kind: "deferred", family: "directions", cause: "minute", until: new Date(T0.getTime() + 60_000 + 30_000) })
    assert.equal(fake.calls.directions, 3)
    assert.deepEqual(slept, [])
  })

  test("the minute's calls are taken when a request is admitted: two chunked requests at once cannot both be let in and cut short midway", async () => {
    const { engine, fake } = harness({}, { callsPerMinute: 4, waits: false })
    const [first, second] = await Promise.all([engine.measure(line(101), { class: "interactive" }), engine.measure(line(101), { class: "interactive" })])
    assert.equal(first.kind, "answered")
    assert.deepEqual(second, { kind: "deferred", family: "directions", cause: "minute", until: new Date(T0.getTime() + 60_000 + 30_000) })
    assert.equal(fake.calls.directions, 3, "the first request's three calls, and none of the second's")
  })

  test("a chunked measurement the minute cannot hold whole defers before its first call", async () => {
    const { engine, fake } = harness({}, { callsPerMinute: 3, waits: false })
    await engine.measure([depot, stops[0]], { class: "interactive" })
    assert.equal((await engine.measure(line(101), { class: "interactive" })).kind, "deferred")
    assert.equal(fake.calls.directions, 1)
  })

  test("the day's rules are the same: the reserve, the quota 403 and the key hold as for a job", async () => {
    const { engine } = harness({ quota: { directions: { remaining: 3, limit: 2000, resetAt: RESET } }, responses: { directions: [{ status: 403, quota: true }] } }, { waits: false })
    assert.deepEqual(await engine.measure([depot, stops[0]], { class: "interactive" }), { kind: "deferred", family: "directions", cause: "exhausted", until: new Date("2026-10-01T03:00:30.000Z") })
  })
})
