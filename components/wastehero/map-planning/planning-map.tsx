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
import { Truck } from "@phosphor-icons/react/dist/ssr"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react"

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { PlanningAreaLayer } from "@/lib/map-planning/areas"
import { baseMapById, type BaseMapId } from "@/lib/map-planning/base-maps"
import { clusterPoints, type MapCluster } from "@/lib/map-planning/clusters"
import { NO_FRACTION_COLOR, SELECTION_COLOR } from "@/lib/map-planning/colors"
import { UNCOVERED_COLOR } from "@/lib/map-planning/coverage-gaps"
import { COMPARE_COLORS, clusterMembership, type CompareMembership } from "@/lib/map-planning/scheme-compare"
import { polygonCentroid, worldPoint, type LngLat, type LngLatBounds } from "@/lib/map-planning/geo"
import type { MapPoint } from "@/lib/map-planning/points"
import { COPENHAGEN_CENTER } from "@/lib/map-planning/positions"
import { chevronsAlong, localPathData, roadPath } from "@/lib/map-planning/road-geometry"
import type { AreaRoute } from "@/lib/map-planning/routes"
import type { SelectionShape } from "@/lib/map-planning/selection"
import type { ServiceAreaLayer } from "@/lib/map-planning/service-areas"
import { cn } from "@/lib/utils"

import type { RoadGeometryState } from "./use-road-geometries"

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
/** Road paths are built once in world pixels at this zoom and moved by one group transform. */
const ROAD_REF_ZOOM = 16
/** A second fixed point: its screen distance from the centre gives the live scale. */
const ROAD_PROBE: LngLat = { lng: COPENHAGEN_CENTER.lng + 0.01, lat: COPENHAGEN_CENTER.lat }
const ROAD_PROBE_WORLD_DX = worldPoint(ROAD_PROBE, ROAD_REF_ZOOM).x - worldPoint(COPENHAGEN_CENTER, ROAD_REF_ZOOM).x
const CHEVRON_SPACING_PX = 140
/** Direction chevrons only once streets are legible — at city zoom they read as gaps in the line. */
const CHEVRON_MIN_SCALE = 2 ** (14 - ROAD_REF_ZOOM)

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
  /** Drawn service-area boundaries that are switched on. */
  serviceAreaLayers: readonly ServiceAreaLayer[]
  /** Routes to draw as stop-to-stop lines ("See on map", the Routes layer). */
  routeLines: readonly AreaRoute[]
  /** The road through each drawn route's stops, by route id — a pending or refused road draws straight and dashed. */
  roadGeometries: ReadonlyMap<string, RoadGeometryState>
  /** A click on a route line — open its card at that point. */
  onRouteClick: (route: AreaRoute, anchor: { x: number; y: number }) => void
  /** A route being replayed: the vehicle's position and the path driven so far. */
  playback: RoutePlayback | null
  /** Containers no Route Scheme lists — ringed red, counted on clusters; null when the layer is off. */
  uncoveredIds: ReadonlySet<string> | null
  /** Two schemes compared: markers take their side's colour, the rest fade; the hull of both is outlined. */
  compare: SchemeCompareLayer | null
  /** Container ids the panel is pointing at — their markers stand out. */
  highlightedIds: ReadonlySet<string>
  /** The route the panel is pointing at — its line stands out, the others fade. */
  highlightedRouteId: string | null
  /** The pointer rests on a marker (its containers) or left one (null). */
  onHoverPoint: (containerIds: readonly string[] | null) => void
  /** The pointer rests on a route line or left one (null). */
  onHoverRoute: (routeId: string | null) => void
  onDrawComplete: (polygon: LngLat[]) => void
  onDrawCancel: () => void
  onPointClick: (point: MapPoint) => void
  /** A cluster that cannot or should not split further — list its members. */
  onClusterList: (cluster: MapCluster, anchor: { x: number; y: number }) => void
  apiRef?: RefObject<PlanningMapApi | null>
  className?: string
}

type ScreenPoint = { x: number; y: number }

export type SchemeCompareLayer = {
  membership: ReadonlyMap<string, CompareMembership>
  hull: readonly LngLat[]
}

export type RoutePlayback = {
  routeId: string
  color: string
  position: LngLat
  travelled: readonly LngLat[]
}

function clusterLabel(cluster: MapCluster, selected: number): string {
  const head = `${cluster.count} container${cluster.count === 1 ? "" : "s"}`
  const fractions = cluster.fractions.length ? ` · ${cluster.fractions.join(", ")}` : ""
  const picked = selected > 0 ? ` · ${selected} selected` : ""
  return `${head}${fractions}${picked}`
}

const styleOf = (baseMap: BaseMapId) => baseMapById(baseMap).style as string | StyleSpecification

/**
 * The selection ring (amber), outside it the highlight ring (foreground), and
 * outermost the coverage-gap ring (red) a marker wears.
 */
function markerRing(selected: boolean, highlighted: boolean, uncovered = false): string | undefined {
  const rings: string[] = []
  let radius = 0
  if (selected) rings.push(`0 0 0 ${(radius += 3)}px ${SELECTION_COLOR}`)
  if (highlighted) rings.push(`0 0 0 ${(radius += 3)}px var(--foreground)`)
  if (uncovered) rings.push(`0 0 0 ${(radius += 2.5)}px ${UNCOVERED_COLOR}`)
  return rings.length ? rings.join(", ") : undefined
}

const COMPARE_LABELS: Readonly<Record<CompareMembership, string>> = {
  a: "In scheme A",
  b: "In scheme B",
  both: "In both schemes",
}

/** How many of a cluster's containers sit on each side, sides present only, A then B then both. */
function compareSides(
  containerIds: readonly string[],
  membership: ReadonlyMap<string, CompareMembership>,
): Array<[CompareMembership, number]> {
  const counts: Record<CompareMembership, number> = { a: 0, b: 0, both: 0 }
  for (const id of containerIds) {
    const side = membership.get(id)
    if (side) counts[side] += 1
  }
  return (["a", "b", "both"] as const).filter((side) => counts[side] > 0).map((side) => [side, counts[side]])
}

const countUncovered = (points: readonly MapPoint[], uncoveredIds: ReadonlySet<string> | null) =>
  uncoveredIds ? points.filter((point) => point.containerIds.some((id) => uncoveredIds.has(id))).length : 0

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
  serviceAreaLayers,
  routeLines,
  roadGeometries,
  onRouteClick,
  playback,
  uncoveredIds,
  compare,
  highlightedIds,
  highlightedRouteId,
  onHoverPoint,
  onHoverRoute,
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
      // A planning map stays north-up and flat: the road overlay moves with
      // one translate-and-scale transform, which assumes no rotation or pitch.
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    })
    map.touchZoomRotate.disableRotation()
    map.keyboard.disableRotation()
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
          serviceAreas={serviceAreaLayers}
          routes={routeLines}
          roadGeometries={roadGeometries}
          playback={playback}
          compareHull={compare?.hull ?? null}
          shape={shape}
          editing={editingShape && drawTool === "none"}
          project={project}
          unproject={unproject}
          onShapeChange={onShapeChange}
          onRouteClick={onRouteClick}
          highlightedRouteId={highlightedRouteId}
          onHoverRoute={onHoverRoute}
        />
      )}

      {ready && (
        <TooltipProvider delayDuration={200}>
          <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" data-testid="planning-map-markers">
            {clusters.map((cluster) => {
              const anchor = project(cluster.lngLat)
              if (!anchor) return null
              const selectedCount = cluster.points.filter((point) => selectedIds.has(point.id)).length
              const uncoveredCount = countUncovered(cluster.points, uncoveredIds)
              if (cluster.count === 1) {
                const point = cluster.points[0]
                const selected = selectedIds.has(point.id)
                const highlighted = highlightedIds.has(point.id)
                const uncovered = countUncovered(cluster.points, uncoveredIds) > 0
                const side = compare ? clusterMembership(point.containerIds, compare.membership) : null
                const color = side
                  ? COMPARE_COLORS[side]
                  : point.fractions[0]
                    ? colorFor(point.fractions[0])
                    : NO_FRACTION_COLOR
                const label = [
                  point.label,
                  point.fractions.join(", "),
                  point.sublabel,
                  uncovered ? "In no route scheme" : "",
                  side ? COMPARE_LABELS[side] : "",
                ]
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
                        data-highlighted={highlighted ? "true" : undefined}
                        data-uncovered={uncovered ? "true" : undefined}
                        data-compare={side ?? undefined}
                        onClick={() => onPointClick(point)}
                        onMouseEnter={() => onHoverPoint(point.containerIds)}
                        onMouseLeave={() => onHoverPoint(null)}
                        className={cn(
                          "pointer-events-auto absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background shadow transition-transform hover:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          highlighted && "z-10 scale-150",
                          compare && !side && !uncovered && "opacity-40",
                        )}
                        style={{
                          left: anchor.x,
                          top: anchor.y,
                          backgroundColor: color,
                          boxShadow: markerRing(selected, highlighted, uncovered),
                        }}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs text-xs">
                      <p className="font-medium">{point.label}</p>
                      {point.fractions.length > 0 && <p>{point.fractions.join(" · ")}</p>}
                      <p className="text-muted-foreground">{point.sublabel}</p>
                      {uncovered && <p style={{ color: UNCOVERED_COLOR }}>In no route scheme</p>}
                      {side && <p style={{ color: COMPARE_COLORS[side] }}>{COMPARE_LABELS[side]}</p>}
                    </TooltipContent>
                  </Tooltip>
                )
              }
              const clusterIds = cluster.points.flatMap((point) => point.containerIds)
              const clusterSide = compare ? clusterMembership(clusterIds, compare.membership) : null
              const sides = compare ? compareSides(clusterIds, compare.membership) : []
              // In compare mode the fraction trail gives way to the sides present.
              const trail = compare ? [] : cluster.fractions.slice(0, MAX_TRAIL_DOTS)
              const overflow = compare ? 0 : cluster.fractions.length - trail.length
              const highlightedCount = cluster.points.filter((point) => highlightedIds.has(point.id)).length
              return (
                <Tooltip key={cluster.id}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={clusterLabel(cluster, selectedCount)}
                      data-marker="cluster"
                      data-count={cluster.count}
                      data-selected={selectedCount > 0 ? "true" : undefined}
                      data-highlighted={highlightedCount > 0 ? "true" : undefined}
                      data-compare={clusterSide ?? undefined}
                      onClick={() => handleClusterClick(cluster, anchor)}
                      onMouseEnter={() => onHoverPoint(cluster.points.flatMap((point) => point.containerIds))}
                      onMouseLeave={() => onHoverPoint(null)}
                      className={cn(
                        "pointer-events-auto absolute flex -translate-y-1/2 items-center focus-visible:outline-none",
                        highlightedCount > 0 && "z-10",
                        compare && !clusterSide && uncoveredCount === 0 && "opacity-40",
                      )}
                      style={{ left: anchor.x - 16, top: anchor.y }}
                    >
                      <span
                        className="relative flex size-8 items-center justify-center rounded-full border border-border bg-background text-xs font-semibold text-foreground shadow-sm"
                        style={{
                          boxShadow: markerRing(selectedCount > 0, highlightedCount > 0),
                          ...(clusterSide ? { borderColor: COMPARE_COLORS[clusterSide], borderWidth: 2 } : {}),
                        }}
                      >
                        {cluster.count}
                        {uncoveredCount > 0 && (
                          <span
                            className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none text-white"
                            style={{ backgroundColor: UNCOVERED_COLOR }}
                            data-uncovered-count={uncoveredCount}
                          >
                            {uncoveredCount}
                          </span>
                        )}
                      </span>
                      {sides.length > 0 && (
                        <span className="-ml-1 flex items-center">
                          {sides.map(([side, count], index) => (
                            <span
                              key={side}
                              className="flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-background px-1 text-[9px] font-semibold leading-none text-white"
                              style={{ backgroundColor: COMPARE_COLORS[side], marginLeft: index === 0 ? 0 : -3 }}
                              data-compare-count={side}
                            >
                              {count}
                            </span>
                          ))}
                        </span>
                      )}
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
            {playback && (() => {
              const anchor = project(playback.position)
              if (!anchor) return null
              return (
                <div
                  data-testid="playback-vehicle"
                  aria-hidden
                  className="absolute z-20 -translate-x-1/2 -translate-y-1/2"
                  style={{ left: anchor.x, top: anchor.y }}
                >
                  <span
                    className="flex size-8 items-center justify-center rounded-full border-2 border-background text-white shadow-md"
                    style={{ backgroundColor: playback.color }}
                  >
                    <Truck className="h-4 w-4" weight="fill" />
                  </span>
                </div>
              )
            })()}
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
  serviceAreas,
  routes,
  roadGeometries,
  playback,
  compareHull,
  shape,
  editing,
  project,
  unproject,
  onShapeChange,
  onRouteClick,
  highlightedRouteId,
  onHoverRoute,
}: {
  areas: readonly PlanningAreaLayer[]
  serviceAreas: readonly ServiceAreaLayer[]
  routes: readonly AreaRoute[]
  roadGeometries: ReadonlyMap<string, RoadGeometryState>
  playback: RoutePlayback | null
  compareHull: readonly LngLat[] | null
  shape: SelectionShape | null
  editing: boolean
  project: (lngLat: LngLat) => ScreenPoint | null
  unproject: (screen: ScreenPoint) => LngLat
  onShapeChange: (polygon: LngLat[]) => void
  onRouteClick: (route: AreaRoute, anchor: ScreenPoint) => void
  highlightedRouteId: string | null
  onHoverRoute: (routeId: string | null) => void
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<{ index: number; screen: ScreenPoint[] } | null>(null)

  const projected = shape
    ? shape.polygon.map(project).filter((point): point is ScreenPoint => point !== null)
    : []
  const screen = drag ? drag.screen : projected

  // Road paths are built once, in world pixels at ROAD_REF_ZOOM relative to
  // the city centre; per frame only the group transform below changes.
  const roadPaths = useMemo(() => {
    const paths = new Map<string, string>()
    for (const route of routes) {
      const state = roadGeometries.get(route.id)
      if (state?.status === "ready" && state.geometry.legs.length > 0) {
        paths.set(route.id, localPathData(roadPath(state.geometry), ROAD_REF_ZOOM, COPENHAGEN_CENTER))
      }
    }
    return paths
  }, [roadGeometries, routes])
  const originScreen = project(COPENHAGEN_CENTER)
  const probeScreen = project(ROAD_PROBE)
  const roadScale = originScreen && probeScreen ? (probeScreen.x - originScreen.x) / ROAD_PROBE_WORLD_DX : null
  const roadTransform =
    originScreen && roadScale !== null ? `translate(${originScreen.x} ${originScreen.y}) scale(${roadScale})` : null
  const showChevrons = roadScale !== null && roadScale >= CHEVRON_MIN_SCALE

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

      {serviceAreas.map((area) => {
        const outline = area.polygon.map(project).filter((point): point is ScreenPoint => point !== null)
        if (outline.length < 3) return null
        const label = project(polygonCentroid(area.polygon))
        return (
          <g key={area.id} data-service-area-outline={area.id}>
            <polygon
              points={toPoints(outline)}
              fill={area.color}
              fillOpacity={0.06}
              stroke={area.color}
              strokeWidth={2.5}
              strokeDasharray="10 5"
              strokeLinejoin="round"
            />
            {label && (
              <text
                x={label.x}
                y={label.y + 14}
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

      {compareHull && compareHull.length >= 3 && (() => {
        const outline = compareHull.map(project).filter((point): point is ScreenPoint => point !== null)
        return outline.length >= 3 ? (
          <polygon
            data-compare-hull=""
            points={toPoints(outline)}
            fill={COMPARE_COLORS.both}
            fillOpacity={0.04}
            stroke={COMPARE_COLORS.both}
            strokeOpacity={0.6}
            strokeWidth={1.5}
            strokeDasharray="4 4"
            strokeLinejoin="round"
          />
        ) : null
      })()}

      {/* The highlighted route is drawn last so it sits on top of the others. */}
      {[...routes]
        .sort((a, b) => Number(a.id === highlightedRouteId) - Number(b.id === highlightedRouteId))
        .map((route) => {
          const state = roadGeometries.get(route.id)
          const road = state?.status === "ready" && state.geometry.legs.length > 0 ? state.geometry : null
          const anchors = (road ? road.snappedStops : route.stops.map((stop) => stop.lngLat))
            .map(project)
            .filter((point): point is ScreenPoint => point !== null)
          if (anchors.length === 0) return null
          const open = (event: { clientX: number; clientY: number }) => onRouteClick(route, local(event))
          const highlighted = highlightedRouteId === route.id
          const faded = highlightedRouteId !== null && !highlighted
          const width = highlighted ? 5 : 3.5
          const roadData = road && roadTransform ? roadPaths.get(route.id) : undefined
          // A replayed route shows the road ahead faint and the road driven in full colour.
          const replaying = playback?.routeId === route.id
          const travelledScreen = replaying && !roadData
            ? playback.travelled.map(project).filter((point): point is ScreenPoint => point !== null)
            : []
          const straight = toPoints(anchors.length >= 2 ? anchors : [anchors[0], anchors[0]])
          const chevrons =
            highlighted && road && showChevrons
              ? chevronsAlong(
                  roadPath(road)
                    .map(project)
                    .filter((point): point is ScreenPoint => point !== null),
                  CHEVRON_SPACING_PX,
                )
              : []
          // A wide, invisible stroke makes the line easy to hit; it is the interactive element.
          const hitProps = {
            fill: "none",
            stroke: "transparent",
            strokeWidth: 14,
            strokeLinejoin: "round" as const,
            strokeLinecap: "round" as const,
            role: "button",
            tabIndex: 0,
            "aria-label": `Route ${route.name}, ${route.status}`,
            "data-route-hit": route.id,
            className: "cursor-pointer focus-visible:outline-none",
            style: { pointerEvents: "stroke" as const },
            onClick: open,
            onMouseEnter: () => onHoverRoute(route.id),
            onMouseLeave: () => onHoverRoute(null),
            onFocus: () => onHoverRoute(route.id),
            onBlur: () => onHoverRoute(null),
            onKeyDown: (event: ReactKeyboardEvent<SVGElement>) => {
              if (event.key !== "Enter" && event.key !== " ") return
              event.preventDefault()
              const box = event.currentTarget.getBoundingClientRect()
              open({ clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 })
            },
          }
          return (
            <g
              key={route.id}
              data-route-line={route.id}
              data-route-status={route.bucket}
              data-route-geometry={roadData ? "road" : state?.status === "failed" ? "straight" : "pending"}
              data-highlighted={highlighted ? "true" : undefined}
              opacity={faded ? 0.3 : 1}
            >
              {roadData ? (
                <g transform={roadTransform ?? undefined}>
                  {/* A white casing under the coloured road so it reads on any base map. */}
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
                    data-route-road={route.id}
                    fill="none"
                    stroke={route.color}
                    strokeWidth={width}
                    strokeOpacity={replaying ? 0.3 : 1}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                  {replaying && (
                    <path
                      d={localPathData(playback.travelled, ROAD_REF_ZOOM, COPENHAGEN_CENTER)}
                      data-route-travelled={route.id}
                      fill="none"
                      stroke={route.color}
                      strokeWidth={width + 0.5}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                </g>
              ) : (
                anchors.length >= 2 && (
                  /* No road yet, or none to be had: the stops joined straight, dashed to say so. */
                  <polyline
                    points={straight}
                    fill="none"
                    stroke={route.color}
                    strokeWidth={highlighted ? 4 : 2.5}
                    strokeDasharray="6 6"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    strokeOpacity={replaying ? 0.3 : 0.85}
                  />
                )
              )}
              {replaying && travelledScreen.length >= 2 && (
                <polyline
                  points={toPoints(travelledScreen)}
                  data-route-travelled={route.id}
                  fill="none"
                  stroke={route.color}
                  strokeWidth={3}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              )}
              {chevrons.map((chevron, index) => (
                <path
                  key={index}
                  d="M-3.5 -3 L0 0 L-3.5 3"
                  fill="none"
                  stroke="white"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  transform={`translate(${chevron.x} ${chevron.y}) rotate(${chevron.angle})`}
                />
              ))}
              {anchors.map((stop, index) => (
                <circle
                  key={index}
                  cx={stop.x}
                  cy={stop.y}
                  r={highlighted ? 5 : 4}
                  fill="white"
                  stroke={route.color}
                  strokeWidth={2}
                />
              ))}
              {roadData ? (
                <g transform={roadTransform ?? undefined}>
                  <path d={roadData} vectorEffect="non-scaling-stroke" {...hitProps} />
                </g>
              ) : (
                <polyline points={straight} {...hitProps} />
              )}
              <text
                x={anchors[0].x + 8}
                y={anchors[0].y - 8}
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
