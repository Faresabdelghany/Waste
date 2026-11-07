"use client"

// One MapLibre map on a container, the way every map in the app is made: the
// planning map, a route's map, the guided setup's and the public drop-off
// map. MapLibre 6 derives its module-worker URL from its own module URL, which
// Turbopack's chunking breaks (the worker never starts, no tile loads), so the
// route handler at app/maplibre/[version]/[asset] serves the worker and its
// shared chunk from the installed package, the version stamp keeping the
// immutable cache honest across upgrades. Every map is north-up and flat: an
// overlay's road moves with one translate-and-scale transform, which assumes
// no rotation or pitch.
import { getVersion, Map as MapLibreMap, NavigationControl, setWorkerUrl, type MapOptions, type StyleSpecification } from "maplibre-gl"
import { useEffect, useRef, useState, type RefObject } from "react"

import { baseMapById, type BaseMapId } from "@/lib/map-planning/base-maps"

// Before the first Map is made.
setWorkerUrl(`/maplibre/${getVersion()}/maplibre-gl-worker.mjs`)

const styleOf = (baseMap: BaseMapId) => baseMapById(baseMap).style as string | StyleSpecification

/** Where a map's camera starts, its zoom limits, and whether a double-click zooms: the rest of its options are the app's. */
export type MapCamera = Pick<MapOptions, "center" | "zoom" | "bounds" | "fitBoundsOptions" | "minZoom" | "maxZoom" | "doubleClickZoom">

export type MapLibreSetup = {
  /** The base map drawn; another one restyles the map in place. */
  baseMap: BaseMapId
  /** Read when the map is made, and not after. */
  camera: MapCamera
  /** The console's tag for the map's errors. */
  name: string
}

export type MapLibre = {
  /** The map, once made: state, so what is drawn over it renders again. */
  map: MapLibreMap | null
  /** Whether a style has loaded: MapLibre runs animation frames only then, so a camera move eases, else it jumps. */
  styleLoaded: RefObject<boolean>
  /** Whether the base map failed before a style ever loaded (offline, blocked tiles): what is drawn over it still stands. */
  baseMapFailed: boolean
}

/**
 * Makes the map once, on the container, and removes it with the component.
 * The container says when a style has loaded and when the map is idle (every
 * visible tile drawn), for tests and debugging: `data-map-loaded`,
 * `data-map-idle`.
 */
export function useMapLibre(container: RefObject<HTMLDivElement | null>, { baseMap, camera, name }: MapLibreSetup): MapLibre {
  const [map, setMap] = useState<MapLibreMap | null>(null)
  const styleLoaded = useRef(false)
  const [baseMapFailed, setBaseMapFailed] = useState(false)
  const made = useRef({ baseMap, camera, name })
  const shown = useRef(baseMap)

  useEffect(() => {
    const element = container.current
    if (!element) return
    const { baseMap: first, camera: start, name: tag } = made.current
    const instance = new MapLibreMap({
      container: element,
      style: styleOf(first),
      ...start,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    })
    instance.touchZoomRotate.disableRotation()
    instance.keyboard.disableRotation()
    instance.addControl(new NavigationControl({ showCompass: false }), "top-right")
    const onStyleLoaded = () => {
      styleLoaded.current = true
      setBaseMapFailed(false)
      element.dataset.mapLoaded = "true"
    }
    instance.on("load", onStyleLoaded)
    instance.on("style.load", onStyleLoaded)
    instance.on("idle", () => {
      element.dataset.mapIdle = "true"
    })
    instance.on("dataloading", () => {
      delete element.dataset.mapIdle
    })
    instance.on("error", (event) => {
      // Tile misses after a style has loaded are cosmetic; a failure before one arrives means no base map at all.
      console.warn(`[${tag}]`, event.error?.message ?? event)
      if (!styleLoaded.current) setBaseMapFailed(true)
    })
    shown.current = first
    setMap(instance)
    return () => {
      instance.remove()
      setMap(null)
      styleLoaded.current = false
    }
  }, [container])

  useEffect(() => {
    if (map === null || shown.current === baseMap) return
    shown.current = baseMap
    styleLoaded.current = false
    setBaseMapFailed(false)
    map.setStyle(styleOf(baseMap))
  }, [baseMap, map])

  return { map, styleLoaded, baseMapFailed }
}
