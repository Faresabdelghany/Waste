// The session's roads (Issue #39, 2026-09-26; through the API since #173):
// the roads answered, the stop sequences refused, the requests in flight —
// one object with no React in it, so a test can hold it to the rules below.
// A road is asked for under the key of its stop sequence (roadGeometryKey),
// a few requests at a time, and every consumer wanting it holds it: a hold
// on a road already on its way joins the request instead of starting
// another, a hold on a road already known or refused starts nothing. A
// release takes the hold count down, and a request nobody holds any more is
// abandoned — a fetch on its way aborted, a queued one dropped — because
// every road is a routing call the API spends quota on (#132 §5), and a
// person stepping through the wizard's days and closing it should not leave
// a request running per day visited for an answer nobody will read. The
// abort waits one macrotask, since React's development double-mount releases
// and re-holds in the same tick: aborting at once killed the very first
// fetch, and the remount saw the key still in flight and never asked again —
// a route pending forever.
//
// What lands is remembered for the session, the roads capped, oldest first
// out: a road; an estimate — the API's word that there is no road now, the
// quota spent or the points refused — until the quota `resumesAt`, or for
// ESTIMATE_RECHECK_MS where it names no instant, after which the next hold
// asks again; a refusal (the request failed) for the session; an abort as
// nothing, so the next hold asks again. Nothing is kept in the browser's
// storage: the API caches the answers across people, and the roads the
// OSRM demo server answered before #173 are not to be shown again.

import type { LngLat } from "@waste/domain/map-planning/geo"

import type { RoadGeometry } from "./road-geometry"

/** What the API answered for one stop sequence: the road, or the estimate and why. */
export type RoadAnswer =
  | { kind: "road"; geometry: RoadGeometry }
  | { kind: "estimate"; resumesAt: string | null; reason: string }

export type RoadGeometryState =
  | { status: "pending" }
  | { status: "ready"; geometry: RoadGeometry }
  /** No road for now, in the API's words: straight and dashed, `resumesAt` when the quota opens again. */
  | { status: "estimate"; resumesAt: string | null; reason: string }
  | { status: "failed" }

/** Requests on their way at once. */
export const MAX_ROADS_IN_FLIGHT = 3
/** Roads remembered for the session before the oldest is forgotten. */
export const ROAD_MEMORY_MAX = 150
/** How long an estimate that names no resumption — the points refused, the key refused — stands before a hold asks again. */
export const ESTIMATE_RECHECK_MS = 5 * 60 * 1000

/** Fetches the road through `stops`; rejects on failure, and on abort with the signal's reason. */
export type RoadFetcher = (stops: readonly LngLat[], signal: AbortSignal) => Promise<RoadAnswer>

/** Runs `task` later and returns its cancel. The default is one macrotask (setTimeout 0). */
export type Defer = (task: () => void) => () => void

export type RoadGeometryCacheOptions = {
  fetchRoad: RoadFetcher
  maxInFlight?: number
  /** Roads known before the cache was made; the cache takes the map over and caps it. */
  memory?: Map<string, RoadGeometry>
  defer?: Defer
  /** The clock an estimate's standing is read against, in milliseconds. */
  now?: () => number
}

export type RoadGeometryCache = {
  /** What the session knows about the road with this key, right now. */
  stateOf: (key: string) => RoadGeometryState
  /**
   * Wants the roads for `wanted` (key → stops) until the returned release is
   * called; `onSettled` runs each time one of them lands or is refused.
   * Releasing twice is harmless.
   */
  hold: (wanted: ReadonlyMap<string, readonly LngLat[]>, onSettled: () => void) => () => void
  /** Keys of the requests on their way, oldest first. */
  inFlight: () => string[]
  /** Keys wanted but not yet started, oldest first. */
  queued: () => string[]
}

type RoadRequest = {
  stops: readonly LngLat[]
  /** Consumers holding the request; 0 while a release's deferred abandon is pending. */
  holds: number
  /** Set when the request starts; null while it is queued. */
  controller: AbortController | null
  /** Consumers to tell when the request settles — one entry per hold, so a callback held twice is told until both release. */
  listeners: Array<() => void>
  /** Cancels the deferred abandon a release scheduled, if one is pending. */
  cancelAbandon: (() => void) | null
}

type Estimate = { resumesAt: string | null; reason: string; standsUntil: number }

const deferOneMacrotask: Defer = (task) => {
  const timer = setTimeout(task, 0)
  return () => clearTimeout(timer)
}

/** Records `geometry` under `key` as the newest entry, forgetting the oldest past `max`. */
export function rememberRoadGeometry(memory: Map<string, RoadGeometry>, key: string, geometry: RoadGeometry, max = ROAD_MEMORY_MAX): Map<string, RoadGeometry> {
  memory.delete(key)
  memory.set(key, geometry)
  while (memory.size > max) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) break
    memory.delete(oldest)
  }
  return memory
}

export function createRoadGeometryCache(options: RoadGeometryCacheOptions): RoadGeometryCache {
  const maxInFlight = options.maxInFlight ?? MAX_ROADS_IN_FLIGHT
  const defer = options.defer ?? deferOneMacrotask
  const now = options.now ?? Date.now
  const memory = options.memory ?? new Map<string, RoadGeometry>()
  const refused = new Set<string>()
  const estimates = new Map<string, Estimate>()
  const requests = new Map<string, RoadRequest>()

  /** The estimate standing for the key, forgotten once it no longer does. */
  const estimateOf = (key: string): Estimate | undefined => {
    const estimate = estimates.get(key)
    if (estimate !== undefined && now() >= estimate.standsUntil) {
      estimates.delete(key)
      return undefined
    }
    return estimate
  }

  const inFlightCount = () => [...requests.values()].filter((request) => request.controller !== null).length

  const settle = (key: string, request: RoadRequest, outcome: { kind: "answered"; answer: RoadAnswer } | { kind: "failed" } | { kind: "aborted" }) => {
    // An abandoned request is already out of the map; a hold that came in
    // after the abort registered a fresh one under the key, which stays.
    if (requests.get(key) === request) requests.delete(key)
    if (outcome.kind === "answered") {
      const { answer } = outcome
      if (answer.kind === "road") {
        rememberRoadGeometry(memory, key, answer.geometry)
      } else {
        const resumes = answer.resumesAt === null ? Number.NaN : Date.parse(answer.resumesAt)
        estimates.set(key, { resumesAt: answer.resumesAt, reason: answer.reason, standsUntil: Number.isFinite(resumes) ? resumes : now() + ESTIMATE_RECHECK_MS })
      }
    } else if (outcome.kind === "failed") {
      refused.add(key)
    }
    if (outcome.kind !== "aborted") {
      for (const listener of [...request.listeners]) listener()
    }
    pump()
  }

  const start = (key: string, request: RoadRequest) => {
    const controller = new AbortController()
    request.controller = controller
    // The executor turns a fetcher that throws into a rejection like any other.
    new Promise<RoadAnswer>((resolve) => resolve(options.fetchRoad(request.stops, controller.signal))).then(
      (answer) => settle(key, request, { kind: "answered", answer }),
      () => settle(key, request, controller.signal.aborted ? { kind: "aborted" } : { kind: "failed" }),
    )
  }

  /** Starts queued requests somebody still holds, up to the limit, oldest first. */
  const pump = () => {
    let room = maxInFlight - inFlightCount()
    for (const [key, request] of requests) {
      if (room <= 0) break
      if (request.controller !== null || request.holds === 0) continue
      start(key, request)
      room -= 1
    }
  }

  /** Nobody held the request through the tick: a fetch on its way is aborted, a queued one is dropped. */
  const abandon = (key: string) => {
    const request = requests.get(key)
    if (!request || request.holds > 0) return
    request.cancelAbandon = null
    requests.delete(key)
    if (request.controller) {
      // The rejection handler settles it as aborted — remembered as nothing — and pumps the queue.
      request.controller.abort()
    } else {
      pump()
    }
  }

  return {
    stateOf: (key) => {
      const known = memory.get(key)
      if (known) return { status: "ready", geometry: known }
      if (refused.has(key)) return { status: "failed" }
      const estimate = estimateOf(key)
      if (estimate) return { status: "estimate", resumesAt: estimate.resumesAt, reason: estimate.reason }
      return { status: "pending" }
    },
    hold: (wanted, onSettled) => {
      const held: string[] = []
      for (const [key, stops] of wanted) {
        if (memory.has(key) || refused.has(key) || estimateOf(key) !== undefined) continue
        let request = requests.get(key)
        if (!request) {
          request = { stops, holds: 0, controller: null, listeners: [], cancelAbandon: null }
          requests.set(key, request)
        }
        request.holds += 1
        request.cancelAbandon?.()
        request.cancelAbandon = null
        request.listeners.push(onSettled)
        held.push(key)
      }
      pump()
      let released = false
      return () => {
        if (released) return
        released = true
        for (const key of held) {
          const request = requests.get(key)
          if (!request) continue
          const at = request.listeners.indexOf(onSettled)
          if (at >= 0) request.listeners.splice(at, 1)
          request.holds = Math.max(0, request.holds - 1)
          if (request.holds === 0 && !request.cancelAbandon) {
            request.cancelAbandon = defer(() => abandon(key))
          }
        }
      }
    },
    inFlight: () => [...requests].filter(([, request]) => request.controller !== null).map(([key]) => key),
    queued: () => [...requests].filter(([, request]) => request.controller === null).map(([key]) => key),
  }
}
