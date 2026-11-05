"use client"

// Where a place stands on screen under a MapLibre map's current camera, for
// the overlays the maps draw over the canvas (markers, the road, shapes).
// The projection is a new function after every camera move or resize:
// React Compiler memoises whatever a render computes from it, and a
// function that kept one identity across moves let the overlays keep the
// positions of the camera they were first drawn under — the map zoomed and
// panned beneath a route line and stops that stayed put. Every map that
// draws over its canvas projects through this one hook.

import type { Map as MapLibreMap } from "maplibre-gl"
import { useEffect, useMemo, useState } from "react"

import type { LngLat } from "@waste/domain/map-planning/geo"

export type ScreenPoint = { x: number; y: number }

export type MapProjection = (lngLat: LngLat) => ScreenPoint | null

/**
 * The projection under `camera`, the count of camera changes so far. The
 * count is an argument so a new count is a new projection: what was
 * computed from the old one is computed again.
 */
function projectionAt(map: MapLibreMap | null, camera: number): MapProjection {
  void camera
  return (lngLat) => {
    if (!map) return null
    const point = map.project([lngLat.lng, lngLat.lat])
    return { x: point.x, y: point.y }
  }
}

/**
 * Call it before any effect that moves the camera on the same map, so its
 * listener is in place when the first move fires.
 */
export function useMapProjection(map: MapLibreMap | null): MapProjection {
  const [camera, setCamera] = useState(0)
  useEffect(() => {
    if (!map) return
    const moved = () => setCamera((count) => count + 1)
    map.on("move", moved)
    map.on("resize", moved)
    return () => {
      map.off("move", moved)
      map.off("resize", moved)
    }
  }, [map])
  return useMemo(() => projectionAt(map, camera), [map, camera])
}
