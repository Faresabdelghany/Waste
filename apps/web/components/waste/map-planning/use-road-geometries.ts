"use client"

// The road through each drafted route's stops, for the guided setup's step 4
// (Issue #39; through the API since #173). Every route with two or more
// located stops asks `POST /routing/preview` for the road through them, a
// few requests at a time, and what the API answers — the road, or its
// estimate and why — is the session's, kept by
// lib/map-planning/road-geometry-cache.ts, whose one instance this hook
// holds for as long as it is mounted with the routes it was given; keyed by
// the stop sequence, so two routes over the same stops share one request.
// Without the API — fixture mode, local development, the fixture e2e — no
// road is asked for anywhere: every route reads `off`, drawn straight and
// dashed beside the prototype's estimate. The provider's key stays on the
// server, and no road request leaves the browser for anyone but the API.
// A dated Route's road is its active Plan's (use-plan-legs.ts), never this.

import { useEffect, useMemo, useState } from "react"

import type { Position2D } from "@waste/contracts/geojson"
import type { LngLat } from "@waste/domain/map-planning/geo"
import { useApiClient } from "@/components/waste/api-session-store"
import type { ApiClient } from "@/lib/api/client"
import { previewRoad } from "@/lib/api/routing"
import { roadGeometryKey, roadGeometryOfLegs, type RoadGeometry } from "@/lib/map-planning/road-geometry"
import { createRoadGeometryCache, type RoadAnswer, type RoadGeometryState } from "@/lib/map-planning/road-geometry-cache"
import { persistedKeys, ROAD_GEOMETRY_STORAGE_KEY } from "@/lib/storage-keys"

export type { RoadGeometryState } from "@/lib/map-planning/road-geometry-cache"

/** A route's road: what the session knows of it, or `off` where no API is there to ask. */
export type RoadState = RoadGeometryState | { status: "off" }

/** Anything the road is asked for: a drafted route's preview stops. */
export type RoadRoute = { id: string; stops: readonly { lngLat: LngLat }[] }

/** The client the next request goes out with: the hook sets it before each hold, since a token refresh replaces it. */
let client: ApiClient | null = null

const position = ({ lng, lat }: LngLat): Position2D => [lng, lat]

/** One preview, as the cache takes it: the road, or the estimate and why. */
async function askPreview(stops: readonly LngLat[], signal: AbortSignal): Promise<RoadAnswer> {
  if (client === null) throw new Error("no API to ask for the road")
  const answer = await previewRoad(client, stops.map(position), signal)
  if (answer.basis === "estimate") return { kind: "estimate", resumesAt: answer.resumesAt, reason: answer.reason }
  const geometry = roadGeometryOfLegs(answer.legs, { provider: answer.provider, optimised: false })
  if (geometry === null) return { kind: "estimate", resumesAt: null, reason: "the routing provider answered no road" }
  return { kind: "road", geometry }
}

const roads = createRoadGeometryCache({ fetchRoad: askPreview })

let forgotten = false

/** Removes the roads the maps kept in the browser from the OSRM demo server before #173, once a session. In an effect, never in render. */
export function forgetStoredRoads(): void {
  if (forgotten) return
  forgotten = true
  try {
    for (const key of persistedKeys(ROAD_GEOMETRY_STORAGE_KEY)) globalThis.localStorage?.removeItem(key)
  } catch {
    // No storage, or a blocked one: nothing is read from it either way.
  }
}

/** A route of one stop has no road: nothing to fetch, nothing to draw between. */
const noRoad = (stops: readonly LngLat[]): RoadGeometry => ({
  legs: [],
  snappedStops: [...stops],
  distanceMetres: 0,
  durationSeconds: 0,
  source: { provider: "none", optimised: false },
})

export function useRoadGeometries(routes: readonly RoadRoute[]): ReadonlyMap<string, RoadState> {
  const current = useApiClient()
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
  // by the time the hold is taken — landed between render and effect — is
  // redrawn once here, since the hold will not report it.
  useEffect(() => {
    forgetStoredRoads()
    if (current === null) return
    client = current
    const bump = () => setVersion((count) => count + 1)
    const release = roads.hold(wanted, bump)
    if ([...wanted.keys()].some((key) => roads.stateOf(key).status !== "pending")) bump()
    return release
  }, [current, wanted])

  return useMemo(() => {
    void version
    return new Map(
      routes.map((route): [string, RoadState] => {
        const stops = route.stops.map((stop) => stop.lngLat)
        if (stops.length < 2) return [route.id, { status: "ready", geometry: noRoad(stops) }]
        if (current === null) return [route.id, { status: "off" }]
        return [route.id, roads.stateOf(roadGeometryKey(stops))]
      }),
    )
  }, [current, routes, version])
}
