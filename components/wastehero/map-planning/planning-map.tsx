"use client"

// The planning map's base map, markers, and overlays (2026-09-16). MapLibre
// GL over keyless tiles (OpenFreeMap vector styles, Esri imagery for
// satellite); the markers are plain HTML placed with map.project on every
// move, so a badge can carry whatever the design needs (count, fraction dot
// trail, selection ring) and Playwright can read it. Two SVG overlays sit
// above the canvas: the shapes overlay draws the planning-area outlines
// that are switched on and the selection shape (with draggable handles
// while it is being edited), and the draw overlay takes over while a tool
// is active and hands the finished shape back as lng/lat — selection
// resolution stays in the pure lib. Loaded client-only by
// map-planning-view.tsx (next/dynamic).

import {
  Map as MapLibreMap,
  NavigationControl,
  getVersion,
  setWorkerUrl,
  type StyleSpecification,
} from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react"

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { PlanningAreaLayer } from "@/lib/map-planning/areas"
import { baseMapById, type BaseMapId } from "@/lib/map-planning/base-maps"
import { clusterPoints, type MapCluster } from "@/lib/map-planning/clusters"
import { NO_FRACTION_COLOR, SELECTION_COLOR } from "@/lib/map-planning/colors"
import { polygonCentroid, type LngLat, type LngLatBounds } from "@/lib/map-planning/geo"
import type { MapPoint } from "@/lib/map-planning/points"
import { COPENHAGEN_CENTER } from "@/lib/map-planning/positions"
import type { AreaRoute } from "@/lib/map-planning/routes"
import type { SelectionShape } from "@/lib/map-planning/selection"
import { cn } from "@/lib/utils"

export type DrawTool = "none" | "rectangle" | "polygon"

// MapLibre 6 derives its module-worker URL from its own module URL, which
// Turbopack's chunking breaks (the worker never starts, no tile loads). The
// route handler at app/maplibre/[version]/[asset] serves the worker and its
// shared chunk from the installed package; the version stamp keeps the
// immutable cache honest across upgrades.
setWorkerUrl(`/maplibre/${getVersion()}/maplibre-gl-worker.mjs`)

const INITIAL_ZOOM = 12
/** No floor — the whole world is one zoom-out away. */
const MIN_ZOOM = 0
const MAX_ZOOM = 19
/** Past this zoom a cluster click lists its members instead of zooming further. */
const LIST_ZOOM = 16.5
const MAX_TRAIL_DOTS = 6
const CLOSE_POLYGON_PX = 10
const MIN_RECTANGLE_PX = 6
const FIT_PADDING_PX = 48
const FIT_MAX_ZOOM = 16
const FLY_ZOOM = 17

/** What the page can ask the map to do. */
export type PlanningMapApi = {
  fitBounds: (bounds: LngLatBounds) => void
  flyTo: (lngLat: LngLat, zoom?: number) => void
}

export type PlanningMapProps = {
  points: readonly MapPoint[]
  /** Container ids that are selected. */
  selectedIds: ReadonlySet<string>
  drawTool: DrawTool
  colorFor: (fraction: string) => string
  baseMap: BaseMapId
  /** The selection shape to keep on the map, if any. */
  shape: SelectionShape | null
  /** Whether the shape's handles can be dragged. */
  editingShape: boolean
  onShapeChange: (polygon: LngLat[]) => void
  /** Planning-area outlines that are switched on. */
  areaLayers: readonly PlanningAreaLayer[]
  /** Routes to draw as stop-to-stop lines ("See on map", the Routes layer). */
  routeLines: readonly AreaRoute[]
  /** A click on a route line — open its card at that point. */
  onRouteClick: (route: AreaRoute, anchor: { x: number; y: number }) => void
  onDrawComplete: (polygon: LngLat[]) => void
  onDrawCancel: () => void
  onPointClick: (point: MapPoint) => void
  /** A cluster that cannot or should not split further — list its members. */
  onClusterList: (cluster: MapCluster, anchor: { x: number; y: number }) => void
  apiRef?: RefObject<PlanningMapApi | null>
  className?: string
}

type ScreenPoint = { x: number; y: number }

function clusterLabel(cluster: MapCluster, selected: number): string {
  const head = `${cluster.count} container${cluster.count === 1 ? "" : "s"}`
  const fractions = cluster.fractions.length ? ` · ${cluster.fractions.join(", ")}` : ""
  const picked = selected > 0 ? ` · ${selected} selected` : ""
  return `${head}${fractions}${picked}`
}

const styleOf = (baseMap: BaseMapId) => baseMapById(baseMap).style as string | StyleSpecification

export function PlanningMap({
  points,
  selectedIds,
  drawTool,
  colorFor,
  baseMap,
  shape,
  editingShape,
  onShapeChange,
  areaLayers,
  routeLines,
  onRouteClick,
  onDrawComplete,
  onDrawCancel,
  onPointClick,
  onClusterList,
  apiRef,
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

  // MapLibre only runs animation frames once a style has loaded; without a
  // base map (offline, blocked tiles) the camera jumps instead of easing so
  // navigation still works.
  const animationMs = (ms: number) => (loadedRef.current ? ms : 0)

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
      // The draw overlay and the toolbar own double-click; the map keeps scroll and drag.
      doubleClickZoom: false,
    })
    map.addControl(new NavigationControl({ showCompass: false }), "top-right")
    // State flags for tests and debugging: the container says when a style
    // has loaded and when the map is idle (every visible tile drawn).
    const onStyleLoaded = () => {
      loadedRef.current = true
      setBaseMapFailed(false)
      container.dataset.mapLoaded = "true"
    }
    map.on("load", onStyleLoaded)
    map.on("style.load", onStyleLoaded)
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
    if (apiRef) {
      apiRef.current = {
        fitBounds: (bounds) =>
          map.fitBounds(
            [
              [bounds.west, bounds.south],
              [bounds.east, bounds.north],
            ],
            { padding: FIT_PADDING_PX, duration: animationMs(600), maxZoom: FIT_MAX_ZOOM },
          ),
        flyTo: (lngLat, targetZoom = FLY_ZOOM) =>
          map.flyTo({ center: [lngLat.lng, lngLat.lat], zoom: targetZoom, duration: animationMs(800) }),
      }
    }
    setReady(true)
    return () => {
      map.remove()
      mapRef.current = null
      loadedRef.current = false
      if (apiRef) apiRef.current = null
    }
    // The map is created once; base map changes restyle it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const firstStyleRef = useRef(true)
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    // The constructor already loaded the first style.
    if (firstStyleRef.current) {
      firstStyleRef.current = false
      return
    }
    loadedRef.current = false
    setBaseMapFailed(false)
    map.setStyle(styleOf(baseMap))
  }, [baseMap])

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
      duration: animationMs(400),
    })
  }

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
        <ShapesOverlay
          areas={areaLayers}
          routes={routeLines}
          shape={shape}
          editing={editingShape && drawTool === "none"}
          project={project}
          unproject={unproject}
          onShapeChange={onShapeChange}
          onRouteClick={onRouteClick}
        />
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
                        className="pointer-events-auto absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background shadow transition-transform hover:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                      aria-label={clusterLabel(cluster, selectedCount)}
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
                      {cluster.count} container{cluster.count === 1 ? "" : "s"}
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

/* ----------------------------- shapes overlay ----------------------------- */

const toPoints = (screen: readonly ScreenPoint[]) => screen.map((point) => `${point.x},${point.y}`).join(" ")

/**
 * Moves corner `index` of an axis-aligned rectangle (corners in draw order:
 * start, (end.x, start.y), end, (start.x, end.y)) to `next`, keeping the
 * opposite corner where it is.
 */
function moveRectangleCorner(corners: readonly ScreenPoint[], index: number, next: ScreenPoint): ScreenPoint[] {
  const opposite = corners[(index + 2) % 4]
  const moved = [...corners]
  moved[index] = next
  const shareY = { x: opposite.x, y: next.y }
  const shareX = { x: next.x, y: opposite.y }
  moved[(index + 1) % 4] = index % 2 === 0 ? shareY : shareX
  moved[(index + 3) % 4] = index % 2 === 0 ? shareX : shareY
  return moved
}

function ShapesOverlay({
  areas,
  routes,
  shape,
  editing,
  project,
  unproject,
  onShapeChange,
  onRouteClick,
}: {
  areas: readonly PlanningAreaLayer[]
  routes: readonly AreaRoute[]
  shape: SelectionShape | null
  editing: boolean
  project: (lngLat: LngLat) => ScreenPoint | null
  unproject: (screen: ScreenPoint) => LngLat
  onShapeChange: (polygon: LngLat[]) => void
  onRouteClick: (route: AreaRoute, anchor: ScreenPoint) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<{ index: number; screen: ScreenPoint[] } | null>(null)

  const projected = shape
    ? shape.polygon.map(project).filter((point): point is ScreenPoint => point !== null)
    : []
  const screen = drag ? drag.screen : projected

  const local = (event: { clientX: number; clientY: number }): ScreenPoint => {
    const rect = svgRef.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }

  const startDrag = (event: ReactPointerEvent<SVGCircleElement>, index: number) => {
    if (!editing || event.button !== 0) return
    event.stopPropagation()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic pointers have no capture; the handle still follows the moves it gets.
    }
    setDrag({ index, screen: projected })
  }

  const moveDrag = (event: ReactPointerEvent<SVGCircleElement>) => {
    if (!drag || !shape) return
    const next = local(event)
    setDrag((current) => {
      if (!current) return current
      const moved =
        shape.kind === "rectangle" && current.screen.length === 4
          ? moveRectangleCorner(current.screen, current.index, next)
          : current.screen.map((point, index) => (index === current.index ? next : point))
      return { ...current, screen: moved }
    })
  }

  const endDrag = () => {
    if (!drag) return
    onShapeChange(drag.screen.map(unproject))
    setDrag(null)
  }

  return (
    <svg
      ref={svgRef}
      data-testid="planning-map-shapes"
      className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible"
    >
      {areas.map((area) => {
        const outline = area.polygon.map(project).filter((point): point is ScreenPoint => point !== null)
        if (outline.length < 3) return null
        const label = project(polygonCentroid(area.polygon))
        return (
          <g key={area.id} data-area-outline={area.id}>
            <polygon
              points={toPoints(outline)}
              fill={area.color}
              fillOpacity={0.08}
              stroke={area.color}
              strokeWidth={2}
              strokeLinejoin="round"
            />
            {label && (
              <text
                x={label.x}
                y={label.y}
                textAnchor="middle"
                className="text-[11px] font-semibold"
                fill={area.color}
                stroke="white"
                strokeWidth={3}
                paintOrder="stroke"
              >
                {area.name}
              </text>
            )}
          </g>
        )
      })}

      {routes.map((route) => {
        const stops = route.stops.map(project).filter((point): point is ScreenPoint => point !== null)
        if (stops.length === 0) return null
        const open = (event: { clientX: number; clientY: number }) => onRouteClick(route, local(event))
        return (
          <g key={route.id} data-route-line={route.id} data-route-status={route.bucket}>
            {stops.length >= 2 && (
              <polyline
                points={toPoints(stops)}
                fill="none"
                stroke={route.color}
                strokeWidth={3}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeOpacity={0.85}
              />
            )}
            {stops.map((stop, index) => (
              <circle key={index} cx={stop.x} cy={stop.y} r={4} fill="white" stroke={route.color} strokeWidth={2} />
            ))}
            {/* A wide, invisible stroke makes the line easy to hit; it is the interactive element. */}
            <polyline
              points={toPoints(stops.length >= 2 ? stops : [stops[0], stops[0]])}
              fill="none"
              stroke="transparent"
              strokeWidth={14}
              strokeLinejoin="round"
              strokeLinecap="round"
              role="button"
              tabIndex={0}
              aria-label={`Route ${route.name}, ${route.status}`}
              data-route-hit={route.id}
              className="cursor-pointer focus-visible:outline-none"
              style={{ pointerEvents: "stroke" }}
              onClick={open}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return
                event.preventDefault()
                const box = event.currentTarget.getBoundingClientRect()
                open({ clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 })
              }}
            />
            <text
              x={stops[0].x + 8}
              y={stops[0].y - 8}
              className="text-[11px] font-semibold"
              fill={route.color}
              stroke="white"
              strokeWidth={3}
              paintOrder="stroke"
            >
              {route.name}
            </text>
          </g>
        )
      })}

      {shape && screen.length >= 3 && (
        <g data-selection-shape={shape.kind} data-editing={editing ? "true" : undefined}>
          <polygon
            points={toPoints(screen)}
            fill={SELECTION_COLOR}
            fillOpacity={editing ? 0.14 : 0.08}
            stroke={SELECTION_COLOR}
            strokeWidth={2}
            strokeDasharray="6 4"
            strokeLinejoin="round"
          />
          {screen.map((vertex, index) => (
            <circle
              key={index}
              cx={vertex.x}
              cy={vertex.y}
              r={editing ? 7 : 5}
              fill="white"
              stroke={SELECTION_COLOR}
              strokeWidth={2}
              data-shape-handle={index}
              className={cn(editing && "pointer-events-auto cursor-move")}
              onPointerDown={(event) => startDrag(event, index)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={() => setDrag(null)}
            />
          ))}
        </g>
      )}
    </svg>
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

  const local = (event: { clientX: number; clientY: number }): ScreenPoint => {
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
            points={toPoints(path)}
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
