// The road cache's rules without React (Issue #39): one request per stop
// sequence however many consumers hold it, a few on their way at once, the
// abandon deferred a tick so a release-and-hold in one tick (React's
// development double-mount) aborts nothing, and what each outcome leaves
// behind — a road landed is remembered, an estimate until the quota resumes,
// a refusal for the session, an abort as nothing (#173). The fetcher, the
// tick and the clock are the test's own.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { LngLat } from "@waste/domain/map-planning/geo"

import { createRoadGeometryCache, ESTIMATE_RECHECK_MS, ROAD_MEMORY_MAX, type Defer, type RoadAnswer } from "../road-geometry-cache"
import type { RoadGeometry } from "../road-geometry"

type Call = {
  stops: readonly LngLat[]
  signal: AbortSignal
  /** Answers the road. */
  resolve: (geometry: RoadGeometry) => void
  /** Answers the API's estimate: no road for now. */
  estimate: (resumesAt: string | null, reason: string) => void
  reject: (reason?: unknown) => void
}

/** A fetcher that answers only when the test says so, and remembers every signal it was handed. */
function fakeFetcher() {
  const calls: Call[] = []
  const fetchRoad = (stops: readonly LngLat[], signal: AbortSignal) =>
    new Promise<RoadAnswer>((resolve, reject) => {
      calls.push({ stops, signal, resolve: (geometry) => resolve({ kind: "road", geometry }), estimate: (resumesAt, reason) => resolve({ kind: "estimate", resumesAt, reason }), reject })
      signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")))
    })
  return { calls, fetchRoad }
}

/** A tick the test turns by hand — the deferred abandon runs on `flush()`. */
function manualTick() {
  let pending: Array<(() => void) | null> = []
  const defer: Defer = (task) => {
    const at = pending.push(task) - 1
    return () => {
      pending[at] = null
    }
  }
  const flush = () => {
    const tasks = pending
    pending = []
    for (const task of tasks) task?.()
  }
  return { defer, flush, size: () => pending.filter(Boolean).length }
}

const road = (metres: number): RoadGeometry => ({
  legs: [[{ lng: 12.5, lat: 55.6 }, { lng: 12.6, lat: 55.7 }]],
  snappedStops: [{ lng: 12.5, lat: 55.6 }, { lng: 12.6, lat: 55.7 }],
  distanceMetres: metres,
  durationSeconds: metres / 10,
  source: { provider: "fake", optimised: false },
})

const stopsOf = (n: number): LngLat[] => [{ lng: 12.5 + n, lat: 55.6 }, { lng: 12.6 + n, lat: 55.7 }]

const wanted = (...keys: string[]) => new Map(keys.map((key, index) => [key, stopsOf(index)]))

/** Lets the fetcher's promise handlers run. */
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("createRoadGeometryCache", () => {
  test("starts at most maxInFlight requests and queues the rest, oldest first", async () => {
    const { calls, fetchRoad } = fakeFetcher()
    const cache = createRoadGeometryCache({ fetchRoad, maxInFlight: 2, defer: manualTick().defer })
    cache.hold(wanted("a", "b", "c", "d"), () => {})
    assert.deepEqual(cache.inFlight(), ["a", "b"])
    assert.deepEqual(cache.queued(), ["c", "d"])
    assert.equal(calls.length, 2)

    calls[0].resolve(road(100))
    await settled()
    assert.deepEqual(cache.inFlight(), ["b", "c"])
    assert.deepEqual(cache.queued(), ["d"])
    assert.deepEqual(cache.stateOf("a"), { status: "ready", geometry: road(100) })
    assert.deepEqual(cache.stateOf("c"), { status: "pending" })
  })

  test("two consumers of one stop sequence share one request; the last release aborts it, and only after the tick", async () => {
    const { calls, fetchRoad } = fakeFetcher()
    const tick = manualTick()
    const cache = createRoadGeometryCache({ fetchRoad, defer: tick.defer })
    const releaseFirst = cache.hold(wanted("a"), () => {})
    const releaseSecond = cache.hold(wanted("a"), () => {})
    assert.equal(calls.length, 1, "one fetch for the key")

    releaseFirst()
    tick.flush()
    await settled()
    assert.equal(calls[0].signal.aborted, false, "a consumer still holds it")
    assert.deepEqual(cache.inFlight(), ["a"])

    releaseSecond()
    assert.equal(calls[0].signal.aborted, false, "the abort waits for the tick")
    tick.flush()
    await settled()
    assert.equal(calls[0].signal.aborted, true)
    assert.deepEqual(cache.inFlight(), [])
    assert.deepEqual(cache.stateOf("a"), { status: "pending" }, "an abort is remembered as nothing")
  })

  test("release and hold in the same tick — React's development double-mount — aborts nothing and starts nothing new", async () => {
    const { calls, fetchRoad } = fakeFetcher()
    const tick = manualTick()
    const cache = createRoadGeometryCache({ fetchRoad, defer: tick.defer })
    let told = 0
    const release = cache.hold(wanted("a"), () => {})
    release()
    cache.hold(wanted("a"), () => {
      told += 1
    })
    tick.flush()
    await settled()
    assert.equal(calls.length, 1, "the remount joined the first fetch")
    assert.equal(calls[0].signal.aborted, false)

    calls[0].resolve(road(250))
    await settled()
    assert.equal(told, 1, "the remount was told when the road landed")
    assert.deepEqual(cache.stateOf("a"), { status: "ready", geometry: road(250) })
  })

  test("a road that lands is remembered and reported; a hold on it afterwards fetches nothing", async () => {
    const { calls, fetchRoad } = fakeFetcher()
    const memory = new Map<string, RoadGeometry>()
    const cache = createRoadGeometryCache({ fetchRoad, memory, defer: manualTick().defer })
    let told = 0
    cache.hold(wanted("a"), () => {
      told += 1
    })
    calls[0].resolve(road(500))
    await settled()
    assert.equal(told, 1)
    assert.deepEqual([...memory.keys()], ["a"])

    cache.hold(wanted("a"), () => {})
    assert.equal(calls.length, 1, "known roads are not asked for again")
    assert.deepEqual(cache.inFlight(), [])
  })

  test("a refusal is remembered for the session; an abort is not, so the next hold asks again", async () => {
    const { calls, fetchRoad } = fakeFetcher()
    const tick = manualTick()
    const cache = createRoadGeometryCache({ fetchRoad, defer: tick.defer })
    let told = 0
    cache.hold(wanted("a"), () => {
      told += 1
    })
    calls[0].reject(new Error("The routing provider did not answer"))
    await settled()
    assert.deepEqual(cache.stateOf("a"), { status: "failed" })
    assert.equal(told, 1, "the consumer is told of the refusal")
    cache.hold(wanted("a"), () => {})
    assert.equal(calls.length, 1, "a refused road is not asked for again")

    const release = cache.hold(wanted("b"), () => {
      told += 1
    })
    release()
    tick.flush()
    await settled()
    assert.equal(calls[1].signal.aborted, true)
    assert.equal(told, 1, "nobody is told of an abort — nobody held it")
    assert.deepEqual(cache.stateOf("b"), { status: "pending" })
    cache.hold(wanted("b"), () => {})
    assert.equal(calls.length, 3, "the next hold asks again")
  })

  test("a hold that arrives after the abort but before its rejection gets a fresh request", async () => {
    const { calls, fetchRoad } = fakeFetcher()
    const tick = manualTick()
    const cache = createRoadGeometryCache({ fetchRoad, defer: tick.defer })
    let told = 0
    cache.hold(wanted("a"), () => {})()
    tick.flush()
    // Aborted, but the rejection has not run yet: the key is free again at once.
    cache.hold(wanted("a"), () => {
      told += 1
    })
    assert.equal(calls.length, 2)
    await settled()
    assert.deepEqual(cache.inFlight(), ["a"], "the fresh request survives the old one's rejection")
    calls[1].resolve(road(50))
    await settled()
    assert.equal(told, 1)
  })

  test("releasing a queued request drops it after the tick; a landed answer frees room for the next held one", async () => {
    const { calls, fetchRoad } = fakeFetcher()
    const tick = manualTick()
    const cache = createRoadGeometryCache({ fetchRoad, maxInFlight: 1, defer: tick.defer })
    cache.hold(wanted("a"), () => {})
    const releaseQueued = cache.hold(new Map([["b", stopsOf(1)]]), () => {})
    cache.hold(new Map([["c", stopsOf(2)]]), () => {})
    assert.deepEqual(cache.queued(), ["b", "c"])
    releaseQueued()
    tick.flush()
    assert.deepEqual(cache.queued(), ["c"])
    assert.equal(calls.length, 1, "a dropped queued request never started")

    calls[0].resolve(road(10))
    await settled()
    assert.deepEqual(cache.inFlight(), ["c"])
    assert.equal(calls.length, 2)
  })

  test("a consumer released before the road lands is not told; one still holding is", async () => {
    const { calls, fetchRoad } = fakeFetcher()
    const tick = manualTick()
    const cache = createRoadGeometryCache({ fetchRoad, defer: tick.defer })
    let gone = 0
    let staying = 0
    const release = cache.hold(wanted("a"), () => {
      gone += 1
    })
    cache.hold(wanted("a"), () => {
      staying += 1
    })
    release()
    tick.flush()
    calls[0].resolve(road(1))
    await settled()
    assert.equal(gone, 0)
    assert.equal(staying, 1)
  })

  test("roads known before the session answer at once and are never fetched", () => {
    const { calls, fetchRoad } = fakeFetcher()
    const memory = new Map([["a", road(7)]])
    const cache = createRoadGeometryCache({ fetchRoad, memory, defer: manualTick().defer })
    assert.deepEqual(cache.stateOf("a"), { status: "ready", geometry: road(7) })
    cache.hold(wanted("a"), () => {})
    assert.equal(calls.length, 0)
  })

  test("an estimate stands until the quota resumes, then the next hold asks again; the consumer is told of it", async () => {
    const { calls, fetchRoad } = fakeFetcher()
    const clock = { now: Date.parse("2026-10-01T12:00:00.000Z") }
    const cache = createRoadGeometryCache({ fetchRoad, defer: manualTick().defer, now: () => clock.now })
    let told = 0
    cache.hold(wanted("a"), () => {
      told += 1
    })
    calls[0].estimate("2026-10-01T14:32:00.000Z", "the routing provider's directions quota is spent")
    await settled()
    assert.equal(told, 1)
    assert.deepEqual(cache.stateOf("a"), { status: "estimate", resumesAt: "2026-10-01T14:32:00.000Z", reason: "the routing provider's directions quota is spent" })
    cache.hold(wanted("a"), () => {})
    assert.equal(calls.length, 1, "no road until the quota resumes: nothing asked")
    clock.now = Date.parse("2026-10-01T14:32:00.000Z")
    assert.deepEqual(cache.stateOf("a"), { status: "pending" }, "the estimate no longer stands")
    cache.hold(wanted("a"), () => {})
    assert.equal(calls.length, 2, "and the next hold asks again")
  })

  test("an estimate that names no resumption stands a few minutes, then is asked again", async () => {
    const { calls, fetchRoad } = fakeFetcher()
    const clock = { now: 0 }
    const cache = createRoadGeometryCache({ fetchRoad, defer: manualTick().defer, now: () => clock.now })
    cache.hold(wanted("a"), () => {})
    calls[0].estimate(null, "the routing provider refused the key")
    await settled()
    assert.equal(cache.stateOf("a").status, "estimate")
    clock.now = ESTIMATE_RECHECK_MS - 1
    cache.hold(wanted("a"), () => {})
    assert.equal(calls.length, 1)
    clock.now = ESTIMATE_RECHECK_MS
    cache.hold(wanted("a"), () => {})
    assert.equal(calls.length, 2)
  })

  test("the session's roads are capped, the oldest forgotten first", async () => {
    const memory = new Map<string, RoadGeometry>()
    for (let entry = 0; entry < ROAD_MEMORY_MAX; entry += 1) memory.set(`known-${entry}`, road(entry))
    const { calls, fetchRoad } = fakeFetcher()
    const cache = createRoadGeometryCache({ fetchRoad, memory, defer: manualTick().defer })
    cache.hold(wanted("a"), () => {})
    calls[0].resolve(road(1))
    await settled()
    assert.equal(memory.size, ROAD_MEMORY_MAX)
    assert.equal(memory.has("known-0"), false)
    assert.deepEqual([...memory.keys()].at(-1), "a")
  })

  test("a fetcher that throws counts as a refusal, not a crash", async () => {
    const cache = createRoadGeometryCache({
      fetchRoad: () => {
        throw new Error("no network")
      },
      defer: manualTick().defer,
    })
    cache.hold(wanted("a"), () => {})
    await settled()
    assert.deepEqual(cache.stateOf("a"), { status: "failed" })
  })
})
