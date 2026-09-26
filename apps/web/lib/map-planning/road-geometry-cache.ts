// The session's roads (Issue #39, 2026-09-26): what use-road-geometries.ts
// used to keep in module maps — the roads answered, the stop sequences
// refused, the requests in flight — as one object with no React in it, so a
// test can hold it to the rules below. A road is asked for under the key of
// its stop sequence (roadGeometryKey), a few requests at a time, and every
// consumer wanting it holds it: a hold on a road already on its way joins
// the request instead of starting another, a hold on a road already known
// or refused starts nothing. A release takes the hold count down, and a
// request nobody holds any more is abandoned — a fetch on its way aborted, a
// queued one dropped — because the public OSRM demo server has no SLA, and a
// person stepping through the wizard's days and closing it should not leave
// a fetch running per day visited for an answer nobody will read. The abort
// waits one macrotask, since React's development double-mount releases and
// re-holds in the same tick: aborting at once killed the very first fetch,
// and the remount saw the key still in flight and never asked again — a
// route pending forever. A road that lands is remembered for the session
// (and, through onRemembered, in the browser); a refusal is remembered for
// the session; an abort is remembered as nothing, so the next hold asks again.

import type { LngLat } from "@waste/domain/map-planning/geo"

import { rememberRoadGeometry, type RoadGeometry } from "./road-geometry"

export type RoadGeometryState =
  | { status: "pending" }
  | { status: "ready"; geometry: RoadGeometry }
  | { status: "failed" }

/** Requests on their way at once — the demo server allows about one a second. */
export const MAX_ROADS_IN_FLIGHT = 3

/** Fetches the road through `stops`; rejects on refusal, and on abort with the signal's reason. */
export type RoadFetcher = (stops: readonly LngLat[], signal: AbortSignal) => Promise<RoadGeometry>

/** Runs `task` later and returns its cancel. The default is one macrotask (setTimeout 0). */
export type Defer = (task: () => void) => () => void

export type RoadGeometryCacheOptions = {
  fetchRoad: RoadFetcher
  maxInFlight?: number
  /** Roads known before the session — the browser's store; the cache takes the map over. */
  memory?: Map<string, RoadGeometry>
  /** Called after a road lands and is remembered, with everything remembered — the hook persists it. */
  onRemembered?: (memory: ReadonlyMap<string, RoadGeometry>) => void
  defer?: Defer
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

const deferOneMacrotask: Defer = (task) => {
  const timer = setTimeout(task, 0)
  return () => clearTimeout(timer)
}

export function createRoadGeometryCache(options: RoadGeometryCacheOptions): RoadGeometryCache {
  const maxInFlight = options.maxInFlight ?? MAX_ROADS_IN_FLIGHT
  const defer = options.defer ?? deferOneMacrotask
  const memory = options.memory ?? new Map<string, RoadGeometry>()
  const refused = new Set<string>()
  const requests = new Map<string, RoadRequest>()

  const inFlightCount = () => [...requests.values()].filter((request) => request.controller !== null).length

  const settle = (key: string, request: RoadRequest, outcome: "ready" | "failed" | "aborted", geometry?: RoadGeometry) => {
    // An abandoned request is already out of the map; a hold that came in
    // after the abort registered a fresh one under the key, which stays.
    if (requests.get(key) === request) requests.delete(key)
    if (outcome === "ready" && geometry) {
      rememberRoadGeometry(memory, key, geometry)
      options.onRemembered?.(memory)
    } else if (outcome === "failed") {
      refused.add(key)
    }
    if (outcome !== "aborted") {
      for (const listener of [...request.listeners]) listener()
    }
    pump()
  }

  const start = (key: string, request: RoadRequest) => {
    const controller = new AbortController()
    request.controller = controller
    // The executor turns a fetcher that throws into a rejection like any other.
    new Promise<RoadGeometry>((resolve) => resolve(options.fetchRoad(request.stops, controller.signal))).then(
      (geometry) => settle(key, request, "ready", geometry),
      () => settle(key, request, controller.signal.aborted ? "aborted" : "failed"),
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
      return { status: "pending" }
    },
    hold: (wanted, onSettled) => {
      const held: string[] = []
      for (const [key, stops] of wanted) {
        if (memory.has(key) || refused.has(key)) continue
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
