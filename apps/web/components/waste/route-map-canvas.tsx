"use client"

// One route on a real map, for its page on the Pilot (route-map-panel.tsx):
// a MapLibre base map with the route's depot, its stops numbered in the order
// they will be visited and coloured by how each stands, and its unloading
// station; the line between them its active Plan's road, drawn as the
// planning map and the guided setup draw one (lib/map-planning/road-geometry:
// one SVG path in world pixels at the reference zoom, inside one group whose
// transform follows the camera, so the map stays north-up and flat), or the
// places joined straight and dashed while it has no measured Plan. Nothing on
// it is invented: a stop with no place it can be drawn at is left off, and the
// panel says so. Loaded client-only (next/dynamic).

import "maplibre-gl/dist/maplibre-gl.css"
import { useEffect, useMemo, useRef } from "react"

import { useMapLibre } from "@/components/maps/use-maplibre"
import { useMapProjection, type ScreenPoint } from "@/components/waste/map-planning/use-map-projection"
import { RoutingAttribution } from "@/components/waste/routing/routing-attribution"
import type { BaseMapId } from "@/lib/map-planning/base-maps"
import { roadOverlay, roadOverlayPath, roadPath, type RoadGeometry } from "@/lib/map-planning/road-geometry"
import type { LngLat } from "@waste/domain/map-planning/geo"
import { COPENHAGEN_CENTER } from "@waste/fixtures/positions"

const INITIAL_ZOOM = 11
const FIT_PADDING_PX = 48
const FIT_MAX_ZOOM = 16

/** How a stop stands, as its pin's colour says: still to collect, collected, or not collected. */
export type RouteMapStopState = "open" | "done" | "missed"

/** A place the map draws, in the order the route visits it. */
export type RouteMapPoint =
  | { kind: "stop"; key: string; at: LngLat; number: number; title: string; state: RouteMapStopState }
  | { kind: "depot" | "unloading"; key: string; at: LngLat; title: string }

export type RouteMapCanvasProps = {
  points: readonly RouteMapPoint[]
  /** The active Plan's road, or null to join the places straight and dashed. */
  road: RoadGeometry | null
  baseMap: BaseMapId
  /** What the drawing is of, for a screen reader. */
  label: string
}

const STOP_FILL: Record<RouteMapStopState, string> = {
  open: "var(--primary)",
  done: "var(--success)",
  missed: "var(--destructive)",
}

/** The corners of every place and the road, as one key to refit the camera by, or "" for nothing to frame. */
function frameKeyOf(points: readonly RouteMapPoint[], road: RoadGeometry | null): string {
  const all = [...points.map((point) => point.at), ...(road ? roadPath(road) : [])]
  if (all.length === 0) return ""
  const west = Math.min(...all.map((at) => at.lng))
  const east = Math.max(...all.map((at) => at.lng))
  const south = Math.min(...all.map((at) => at.lat))
  const north = Math.max(...all.map((at) => at.lat))
  return [west, south, east, north].map((n) => n.toFixed(5)).join(",")
}

export function RouteMapCanvas({ points, road, baseMap, label }: RouteMapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { map: mapInstance, styleLoaded, baseMapFailed } = useMapLibre(containerRef, {
    baseMap,
    name: "route-map",
    camera: { center: [COPENHAGEN_CENTER.lng, COPENHAGEN_CENTER.lat], zoom: INITIAL_ZOOM },
  })
  // Before the framing effect below, so the first fit's move is heard.
  const project = useMapProjection(mapInstance)

  // Frame the route whenever what it draws moves; the key keeps a render that rebuilds the same places from refitting.
  const frameKey = frameKeyOf(points, road)
  useEffect(() => {
    if (!mapInstance || frameKey === "") return
    const [west, south, east, north] = frameKey.split(",").map(Number)
    mapInstance.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: FIT_PADDING_PX, duration: styleLoaded.current ? 500 : 0, maxZoom: FIT_MAX_ZOOM },
    )
  }, [frameKey, mapInstance, styleLoaded])

  // The road's path is built once, in world pixels; per frame only the group transform changes.
  const roadData = useMemo(() => (road && road.legs.length > 0 ? roadOverlayPath(roadPath(road)) : null), [road])
  const overlay = roadOverlay(project)
  const anchors = points.map((point) => project(point.at)).filter((at): at is ScreenPoint => at !== null)

  return (
    <div className="relative h-full w-full overflow-hidden bg-muted" data-testid="route-map">
      <div ref={containerRef} className="h-full w-full" />

      {baseMapFailed && (
        <div role="status" className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-md border border-border bg-background/95 px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
          Base map unavailable — the route still stands.
        </div>
      )}

      {mapInstance && (
        <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible" role="img" aria-label={label} data-route-geometry={roadData ? "road" : anchors.length < 2 ? "none" : "straight"}>
          {roadData && overlay ? (
            <g transform={overlay.transform}>
              <path d={roadData} fill="none" stroke="white" strokeWidth={7} strokeOpacity={0.9} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              <path d={roadData} fill="none" stroke="var(--primary)" strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            </g>
          ) : (
            anchors.length >= 2 && (
              <polyline
                points={anchors.map((at) => `${at.x},${at.y}`).join(" ")}
                fill="none"
                stroke="var(--primary)"
                strokeWidth={2.5}
                strokeDasharray="6 6"
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeOpacity={0.85}
              />
            )
          )}
          {/* The bases under the stops, the first stop on top. */}
          {[...points].reverse().map((point) => {
            const at = project(point.at)
            if (!at) return null
            if (point.kind !== "stop") {
              return (
                <g key={point.key} transform={`translate(${at.x} ${at.y})`} data-route-map-place={point.kind}>
                  <title>{point.title}</title>
                  <rect x={-8} y={-8} width={16} height={16} rx={3} fill="var(--foreground)" stroke="white" strokeWidth={2} />
                  <text textAnchor="middle" dominantBaseline="central" fontSize={9} fontWeight={700} fill="var(--background)">
                    {point.kind === "depot" ? "D" : "U"}
                  </text>
                </g>
              )
            }
            return (
              <g key={point.key} transform={`translate(${at.x} ${at.y})`} data-route-map-stop={point.number}>
                <title>{point.title}</title>
                <circle r={10} fill={STOP_FILL[point.state]} stroke="white" strokeWidth={2} />
                <text textAnchor="middle" dominantBaseline="central" fontSize={point.number > 99 ? 8 : 10} fontWeight={700} fill="white">
                  {point.number}
                </text>
              </g>
            )
          })}
        </svg>
      )}
      {road && <RoutingAttribution sources={[road.source]} />}
    </div>
  )
}
