"use client"

// Road geometry for the routes on the map (2026-09-16). Every drawn route
// with two or more located stops asks lib/map-planning/road-geometry for the
// road through them, a few requests at a time; answers are remembered for
// the session and in the browser, a refusal is remembered for the session
// so the demo server is not hammered, and a route whose road is pending or
// refused is drawn straight and dashed by the map. Keyed by the stop
// sequence, so two routes over the same stops share one request — and the
// planning map's dated routes and the guided setup's drafted routes (Issue
// #39) share one cache, since both are just stops in order.

import { useEffect, useMemo, useRef, useState } from "react"

import type { LngLat } from "@waste/domain/map-planning/geo"
import {
  fetchRoadGeometry,
  parseRoadGeometryCache,
  rememberRoadGeometry,
  roadGeometryKey,
  serializeRoadGeometryCache,
  type RoadGeometry,
} from "@/lib/map-planning/road-geometry"
import { readPersisted, ROAD_GEOMETRY_STORAGE_KEY } from "@/lib/storage-keys"

/** Anything the road is asked for: a dated route's located stops, or a drafted route's preview stops. */
export type RoadRoute = { id: string; stops: readonly { lngLat: LngLat }[] }

export type RoadGeometryState =
  | { status: "pending" }
  | { status: "ready"; geometry: RoadGeometry }
  | { status: "failed" }

const MAX_IN_FLIGHT = 3

const memory = new Map<string, RoadGeometry>()
const refused = new Set<string>()
const inFlight = new Map<string, Promise<void>>()
let hydrated = false

function hydrate() {
  if (hydrated) return
  hydrated = true
  try {
    const cached = parseRoadGeometryCache(
      readPersisted(globalThis.localStorage, ROAD_GEOMETRY_STORAGE_KEY),
    )
    for (const [key, geometry] of cached) {
      memory.set(key, geometry)
    }
  } catch {
    // No storage — the session cache still works.
  }
}

function persist() {
  try {
    globalThis.localStorage?.setItem(ROAD_GEOMETRY_STORAGE_KEY, serializeRoadGeometryCache(memory))
  } catch {
    // Storage full or blocked — the session cache still works.
  }
}

/** A route of one stop has no road: nothing to fetch, nothing to draw between. */
const noRoad = (stops: readonly LngLat[]): RoadGeometry => ({
  legs: [],
  snappedStops: [...stops],
  distanceMetres: 0,
  durationSeconds: 0,
})

export function useRoadGeometries(routes: readonly RoadRoute[]): ReadonlyMap<string, RoadGeometryState> {
  const [version, setVersion] = useState(0)
  const mountedRef = useRef(false)

  // A request in flight is shared by every mounted consumer through the
  // module maps, so no consumer aborts it on its way out (Issue #39): the
  // first mount used to arm an AbortController that React's development
  // double-mount fired at once, killing the very first fetch, and the
  // remount saw the key still in flight and never asked again — a route
  // pending forever. An answer that lands after a consumer has gone is
  // still remembered for the next one; only the redraw is skipped.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const wanted = useMemo(() => {
    const byKey = new Map<string, readonly LngLat[]>()
    for (const route of routes) {
      if (route.stops.length < 2) continue
      const stops = route.stops.map((stop) => stop.lngLat)
      byKey.set(roadGeometryKey(stops), stops)
    }
    return byKey
  }, [routes])

  useEffect(() => {
    hydrate()
    const bump = () => {
      if (mountedRef.current) setVersion((current) => current + 1)
    }
    // Roads already on their way (asked for by an earlier route set, or by another map) redraw us when they land.
    for (const [key] of wanted) inFlight.get(key)?.then(bump)
    const queue = [...wanted].filter(([key]) => !memory.has(key) && !refused.has(key) && !inFlight.has(key))
    const start = () => {
      while (inFlight.size < MAX_IN_FLIGHT && queue.length > 0) {
        const [key, stops] = queue.shift()!
        const task = fetchRoadGeometry(stops)
          .then(
            (geometry) => {
              rememberRoadGeometry(memory, key, geometry)
              persist()
            },
            () => {
              refused.add(key)
            },
          )
          .finally(() => {
            inFlight.delete(key)
            bump()
            start()
          })
        inFlight.set(key, task)
      }
    }
    start()
  }, [wanted])

  return useMemo(() => {
    void version
    return new Map(
      routes.map((route): [string, RoadGeometryState] => {
        const stops = route.stops.map((stop) => stop.lngLat)
        if (stops.length < 2) return [route.id, { status: "ready", geometry: noRoad(stops) }]
        const key = roadGeometryKey(stops)
        const known = memory.get(key)
        if (known) return [route.id, { status: "ready", geometry: known }]
        if (refused.has(key)) return [route.id, { status: "failed" }]
        return [route.id, { status: "pending" }]
      }),
    )
  }, [routes, version])
}
