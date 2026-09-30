"use client"

// The guided setup's route map (Issue #39, 2026-09-25): the drafted routes
// of one service day on a real map — a MapLibre base map with the depot,
// each route's stops in generation's order, and the unloading station, the
// line between them the road a routing engine answered with, drawn the way
// the planning map draws a dated route (lib/map-planning/road-geometry: one
// SVG path per road in world pixels at the reference zoom, inside one group
// whose translate-and-scale transform follows the camera, so the map is
// north-up and flat — rotation and pitch are disabled and must stay so).
// A road still pending, or one the engine refused, is the stops joined
// straight and dashed, and says so. What was here before — a block diagram
// with hashed pin positions — is gone: nothing on this map is invented.
// Loaded client-only by step-route-map.tsx (next/dynamic).

import { Map as MapLibreMap, NavigationControl, type StyleSpecification } from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { pointMapLibreWorkerAtRouteHandler } from "@/components/waste/map-planning/maplibre-worker"
import type { RoadState } from "@/components/waste/map-planning/use-road-geometries"
import { RoutingAttribution } from "@/components/waste/routing/routing-attribution"
import { baseMapById, type BaseMapId } from "@/lib/map-planning/base-maps"
import { roadOverlay, roadOverlayPath, roadPath, type ScreenPoint } from "@/lib/map-planning/road-geometry"
import type { LngLat, LngLatBounds } from "@waste/domain/map-planning/geo"
import { COPENHAGEN_CENTER } from "@waste/domain/map-planning/positions"
import type { PreviewStop, RoutePreview } from "@waste/domain/map-planning/route-preview"
import { SERVICE_DAY_LABELS, type ServiceDay } from "@waste/domain/route-schemes/recurrence"

import type { WizardRoute } from "./wizard-model"

// The tile worker's URL, see maplibre-worker.ts — set before the first Map.
pointMapLibreWorkerAtRouteHandler()

const INITIAL_ZOOM = 11
const MIN_ZOOM = 0
const MAX_ZOOM = 19
const FIT_PADDING_PX = 40
const FIT_MAX_ZOOM = 15

export type RouteMapProps = {
  routes: readonly WizardRoute[]
  /** The road through each route's preview stops, by `WizardRoute.routeId`. */
  roads: ReadonlyMap<string, RoadState>
  selected: string | null
  day: ServiceDay
  baseMap: BaseMapId
  /** Every drawn stop of the day, to frame; null when nothing is drawn. */
  bounds: LngLatBounds | null
}

const styleOf = (baseMap: BaseMapId) => baseMapById(baseMap).style as string | StyleSpecification

const toPoints = (screen: readonly ScreenPoint[]) => screen.map((point) => `${point.x},${point.y}`).join(" ")

/** The bounds as their identity: four corners to five decimals (about a metre), or "" for none. */
const boundsKey = (bounds: LngLatBounds | null) =>
  bounds ? [bounds.west, bounds.south, bounds.east, bounds.north].map((n) => n.toFixed(5)).join(",") : ""

const parseBoundsKey = (key: string): LngLatBounds | null => {
  if (!key) return null
  const [west, south, east, north] = key.split(",").map(Number)
  return { west, south, east, north }
}

/** How a stop is drawn: bases as squares, containers as dots. */
function StopMark({ stop, at, color, emphasised }: { stop: PreviewStop; at: ScreenPoint; color: string; emphasised: boolean }) {
  if (stop.kind === "container") {
    return <circle cx={at.x} cy={at.y} r={emphasised ? 4.5 : 3.5} fill="white" stroke={color} strokeWidth={2} />
  }
  const size = 12
  return (
    <g transform={`translate(${at.x} ${at.y})`} data-preview-stop={stop.kind}>
      <rect x={-size / 2} y={-size / 2} width={size} height={size} rx={2} fill="var(--foreground)" stroke="white" strokeWidth={2} />
      {stop.kind === "depot" ? (
        <rect x={-2.5} y={-2.5} width={5} height={5} fill="var(--background)" />
      ) : (
        <path d="M-2.5 3 L-2.5 -1 L0 -3 L2.5 -1 L2.5 3 Z" fill="var(--background)" />
      )}
    </g>
  )
}

export function RouteMap({ routes, roads, selected, day, baseMap, bounds }: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const loadedRef = useRef(false)
  const [mapInstance, setMapInstance] = useState<MapLibreMap | null>(null)
  const [, setFrame] = useState(0)
  const [baseMapFailed, setBaseMapFailed] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container || mapRef.current) return
    const map = new MapLibreMap({
      container,
      style: styleOf(baseMap),
      center: [COPENHAGEN_CENTER.lng, COPENHAGEN_CENTER.lat],
      zoom: INITIAL_ZOOM,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      attributionControl: { compact: true },
      doubleClickZoom: true,
      // North-up and flat, like the planning map: the road overlay is one
      // translate-and-scale transform, which assumes no rotation or pitch.
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    })
    map.touchZoomRotate.disableRotation()
    map.keyboard.disableRotation()
    map.addControl(new NavigationControl({ showCompass: false }), "top-right")
    const onStyleLoaded = () => {
      loadedRef.current = true
      setBaseMapFailed(false)
      container.dataset.mapLoaded = "true"
    }
    map.on("load", onStyleLoaded)
    map.on("style.load", onStyleLoaded)
    map.on("error", (event) => {
      console.warn("[route-map]", event.error?.message ?? event)
      if (!loadedRef.current) setBaseMapFailed(true)
    })
    const onMove = () => setFrame((frame) => frame + 1)
    map.on("move", onMove)
    map.on("resize", onMove)
    mapRef.current = map
    setMapInstance(map)
    return () => {
      map.remove()
      mapRef.current = null
      setMapInstance(null)
      loadedRef.current = false
    }
    // The map is created once; base map changes restyle it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const firstStyleRef = useRef(true)
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (firstStyleRef.current) {
      firstStyleRef.current = false
      return
    }
    loadedRef.current = false
    setBaseMapFailed(false)
    map.setStyle(styleOf(baseMap))
  }, [baseMap])

  // Frame the day's routes whenever the set of drawn stops changes, and a
  // picked route alone while one is picked. The frame is one value per
  // corner set, parsed back from its key, so a render that rebuilds the
  // same bounds object does not refit the camera.
  const selectedRoute = selected ? routes.find((route) => route.summary.group.id === selected) : undefined
  const frameKey = boundsKey(selectedRoute?.preview.bounds ?? bounds)
  const frame = useMemo(() => parseBoundsKey(frameKey), [frameKey])
  useEffect(() => {
    const map = mapRef.current
    if (!map || !frame) return
    // MapLibre only runs animation frames once a style has loaded; without a
    // base map (offline, blocked tiles) the camera jumps instead of easing.
    map.fitBounds(
      [
        [frame.west, frame.south],
        [frame.east, frame.north],
      ],
      { padding: FIT_PADDING_PX, duration: loadedRef.current ? 500 : 0, maxZoom: FIT_MAX_ZOOM },
    )
  }, [frame, mapInstance])

  const project = useCallback(
    (lngLat: LngLat): ScreenPoint | null => {
      if (!mapInstance) return null
      const point = mapInstance.project([lngLat.lng, lngLat.lat])
      return { x: point.x, y: point.y }
    },
    [mapInstance],
  )

  // Road paths are built once, in world pixels at the reference zoom
  // relative to the city centre; per frame only the group transform changes.
  const roadPaths = useMemo(() => {
    const paths = new Map<string, string>()
    for (const route of routes) {
      const state = roads.get(route.routeId)
      if (state?.status === "ready" && state.geometry.legs.length > 0) {
        paths.set(route.routeId, roadOverlayPath(roadPath(state.geometry)))
      }
    }
    return paths
  }, [roads, routes])
  const overlay = roadOverlay(project)
  // Whose roads are drawn, for the attribution the provider's geometry is owed.
  const sources = useMemo(
    () =>
      [...roadPaths.keys()].flatMap((routeId) => {
        const state = roads.get(routeId)
        return state?.status === "ready" ? [state.geometry.source] : []
      }),
    [roadPaths, roads],
  )

  return (
    <div className="relative h-full w-full overflow-hidden bg-muted" data-testid="wizard-route-map">
      <div ref={containerRef} className="h-full w-full" data-testid="wizard-route-map-canvas" />

      {baseMapFailed && (
        <div
          role="status"
          className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-md border border-border bg-background/95 px-3 py-1.5 text-xs text-muted-foreground shadow-sm"
        >
          Base map unavailable — the routes still stand.
        </div>
      )}

      {mapInstance && (
        <svg
          className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible"
          role="img"
          aria-label={`Route preview for ${SERVICE_DAY_LABELS[day]}`}
          data-testid="wizard-route-lines"
        >
          {/* The picked route is drawn last so it sits on top of the others. */}
          {[...routes]
            .sort((a, b) => Number(a.summary.group.id === selected) - Number(b.summary.group.id === selected))
            .map((route) => {
              const preview: RoutePreview = route.preview
              const state = roads.get(route.routeId)
              const road = state?.status === "ready" && state.geometry.legs.length > 0 ? state.geometry : null
              const roadData = road && overlay ? roadPaths.get(route.routeId) : undefined
              const anchors = (road ? road.snappedStops : preview.stops.map((stop) => stop.lngLat))
                .map(project)
                .filter((point): point is ScreenPoint => point !== null)
              if (anchors.length === 0) return null
              const picked = selected === route.summary.group.id
              const dim = selected !== null && !picked
              const width = picked ? 4.5 : 3
              const color = route.summary.color
              const geometry = roadData ? "road" : anchors.length < 2 ? "none" : state?.status === "pending" ? "pending" : "straight"
              return (
                <g
                  key={route.routeId}
                  data-wizard-route={route.summary.group.id}
                  data-route-geometry={geometry}
                  opacity={dim ? 0.25 : 1}
                >
                  {roadData ? (
                    <g transform={overlay!.transform}>
                      <path
                        d={roadData}
                        fill="none"
                        stroke="white"
                        strokeWidth={width + 3}
                        strokeOpacity={0.9}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                      />
                      <path
                        d={roadData}
                        data-wizard-road={route.summary.group.id}
                        fill="none"
                        stroke={color}
                        strokeWidth={width}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                      />
                    </g>
                  ) : (
                    anchors.length >= 2 && (
                      /* No road yet, or none to be had: the stops joined straight, dashed to say so. */
                      <polyline
                        points={toPoints(anchors)}
                        fill="none"
                        stroke={color}
                        strokeWidth={picked ? 3.5 : 2.5}
                        strokeDasharray="6 6"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        strokeOpacity={0.85}
                      />
                    )
                  )}
                  {preview.stops.map((stop, index) => {
                    // The road's snapped stops stand where the engine put them, one per preview stop.
                    const at = road && anchors.length === preview.stops.length ? anchors[index] : project(stop.lngLat)
                    if (!at) return null
                    return <StopMark key={`${stop.kind}-${stop.containerId ?? index}`} stop={stop} at={at} color={color} emphasised={picked} />
                  })}
                </g>
              )
            })}
        </svg>
      )}
      <RoutingAttribution sources={sources} />
    </div>
  )
}
