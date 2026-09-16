"use client"

// The planning map's base map and markers (2026-09-16). MapLibre GL over
// OpenFreeMap vector tiles (no API key); the markers are plain HTML placed
// with map.project on every move, so a badge can carry whatever the design
// needs (count, fraction dot trail, selection ring) and Playwright can read
// it. The draw overlay sits above the canvas while a tool is active and
// hands the finished shape back as lng/lat — selection resolution stays in
// the pure lib. Loaded client-only by map-planning-view.tsx (next/dynamic).

import { Map as MapLibreMap, NavigationControl, getVersion, setWorkerUrl } from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react"

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { clusterPoints, type MapCluster } from "@/lib/map-planning/clusters"
import { NO_FRACTION_COLOR, SELECTION_COLOR } from "@/lib/map-planning/colors"
import type { LngLat } from "@/lib/map-planning/geo"
import type { MapPoint } from "@/lib/map-planning/points"
import { COPENHAGEN_CENTER } from "@/lib/map-planning/positions"
import { cn } from "@/lib/utils"

export type DrawTool = "none" | "rectangle" | "polygon"

export type MapTheme = "light" | "dark"

/** OpenFreeMap styles — free vector tiles, no key. */
const STYLE_URLS: Readonly<Record<MapTheme, string>> = {
  light: "https://tiles.openfreemap.org/styles/liberty",
  dark: "https://tiles.openfreemap.org/styles/dark",
}

// MapLibre 6 derives its module-worker URL from its own module URL, which
// Turbopack's chunking breaks (the worker never starts, no tile loads). The
// route handler at app/maplibre/[version]/[asset] serves the worker and its
// shared chunk from the installed package; the version stamp keeps the
// immutable cache honest across upgrades.
setWorkerUrl(`/maplibre/${getVersion()}/maplibre-gl-worker.mjs`)

const INITIAL_ZOOM = 12
const MIN_ZOOM = 9
const MAX_ZOOM = 19
/** Past this zoom a cluster click lists its members instead of zooming further. */
const LIST_ZOOM = 16.5
const MAX_TRAIL_DOTS = 6
const CLOSE_POLYGON_PX = 10
const MIN_RECTANGLE_PX = 6

export type PlanningMapProps = {
  points: readonly MapPoint[]
  /** Point ids (container ids, or property point ids) that are selected. */
  selectedIds: ReadonlySet<string>
  drawTool: DrawTool
  colorFor: (fraction: string) => string
  theme: MapTheme
  onDrawComplete: (polygon: LngLat[]) => void
  onDrawCancel: () => void
  onPointClick: (point: MapPoint) => void
  /** A cluster that cannot or should not split further — list its members. */
  onClusterList: (cluster: MapCluster, anchor: { x: number; y: number }) => void
  className?: string
}

type ScreenPoint = { x: number; y: number }

function clusterLabel(cluster: MapCluster, kindLabel: string, selected: number): string {
  const head = `${cluster.count} ${kindLabel}${cluster.count === 1 ? "" : "s"}`
  const fractions = cluster.fractions.length ? ` · ${cluster.fractions.join(", ")}` : ""
  const picked = selected > 0 ? ` · ${selected} selected` : ""
  return `${head}${fractions}${picked}`
}

export function PlanningMap({
  points,
  selectedIds,
  drawTool,
  colorFor,
  theme,
  onDrawComplete,
  onDrawCancel,
  onPointClick,
  onClusterList,
  className,
}: PlanningMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const loadedRef = useRef(false)
  const [ready, setReady] = useState(false)
  const [zoom, setZoom] = useState(INITIAL_ZOOM)
  // Bumped on every camera change so marker positions re-project.
  const [, setFrame] = useState(0)
  const [baseMapFailed, setBaseMapFailed] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container || mapRef.current) return
    const map = new MapLibreMap({
      container,
      style: STYLE_URLS[theme],
      center: [COPENHAGEN_CENTER.lng, COPENHAGEN_CENTER.lat],
      zoom: INITIAL_ZOOM,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      attributionControl: { compact: true },
      // The draw overlay and the toolbar own double-click; the map keeps scroll and drag.
      doubleClickZoom: false,
    })
    map.addControl(new NavigationControl({ showCompass: false }), "top-right")
    // State flags for tests and debugging: the container says when the style
    // has loaded and when the map is idle (every visible tile drawn).
    map.on("load", () => {
      loadedRef.current = true
      setBaseMapFailed(false)
      container.dataset.mapLoaded = "true"
    })
    map.on("idle", () => {
      container.dataset.mapIdle = "true"
    })
    map.on("dataloading", () => {
      delete container.dataset.mapIdle
    })
    map.on("error", (event) => {
      // Tile misses after load are cosmetic; a failure before the style
      // arrives means no base map at all — say so, the markers still stand.
      console.warn("[planning-map]", event.error?.message ?? event)
      if (!loadedRef.current) setBaseMapFailed(true)
    })
    ;(container as HTMLDivElement & { __planningMap?: MapLibreMap }).__planningMap = map
    const onMove = () => {
      setZoom(map.getZoom())
      setFrame((frame) => frame + 1)
    }
    map.on("move", onMove)
    map.on("resize", onMove)
    mapRef.current = map
    setReady(true)
    return () => {
      map.remove()
      mapRef.current = null
      loadedRef.current = false
    }
    // The map is created once; theme changes restyle it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    loadedRef.current = false
    map.setStyle(STYLE_URLS[theme])
  }, [theme])

  // Cluster at half-zoom steps so a slow pan does not re-cluster every frame.
  const clusterZoom = Math.round(zoom * 2) / 2
  const clusters = useMemo(() => clusterPoints(points, clusterZoom), [points, clusterZoom])

  const project = useCallback((lngLat: LngLat): ScreenPoint | null => {
    const map = mapRef.current
    if (!map) return null
    const point = map.project([lngLat.lng, lngLat.lat])
    return { x: point.x, y: point.y }
  }, [])

  const unproject = useCallback((screen: ScreenPoint): LngLat => {
    const map = mapRef.current
    if (!map) return COPENHAGEN_CENTER
    const lngLat = map.unproject([screen.x, screen.y])
    return { lng: lngLat.lng, lat: lngLat.lat }
  }, [])

  const handleClusterClick = (cluster: MapCluster, anchor: ScreenPoint) => {
    const map = mapRef.current
    if (!map) return
    if (cluster.singleLocation || zoom >= LIST_ZOOM) {
      onClusterList(cluster, anchor)
      return
    }
    map.easeTo({
      center: [cluster.lngLat.lng, cluster.lngLat.lat],
      zoom: Math.min(MAX_ZOOM, zoom + 2),
      duration: 400,
    })
  }

  const kindLabel = points[0]?.kind === "property" ? "propert" : "container"
  const pluralKind = (count: number) =>
    kindLabel === "propert" ? (count === 1 ? "property" : "properties") : count === 1 ? "container" : "containers"

  return (
    <div className={cn("relative h-full w-full overflow-hidden bg-muted", className)}>
      {/* MapLibre's own stylesheet pins .maplibregl-map to position: relative (unlayered,
          so it beats Tailwind utilities) — size the container by percentage, not inset. */}
      <div ref={containerRef} className="h-full w-full" data-testid="planning-map-canvas" />

      {baseMapFailed && (
        <div
          role="status"
          className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-md border border-border bg-background/95 px-3 py-1.5 text-xs text-muted-foreground shadow-sm"
        >
          Base map unavailable — markers still reflect the registry.
        </div>
      )}

      {ready && (
        <TooltipProvider delayDuration={200}>
          <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" data-testid="planning-map-markers">
            {clusters.map((cluster) => {
              const anchor = project(cluster.lngLat)
              if (!anchor) return null
              const selectedCount = cluster.points.filter((point) => selectedIds.has(point.id)).length
              if (cluster.count === 1) {
                const point = cluster.points[0]
                const selected = selectedIds.has(point.id)
                const color = point.fractions[0] ? colorFor(point.fractions[0]) : NO_FRACTION_COLOR
                const label = [point.label, point.fractions.join(", "), point.sublabel]
                  .filter(Boolean)
                  .join(" · ")
                return (
                  <Tooltip key={cluster.id}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={label}
                        aria-pressed={selected}
                        data-marker="point"
                        data-selected={selected ? "true" : undefined}
                        onClick={() => onPointClick(point)}
                        className={cn(
                          "pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 border-2 border-background shadow transition-transform hover:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          point.kind === "property" ? "size-4 rounded-md" : "size-3.5 rounded-full",
                        )}
                        style={{
                          left: anchor.x,
                          top: anchor.y,
                          backgroundColor: color,
                          boxShadow: selected ? `0 0 0 3px ${SELECTION_COLOR}` : undefined,
                        }}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs text-xs">
                      <p className="font-medium">{point.label}</p>
                      {point.fractions.length > 0 && <p>{point.fractions.join(" · ")}</p>}
                      <p className="text-muted-foreground">{point.sublabel}</p>
                    </TooltipContent>
                  </Tooltip>
                )
              }
              const trail = cluster.fractions.slice(0, MAX_TRAIL_DOTS)
              const overflow = cluster.fractions.length - trail.length
              return (
                <Tooltip key={cluster.id}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={clusterLabel(cluster, kindLabel === "propert" ? "propert" : "container", selectedCount).replace(
                        /propert(s?)/,
                        (_, s: string) => (s ? "properties" : "property"),
                      )}
                      data-marker="cluster"
                      data-count={cluster.count}
                      data-selected={selectedCount > 0 ? "true" : undefined}
                      onClick={() => handleClusterClick(cluster, anchor)}
                      className="pointer-events-auto absolute flex -translate-y-1/2 items-center focus-visible:outline-none"
                      style={{ left: anchor.x - 16, top: anchor.y }}
                    >
                      <span
                        className="flex size-8 items-center justify-center rounded-full border border-border bg-background text-xs font-semibold text-foreground shadow-sm"
                        style={{
                          boxShadow:
                            selectedCount > 0 ? `0 0 0 3px ${SELECTION_COLOR}` : undefined,
                        }}
                      >
                        {cluster.count}
                      </span>
                      {trail.length > 0 && (
                        <span className="-ml-1 flex items-center">
                          {trail.map((fraction, index) => (
                            <span
                              key={fraction}
                              className="size-3.5 rounded-full border-2 border-background"
                              style={{
                                backgroundColor: colorFor(fraction),
                                marginLeft: index === 0 ? 0 : -4,
                              }}
                            />
                          ))}
                          {overflow > 0 && (
                            <span className="ml-0.5 rounded-full bg-background px-1 text-[10px] font-medium text-muted-foreground shadow-sm">
                              +{overflow}
                            </span>
                          )}
                        </span>
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs text-xs">
                    <p className="font-medium">
                      {cluster.count} {pluralKind(cluster.count)}
                      {selectedCount > 0 ? ` · ${selectedCount} selected` : ""}
                    </p>
                    {cluster.fractions.length > 0 && (
                      <p className="text-muted-foreground">{cluster.fractions.join(" · ")}</p>
                    )}
                    <p className="text-muted-foreground">
                      {cluster.singleLocation ? "One address — click to list" : "Click to zoom in"}
                    </p>
                  </TooltipContent>
                </Tooltip>
              )
            })}
          </div>
        </TooltipProvider>
      )}

      {ready && drawTool !== "none" && (
        <DrawOverlay
          tool={drawTool}
          unproject={unproject}
          onComplete={onDrawComplete}
          onCancel={onDrawCancel}
        />
      )}
    </div>
  )
}

/* ------------------------------ draw overlay ------------------------------ */

function DrawOverlay({
  tool,
  unproject,
  onComplete,
  onCancel,
}: {
  tool: Exclude<DrawTool, "none">
  unproject: (screen: ScreenPoint) => LngLat
  onComplete: (polygon: LngLat[]) => void
  onCancel: () => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [start, setStart] = useState<ScreenPoint | null>(null)
  const [cursor, setCursor] = useState<ScreenPoint | null>(null)
  const [vertices, setVertices] = useState<ScreenPoint[]>([])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel()
      if (event.key === "Enter" && tool === "polygon" && vertices.length >= 3) {
        onComplete(vertices.map(unproject))
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onCancel, onComplete, tool, unproject, vertices])

  const local = (event: ReactPointerEvent): ScreenPoint => {
    const rect = svgRef.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return
    const point = local(event)
    if (tool === "rectangle") {
      setStart(point)
      setCursor(point)
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic pointers (tests, assistive tech) have no capture; the
        // overlay covers the map anyway.
      }
      return
    }
    const first = vertices[0]
    if (
      first &&
      vertices.length >= 3 &&
      Math.hypot(first.x - point.x, first.y - point.y) <= CLOSE_POLYGON_PX
    ) {
      onComplete(vertices.map(unproject))
      return
    }
    setVertices((current) => [...current, point])
  }

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    setCursor(local(event))
  }

  const handlePointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (tool !== "rectangle" || !start) return
    const end = local(event)
    setStart(null)
    if (Math.abs(end.x - start.x) < MIN_RECTANGLE_PX || Math.abs(end.y - start.y) < MIN_RECTANGLE_PX) {
      return
    }
    const corners: ScreenPoint[] = [
      { x: start.x, y: start.y },
      { x: end.x, y: start.y },
      { x: end.x, y: end.y },
      { x: start.x, y: end.y },
    ]
    onComplete(corners.map(unproject))
  }

  const handleDoubleClick = () => {
    if (tool === "polygon" && vertices.length >= 3) onComplete(vertices.map(unproject))
  }

  const rectangle =
    tool === "rectangle" && start && cursor
      ? {
          x: Math.min(start.x, cursor.x),
          y: Math.min(start.y, cursor.y),
          width: Math.abs(cursor.x - start.x),
          height: Math.abs(cursor.y - start.y),
        }
      : null
  const path = [...vertices, ...(cursor && tool === "polygon" ? [cursor] : [])]

  return (
    <svg
      ref={svgRef}
      role="application"
      aria-label={tool === "rectangle" ? "Drag a rectangle over the map" : "Click to add polygon corners; double-click or press Enter to finish"}
      data-testid="planning-map-draw"
      className="absolute inset-0 z-20 h-full w-full cursor-crosshair touch-none select-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={handleDoubleClick}
    >
      {rectangle && (
        <rect
          {...rectangle}
          fill={SELECTION_COLOR}
          fillOpacity={0.12}
          stroke={SELECTION_COLOR}
          strokeWidth={2}
          strokeDasharray="6 4"
        />
      )}
      {tool === "polygon" && path.length > 0 && (
        <>
          <polygon
            points={path.map((point) => `${point.x},${point.y}`).join(" ")}
            fill={SELECTION_COLOR}
            fillOpacity={0.1}
            stroke={SELECTION_COLOR}
            strokeWidth={2}
            strokeDasharray="6 4"
          />
          {vertices.map((vertex, index) => (
            <circle
              key={`${vertex.x}-${vertex.y}-${index}`}
              cx={vertex.x}
              cy={vertex.y}
              r={index === 0 ? 6 : 4}
              fill="white"
              stroke={SELECTION_COLOR}
              strokeWidth={2}
            />
          ))}
        </>
      )}
      <text x={12} y={20} className="fill-foreground text-[11px] font-medium">
        {tool === "rectangle"
          ? "Drag to select · Esc to cancel"
          : vertices.length < 3
            ? "Click to add corners · Esc to cancel"
            : "Double-click, press Enter, or click the first corner to finish"}
      </text>
    </svg>
  )
}
