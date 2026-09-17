"use client"

// Road geometry for the routes on the map (2026-09-16). Every drawn route
// with two or more located stops asks lib/map-planning/road-geometry for the
// road through them, a few requests at a time; answers are remembered for
// the session and in the browser, a refusal is remembered for the session
// so the demo server is not hammered, and a route whose road is pending or
// refused is drawn straight and dashed by the map. Keyed by the stop
// sequence, so two routes over the same stops share one request.

import { useEffect, useMemo, useRef, useState } from "react"

import type { LngLat } from "@/lib/map-planning/geo"
import {
  ROAD_GEOMETRY_STORAGE_KEY,
  fetchRoadGeometry,
  parseRoadGeometryCache,
  rememberRoadGeometry,
  roadGeometryKey,
  serializeRoadGeometryCache,
  type RoadGeometry,
} from "@/lib/map-planning/road-geometry"
import type { AreaRoute } from "@/lib/map-planning/routes"

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
    for (const [key, geometry] of parseRoadGeometryCache(globalThis.localStorage?.getItem(ROAD_GEOMETRY_STORAGE_KEY) ?? null)) {
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

export function useRoadGeometries(routes: readonly AreaRoute[]): ReadonlyMap<string, RoadGeometryState> {
  const [version, setVersion] = useState(0)
  const controllerRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    controllerRef.current = new AbortController()
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort()
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
    // Roads already on their way (asked for by an earlier route set) redraw us when they land.
    for (const [key] of wanted) inFlight.get(key)?.then(bump)
    const queue = [...wanted].filter(([key]) => !memory.has(key) && !refused.has(key) && !inFlight.has(key))
    const start = () => {
      while (inFlight.size < MAX_IN_FLIGHT && queue.length > 0) {
        const [key, stops] = queue.shift()!
        const signal = controllerRef.current?.signal
        const task = fetchRoadGeometry(stops, { signal })
          .then(
            (geometry) => {
              rememberRoadGeometry(memory, key, geometry)
              persist()
            },
            () => {
              if (!signal?.aborted) refused.add(key)
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
