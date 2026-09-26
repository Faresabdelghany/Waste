"use client"

// Road geometry for the routes on the map (2026-09-16). Every drawn route
// with two or more located stops asks lib/map-planning/road-geometry for the
// road through them, a few requests at a time; answers are remembered for
// the session and in the browser, a refusal is remembered for the session
// so the demo server is not hammered, and a route whose road is pending or
// refused is drawn straight and dashed by the map. Keyed by the stop
// sequence, so two routes over the same stops share one request — and the
// planning map's dated routes and the guided setup's drafted routes (Issue
// #39) share one cache, since both are just stops in order. The cache itself
// — one request per key however many consumers hold it, the abort when the
// last one lets go, deferred a tick past React's development double-mount —
// is lib/map-planning/road-geometry-cache.ts, tested there without React;
// this hook holds the module's one instance for as long as it is mounted
// with the routes it was given, and redraws when a road it asked for lands.

import { useEffect, useMemo, useState } from "react"

import type { LngLat } from "@waste/domain/map-planning/geo"
import {
  fetchRoadGeometry,
  parseRoadGeometryCache,
  roadGeometryKey,
  serializeRoadGeometryCache,
  type RoadGeometry,
} from "@/lib/map-planning/road-geometry"
import { createRoadGeometryCache, type RoadGeometryState } from "@/lib/map-planning/road-geometry-cache"
import { readPersisted, ROAD_GEOMETRY_STORAGE_KEY } from "@/lib/storage-keys"

export type { RoadGeometryState } from "@/lib/map-planning/road-geometry-cache"

/** Anything the road is asked for: a dated route's located stops, or a drafted route's preview stops. */
export type RoadRoute = { id: string; stops: readonly { lngLat: LngLat }[] }

/** The session's roads: seeded from the browser's store on the first mount, written back as each road lands. */
const memory = new Map<string, RoadGeometry>()
let hydrated = false

const roads = createRoadGeometryCache({
  fetchRoad: (stops, signal) => fetchRoadGeometry(stops, { signal }),
  memory,
  onRemembered: (remembered) => {
    try {
      globalThis.localStorage?.setItem(ROAD_GEOMETRY_STORAGE_KEY, serializeRoadGeometryCache(remembered))
    } catch {
      // Storage full or blocked — the session cache still works.
    }
  },
})

/** Reads the browser's store into the session once. In an effect, never in render: readPersisted may move a legacy key. */
function hydrate(): void {
  if (hydrated) return
  hydrated = true
  try {
    const cached = parseRoadGeometryCache(readPersisted(globalThis.localStorage, ROAD_GEOMETRY_STORAGE_KEY))
    for (const [key, geometry] of cached) memory.set(key, geometry)
  } catch {
    // No storage — the session cache still works.
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

  const wanted = useMemo(() => {
    const byKey = new Map<string, readonly LngLat[]>()
    for (const route of routes) {
      if (route.stops.length < 2) continue
      const stops = route.stops.map((stop) => stop.lngLat)
      byKey.set(roadGeometryKey(stops), stops)
    }
    return byKey
  }, [routes])

  // Hold the wanted roads while these routes are shown; the release on the
  // way out lets the cache abort a request nobody else holds. A road settled
  // by the time the hold is taken — hydrated, or landed between render and
  // effect — is redrawn once here, since the hold will not report it.
  useEffect(() => {
    const bump = () => setVersion((current) => current + 1)
    hydrate()
    const release = roads.hold(wanted, bump)
    if ([...wanted.keys()].some((key) => roads.stateOf(key).status !== "pending")) bump()
    return release
  }, [wanted])

  return useMemo(() => {
    void version
    return new Map(
      routes.map((route): [string, RoadGeometryState] => {
        const stops = route.stops.map((stop) => stop.lngLat)
        if (stops.length < 2) return [route.id, { status: "ready", geometry: noRoad(stops) }]
        return [route.id, roads.stateOf(roadGeometryKey(stops))]
      }),
    )
  }, [routes, version])
}
