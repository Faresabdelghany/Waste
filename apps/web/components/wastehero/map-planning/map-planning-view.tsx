"use client"

// Map Planning (2026-09-16): the Plan workspace's page. The container
// registry as clustered markers over a real base map, searched by address
// or id, filtered by the shared filter popover and a collection window,
// selected with a rectangle or polygon that stays on the map and can be
// edited, summed up in the Selected area panel, and handed to the Guided
// Setup wizard as a Route Scheme draft. The Layers control picks the base
// map, switches planning-area outlines on, and draws every dated route in
// the collection window, coloured by status and clickable for its card.
// Every number on screen derives from live records at render time; the page
// stores nothing but the base map choice in the browser. Rendered by
// BusinessWorkspace for plan.map-planning.

import dynamic from "next/dynamic"
import Link from "next/link"
import { useTheme } from "next-themes"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowSquareOut, Play, Polygon, Selection, Trash, X } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { useAssetManagementStore } from "@/components/settings/asset-management-store"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ContainerDetailsSheet } from "@/components/wastehero/containers-assets-register"
import { SchemeWizard } from "@/components/wastehero/scheme-wizard/scheme-wizard"
import {
  applyBusinessFilters,
  businessFilterChips,
  emptyBusinessFilters,
  type BusinessFilters,
} from "@/lib/data/business-filters"
import type { BusinessRecord, ModuleDefinition } from "@/lib/data/business-modules"
import { isSoftDeleted } from "@/lib/data/record-visibility"
import { planningAreaLayers, type PlanningAreaLayer } from "@/lib/map-planning/areas"
import {
  BASE_MAP_STORAGE_KEY,
  defaultBaseMapForTheme,
  isBaseMapId,
  type BaseMapId,
} from "@/lib/map-planning/base-maps"
import type { MapCluster } from "@/lib/map-planning/clusters"
import { fractionColor } from "@/lib/map-planning/colors"
import { serviceAreasForSelection } from "@/lib/map-planning/coverage"
import { UNCOVERED_COLOR, coverageGaps, coverageInSelection } from "@/lib/map-planning/coverage-gaps"
import { COMPARE_COLORS, compareSchemes, schemeStopSets } from "@/lib/map-planning/scheme-compare"
import { MAP_FILTER_READERS } from "@/lib/map-planning/filters"
import { formatDateRange, formatDistance, formatDuration, formatShortDate } from "@/lib/map-planning/format"
import { boundsFromPolygon, pointInPolygon, type LngLat } from "@/lib/map-planning/geo"
import { containerPoints, type MapPoint } from "@/lib/map-planning/points"
import { containerLocation } from "@/lib/map-planning/positions"
import { advancePlayback, playbackFrame } from "@/lib/map-planning/playback"
import { routesInSelection, routesInWindow, type AreaRoute } from "@/lib/map-planning/routes"
import type { SavedSelection } from "@/lib/map-planning/saved-selections"
import {
  serviceAreaLayers,
  serviceAreaSeedFromSelection,
  type ServiceAreaLayer,
  type ServiceAreaSeed,
} from "@/lib/map-planning/service-areas"
import {
  COLLECTION_WINDOW_LABELS,
  DEFAULT_COLLECTION_WINDOW,
  collectionWindowRange,
  inCollectionWindow,
  nextCollectionDate,
  routeStopIndex,
  type CollectionWindow,
} from "@/lib/map-planning/schedule"
import type { SearchHit } from "@/lib/map-planning/search"
import {
  schemeDraftFromSelection,
  selectedContainerRows,
  type SelectionShape,
} from "@/lib/map-planning/selection"
import { selectionStatistics } from "@/lib/map-planning/statistics"
import type { GuidedSchemeData } from "@/lib/route-schemes/quick-create"
import { todayIso } from "@/lib/route-schemes/recurrence"
import { cn } from "@/lib/utils"

import { LayersPanel } from "./layers-panel"
import { PlaybackBar, type PlaybackSpeed } from "./playback-bar"
import { useRoadGeometries } from "./use-road-geometries"
import { MapSearch } from "./map-search"
import { MapToolbar } from "./map-toolbar"
import { SavedSelectionsMenu } from "./saved-selections-menu"
import type { DrawTool, PlanningMapApi } from "./planning-map"
import { SelectedAreaPanel } from "./selected-area-panel"
import { StatusBadge } from "./status-badge"

const PlanningMap = dynamic(
  () => import("./planning-map").then((module) => module.PlanningMap),
  {
    ssr: false,
    loading: () => <Skeleton className="h-full w-full rounded-none" />,
  },
)

export type MapPlanningViewProps = {
  /** Every container in the registry; the planning areas, service areas, routes, and pickups they may reference. */
  containers: readonly BusinessRecord[]
  planningAreas: readonly BusinessRecord[]
  serviceAreas: readonly BusinessRecord[]
  routes: readonly BusinessRecord[]
  pickups: readonly BusinessRecord[]
  /** Every Route Scheme — coverage gaps and scheme comparison resolve their stops. */
  schemes: readonly BusinessRecord[]
  /** The Containers module — the details sheet reads its copy and lifecycle. */
  containersModule: ModuleDefinition
  canCreateScheme: boolean
  onCreateScheme: (data: GuidedSchemeData) => void
  canCreateServiceArea: boolean
  /** Opens the Service Area create dialog seeded from the selection. */
  onCreateServiceArea: (seed: ServiceAreaSeed) => void
}

type ClusterList = { cluster: MapCluster; anchor: { x: number; y: number } }
type RouteCard = { route: AreaRoute; anchor: { x: number; y: number } }
/** A route being replayed: progress is a fractional stop index, 0 at the first stop. */
type Playback = { routeId: string; progress: number; playing: boolean; speed: PlaybackSpeed }
/** What the pointer rests on — the map and the panel each highlight their side of it. */
type Highlight = { kind: "containers"; ids: readonly string[] } | { kind: "route"; id: string }

/** The quantities line when no collection window bounds them. */
const PER_COLLECTION_LABEL = "Per collection"

export function MapPlanningView({
  containers,
  planningAreas,
  serviceAreas,
  routes,
  pickups,
  schemes,
  containersModule,
  canCreateScheme,
  onCreateScheme,
  canCreateServiceArea,
  onCreateServiceArea,
}: MapPlanningViewProps) {
  const { resolvedTheme } = useTheme()
  const { containerTypes, wasteFractions } = useAssetManagementStore()
  const today = todayIso()
  const mapApi = useRef<PlanningMapApi | null>(null)

  const [filters, setFilters] = useState<BusinessFilters>(emptyBusinessFilters)
  const [window, setWindow] = useState<CollectionWindow>(DEFAULT_COLLECTION_WINDOW)
  const [drawTool, setDrawTool] = useState<DrawTool>("none")
  const [selectedContainerIds, setSelectedContainerIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [shape, setShape] = useState<SelectionShape | null>(null)
  const [editingShape, setEditingShape] = useState(false)
  const [routesOnMap, setRoutesOnMap] = useState(false)
  // The Routes layer: every drawable route in the collection window.
  const [windowRoutesOnMap, setWindowRoutesOnMap] = useState(false)
  const [routeCard, setRouteCard] = useState<RouteCard | null>(null)
  const [playback, setPlayback] = useState<Playback | null>(null)
  // The Coverage gaps layer: containers needing service that no scheme lists.
  const [coverageOnMap, setCoverageOnMap] = useState(false)
  // Two schemes compared on the map, A first.
  const [compareIds, setCompareIds] = useState<readonly string[]>([])
  // A wizard seed narrower than the whole selection ("Create scheme for uncovered").
  const [wizardSeedOverride, setWizardSeedOverride] = useState<Partial<GuidedSchemeData> | null>(null)
  const [highlight, setHighlight] = useState<Highlight | null>(null)
  const [detail, setDetail] = useState<BusinessRecord | null>(null)
  const [clusterList, setClusterList] = useState<ClusterList | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  // null = follow the app theme until the user picks a base map.
  const [baseMapChoice, setBaseMapChoice] = useState<BaseMapId | null>(null)
  const [enabledAreaIds, setEnabledAreaIds] = useState<ReadonlySet<string>>(() => new Set())
  const [enabledServiceAreaIds, setEnabledServiceAreaIds] = useState<ReadonlySet<string>>(() => new Set())

  // The base map choice lives in the browser only; read it after mount so
  // SSR and the first client render agree.
  useEffect(() => {
    try {
      const stored = globalThis.localStorage?.getItem(BASE_MAP_STORAGE_KEY)
      if (isBaseMapId(stored)) setBaseMapChoice(stored)
    } catch {
      // Storage may be unavailable; the theme default stands.
    }
  }, [])
  const chooseBaseMap = (id: BaseMapId) => {
    setBaseMapChoice(id)
    try {
      globalThis.localStorage?.setItem(BASE_MAP_STORAGE_KEY, id)
    } catch {
      // Storage may be unavailable; the choice lasts the session.
    }
  }

  const colorFor = useCallback(
    (fraction: string) => fractionColor(fraction, wasteFractions),
    [wasteFractions],
  )

  /* ------------------------------ derived data ----------------------------- */

  // The registry the map can place: in service, visible, and located.
  const inServiceContainers = useMemo(
    () => containers.filter((record) => !isSoftDeleted(record) && containerLocation(record) !== null),
    [containers],
  )
  const stopIndex = useMemo(() => routeStopIndex(routes, pickups), [routes, pickups])
  // The containers a filter set and window leave on the map — the live view
  // reads the current pair; loading a saved selection reads the saved one.
  const containersFor = useCallback(
    (activeFilters: BusinessFilters, activeWindow: CollectionWindow) =>
      applyBusinessFilters(inServiceContainers, activeFilters, MAP_FILTER_READERS).filter((record) =>
        inCollectionWindow(nextCollectionDate(record, stopIndex, today), activeWindow, today),
      ),
    [inServiceContainers, stopIndex, today],
  )
  const filteredContainers = useMemo(() => containersFor(filters, window), [containersFor, filters, window])
  const points = useMemo(() => containerPoints(filteredContainers), [filteredContainers])
  // Area outlines wrap every in-service container, whatever the filters hide.
  const areaLayers = useMemo(
    () => planningAreaLayers(planningAreas, inServiceContainers),
    [inServiceContainers, planningAreas],
  )
  const visibleAreaLayers = useMemo(
    () => areaLayers.filter((area) => area.bounds !== null && enabledAreaIds.has(area.id)),
    [areaLayers, enabledAreaIds],
  )
  // Service areas drawn on the map — only the ones created here carry a polygon.
  const drawnServiceAreas = useMemo(() => serviceAreaLayers(serviceAreas), [serviceAreas])
  const visibleServiceAreas = useMemo(
    () => drawnServiceAreas.filter((area) => enabledServiceAreaIds.has(area.id)),
    [drawnServiceAreas, enabledServiceAreaIds],
  )
  // A service area created during this visit switches itself on, so the
  // boundary just drawn is seen right away; areas from earlier stay as left.
  const knownServiceAreaIds = useRef<ReadonlySet<string> | null>(null)
  useEffect(() => {
    const ids = new Set(drawnServiceAreas.map((area) => area.id))
    const known = knownServiceAreaIds.current
    knownServiceAreaIds.current = ids
    if (!known) return
    const fresh = Array.from(ids).filter((id) => !known.has(id))
    if (fresh.length === 0) return
    setEnabledServiceAreaIds((current) => new Set([...current, ...fresh]))
  }, [drawnServiceAreas])
  const selectedContainers = useMemo(
    () => filteredContainers.filter((record) => selectedContainerIds.has(record.id)),
    [filteredContainers, selectedContainerIds],
  )
  const containerRows = useMemo(
    () => selectedContainerRows(points, selectedContainerIds),
    [points, selectedContainerIds],
  )
  const highlightedIds = useMemo(
    () => new Set(highlight?.kind === "containers" ? highlight.ids : []),
    [highlight],
  )
  const highlightedRouteId = highlight?.kind === "route" ? highlight.id : null
  const quantityRange = useMemo(() => collectionWindowRange(window, today), [today, window])
  const stats = useMemo(
    () =>
      selectionStatistics(selectedContainers, {
        containerTypes,
        wasteFractions,
        stopIndex,
        pickups,
        range: quantityRange,
        today,
      }),
    [containerTypes, pickups, quantityRange, selectedContainers, stopIndex, today, wasteFractions],
  )
  const serviceAreaRows = useMemo(
    () => serviceAreasForSelection(selectedContainers, serviceAreas),
    [selectedContainers, serviceAreas],
  )
  const windowRoutes = useMemo(
    () => routesInWindow(routes, pickups, inServiceContainers, quantityRange),
    [inServiceContainers, pickups, quantityRange, routes],
  )
  const areaRoutes = useMemo(
    () => routesInSelection(selectedContainers, routes, pickups, inServiceContainers),
    [inServiceContainers, pickups, routes, selectedContainers],
  )  // Both sources may name the same route; the layer's copy stands for it.
  // The replayed route, wherever it was picked from; it stays drawn while it plays.
  const playbackRoute = useMemo(() => {
    if (!playback) return null
    return (
      windowRoutes.find((route) => route.id === playback.routeId) ??
      areaRoutes.routes.find((route) => route.id === playback.routeId) ??
      null
    )
  }, [areaRoutes.routes, playback, windowRoutes])
  const routeLines = useMemo(() => {
    const lines = new Map<string, AreaRoute>()
    if (routesOnMap) for (const route of areaRoutes.routes) lines.set(route.id, route)
    if (windowRoutesOnMap) for (const route of windowRoutes) lines.set(route.id, route)
    if (playbackRoute) lines.set(playbackRoute.id, playbackRoute)
    return Array.from(lines.values())
  }, [areaRoutes.routes, playbackRoute, routesOnMap, windowRoutes, windowRoutesOnMap])
  const roadGeometries = useRoadGeometries(routeLines)
  const routeCardRoad = routeCard ? roadGeometries.get(routeCard.route.id) : undefined

  // Where the replayed vehicle stands: along the road when it is known, straight otherwise.
  const playbackFrameValue = useMemo(() => {
    if (!playback || !playbackRoute) return null
    const state = roadGeometries.get(playbackRoute.id)
    const geometry = state?.status === "ready" ? state.geometry : null
    const stops =
      geometry && geometry.snappedStops.length === playbackRoute.stops.length
        ? geometry.snappedStops
        : playbackRoute.stops.map((stop) => stop.lngLat)
    return playbackFrame(stops, geometry, playback.progress)
  }, [playback, playbackRoute, roadGeometries])

  // The route left the map's records (window changed, record deleted): stop replaying it.
  useEffect(() => {
    if (playback && !playbackRoute) setPlayback(null)
  }, [playback, playbackRoute])

  // The animation: advance by wall-clock time while playing, stop at the last stop.
  const stopCount = playbackRoute?.stops.length ?? 0
  useEffect(() => {
    if (!playback?.playing || stopCount === 0) return
    let last = performance.now()
    let frame = requestAnimationFrame(function tick(now) {
      const delta = now - last
      last = now
      setPlayback((current) => {
        if (!current || !current.playing) return current
        const next = advancePlayback(current.progress, delta, current.speed, stopCount)
        return { ...current, progress: next.progress, playing: !next.done }
      })
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [playback?.playing, stopCount])

  const startPlayback = (route: AreaRoute) => {
    if (route.stops.length === 0) {
      toast.info("This route has no stop positions to replay", {
        description: "Generate routes from a Route Scheme to see their stops on the map.",
      })
      return
    }
    setRouteCard(null)
    setPlayback({ routeId: route.id, progress: 0, playing: route.stops.length > 1, speed: 1 })
    mapApi.current?.fitBounds(boundsFromPolygon(route.stops.map((stop) => stop.lngLat)))
  }

  const activeChips = businessFilterChips(filters).length
  const canReset = activeChips > 0 || window !== DEFAULT_COLLECTION_WINDOW
  const hasSelection = shape !== null || selectedContainerIds.size > 0

  // Coverage resolves every counting scheme's stops against the registry as it is now.
  const gaps = useMemo(() => coverageGaps(containers, schemes, today), [containers, schemes, today])
  const selectionCoverage = useMemo(
    () => coverageInSelection(gaps, selectedContainerIds),
    [gaps, selectedContainerIds],
  )
  const uncoveredSelectedIds = useMemo(
    () => new Set([...selectedContainerIds].filter((id) => gaps.uncovered.has(id))),
    [gaps.uncovered, selectedContainerIds],
  )

  // Scheme comparison: every comparable scheme's stops, and the two picked ones side by side.
  const stopSets = useMemo(() => schemeStopSets(schemes, containers, today), [containers, schemes, today])
  const comparison = useMemo(() => {
    if (compareIds.length !== 2) return null
    const a = stopSets.find((set) => set.id === compareIds[0])
    const b = stopSets.find((set) => set.id === compareIds[1])
    return a && b ? compareSchemes(a, b, containers, gaps.needing) : null
  }, [compareIds, containers, gaps.needing, stopSets])
  useEffect(() => {
    // A compared scheme that left planning (deleted, recurrence broken) drops out of the pair.
    if (compareIds.some((id) => !stopSets.some((set) => set.id === id))) {
      setCompareIds((current) => current.filter((id) => stopSets.some((set) => set.id === id)))
    }
  }, [compareIds, stopSets])
  const toggleCompare = (schemeId: string, enabled: boolean) =>
    setCompareIds((current) => {
      const without = current.filter((id) => id !== schemeId)
      return enabled ? [...without, schemeId].slice(-2) : without
    })

  /* -------------------------------- actions -------------------------------- */

  const resetAll = () => {
    setFilters(emptyBusinessFilters)
    setWindow(DEFAULT_COLLECTION_WINDOW)
  }

  const clearSelection = () => {
    setSelectedContainerIds(new Set())
    setShape(null)
    setEditingShape(false)
    setRoutesOnMap(false)
    setHighlight(null)
  }

  // Restores the saved filters and window, then selects inside the saved
  // shape against the containers that pair leaves on the map.
  const loadSavedSelection = (saved: SavedSelection) => {
    setFilters(saved.filters)
    setWindow(saved.window)
    setShape(saved.shape)
    setEditingShape(false)
    setRoutesOnMap(false)
    setHighlight(null)
    setDrawTool("none")
    const visible = containerPoints(containersFor(saved.filters, saved.window))
    setSelectedContainerIds(
      new Set(visible.filter((point) => pointInPolygon(point.lngLat, saved.shape.polygon)).map((point) => point.id)),
    )
    mapApi.current?.fitBounds(boundsFromPolygon(saved.shape.polygon))
  }

  const hoverContainers = (ids: readonly string[] | null) =>
    setHighlight(ids && ids.length > 0 ? { kind: "containers", ids } : null)
  const hoverRoute = (id: string | null) => setHighlight(id ? { kind: "route", id } : null)

  /** The containers a shape holds — the selection a drawn or edited shape replaces. */
  const selectByPolygon = (polygon: LngLat[]) =>
    setSelectedContainerIds(
      new Set(points.filter((point) => pointInPolygon(point.lngLat, polygon)).map((point) => point.id)),
    )

  const completeDraw = (polygon: LngLat[]) => {
    if (drawTool === "none") return
    setShape({ kind: drawTool, polygon })
    selectByPolygon(polygon)
    setDrawTool("none")
    setEditingShape(false)
  }

  const changeShape = (polygon: LngLat[]) => {
    setShape((current) => (current ? { ...current, polygon } : current))
    selectByPolygon(polygon)
  }

  // A manual pick has no shape to name or edit.
  const addToSelection = (containerIds: readonly string[]) => {
    setSelectedContainerIds((current) => {
      const next = new Set(current)
      for (const id of containerIds) next.add(id)
      return next
    })
    setShape(null)
    setEditingShape(false)
  }

  const openPoint = (point: MapPoint) => setDetail(point.record)

  // Only routes with located stops can be drawn; fixture route days carry
  // none until a Route Scheme generates them.
  const toggleRoutesOnMap = () => {
    if (routesOnMap) {
      setRoutesOnMap(false)
      return
    }
    if (!areaRoutes.routes.some((route) => route.stops.length > 0)) {
      toast.info("These routes carry no stop positions yet", {
        description: "Generate routes from a Route Scheme to see their stops on the map.",
      })
      return
    }
    setRoutesOnMap(true)
  }

  const startWizard = () => setWizardOpen(true)
  const startWizardForUncovered = () => {
    setWizardSeedOverride(schemeDraftFromSelection(points, uncoveredSelectedIds))
    setWizardOpen(true)
  }
  const wizardSeed = useMemo(
    () => schemeDraftFromSelection(points, selectedContainerIds),
    [points, selectedContainerIds],
  )

  const toggleArea = (id: string, enabled: boolean) =>
    setEnabledAreaIds((current) => {
      const next = new Set(current)
      if (enabled) next.add(id)
      else next.delete(id)
      return next
    })
  const showAllAreas = () =>
    setEnabledAreaIds(new Set(areaLayers.filter((area) => area.bounds).map((area) => area.id)))
  const hideAllAreas = () => setEnabledAreaIds(new Set())
  const zoomToArea = (area: PlanningAreaLayer) => {
    if (area.bounds) mapApi.current?.fitBounds(area.bounds)
  }
  const toggleServiceArea = (id: string, enabled: boolean) =>
    setEnabledServiceAreaIds((current) => {
      const next = new Set(current)
      if (enabled) next.add(id)
      else next.delete(id)
      return next
    })
  const zoomToServiceArea = (area: ServiceAreaLayer) => mapApi.current?.fitBounds(area.bounds)

  const startServiceArea = () =>
    onCreateServiceArea(
      serviceAreaSeedFromSelection({
        selected: selectedContainers,
        shape,
        planningAreas,
        properties: stats.properties,
      }),
    )

  const goToHit = (hit: SearchHit) => {
    if (hit.kind === "area") {
      if (hit.bounds) mapApi.current?.fitBounds(hit.bounds)
      else toast.info("That planning area has no located containers yet")
      return
    }
    if (hit.lngLat) mapApi.current?.flyTo(hit.lngLat)
  }

  const baseMap = baseMapChoice ?? defaultBaseMapForTheme(resolvedTheme === "dark" ? "dark" : "light")
  const quantitiesLabel = quantityRange ? formatDateRange(quantityRange) : PER_COLLECTION_LABEL

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="map-planning">
      <div className="px-4 py-3">
        <MapToolbar
          records={inServiceContainers}
          filters={filters}
          onFiltersChange={setFilters}
          window={window}
          onWindowChange={setWindow}
          canReset={canReset}
          onResetAll={resetAll}
        >
          <MapSearch points={points} areas={areaLayers} onPick={goToHit} />
        </MapToolbar>
      </div>

      <div className="relative min-h-[420px] flex-1 border-t border-border">
        <PlanningMap
          points={points}
          selectedIds={selectedContainerIds}
          drawTool={drawTool}
          colorFor={colorFor}
          baseMap={baseMap}
          shape={shape}
          editingShape={editingShape}
          onShapeChange={changeShape}
          areaLayers={visibleAreaLayers}
          serviceAreaLayers={visibleServiceAreas}
          routeLines={routeLines}
          roadGeometries={roadGeometries}
          onRouteClick={(route, anchor) => setRouteCard({ route, anchor })}
          playback={
            playback && playbackRoute && playbackFrameValue
              ? {
                  routeId: playbackRoute.id,
                  color: playbackRoute.color,
                  position: playbackFrameValue.position,
                  travelled: playbackFrameValue.travelled,
                }
              : null
          }
          uncoveredIds={comparison ? comparison.orphaned : coverageOnMap ? gaps.uncovered : null}
          compare={comparison ? { membership: comparison.membership, hull: comparison.hull } : null}
          highlightedIds={highlightedIds}
          highlightedRouteId={highlightedRouteId}
          onHoverPoint={hoverContainers}
          onHoverRoute={hoverRoute}
          onDrawComplete={completeDraw}
          onDrawCancel={() => setDrawTool("none")}
          onPointClick={openPoint}
          onClusterList={(cluster, anchor) => setClusterList({ cluster, anchor })}
          apiRef={mapApi}
        />

        {/* Draw tools */}
        <div
          role="toolbar"
          aria-label="Selection tools"
          className="absolute left-3 top-3 z-30 flex items-center gap-1 rounded-lg border border-border bg-background/95 p-1 shadow-sm backdrop-blur"
        >
          <ToolButton
            label="Select with a rectangle"
            pressed={drawTool === "rectangle"}
            onClick={() => setDrawTool(drawTool === "rectangle" ? "none" : "rectangle")}
          >
            <Selection className="h-4 w-4" />
          </ToolButton>
          <ToolButton
            label="Select with a polygon"
            pressed={drawTool === "polygon"}
            onClick={() => setDrawTool(drawTool === "polygon" ? "none" : "polygon")}
          >
            <Polygon className="h-4 w-4" />
          </ToolButton>
          <ToolButton label="Clear selection" disabled={!hasSelection} onClick={clearSelection}>
            <Trash className="h-4 w-4" />
          </ToolButton>
          <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />
          <SavedSelectionsMenu shape={shape} filters={filters} window={window} onLoad={loadSavedSelection} />
        </div>

        {hasSelection && (
          <SelectedAreaPanel
            shape={shape}
            stats={stats}
            serviceAreas={serviceAreaRows}
            routes={areaRoutes}
            routesOnMap={routesOnMap}
            onToggleRoutesOnMap={toggleRoutesOnMap}
            onPlayRoute={startPlayback}
            coverage={selectionCoverage}
            coverageOnMap={coverageOnMap}
            onToggleCoverageOnMap={() => setCoverageOnMap((current) => !current)}
            onCreateSchemeForUncovered={startWizardForUncovered}
            containers={containerRows}
            highlightedContainerIds={highlightedIds}
            highlightedRouteId={highlightedRouteId}
            onHoverContainers={hoverContainers}
            onHoverRoute={hoverRoute}
            onOpenContainer={openPoint}
            quantitiesLabel={quantitiesLabel}
            colorFor={colorFor}
            editing={editingShape}
            onToggleEdit={() => setEditingShape((current) => !current)}
            canCreateScheme={canCreateScheme}
            onCreateScheme={startWizard}
            canCreateServiceArea={canCreateServiceArea}
            onCreateServiceArea={startServiceArea}
            onClose={clearSelection}
            className="absolute bottom-8 left-3 top-14 z-30 w-[min(420px,calc(100%-24px))]"
          />
        )}

        {comparison && (
          <section
            aria-label={`Comparing ${comparison.a.name} with ${comparison.b.name}`}
            data-testid="compare-strip"
            className="absolute left-1/2 top-3 z-30 flex max-w-[min(760px,calc(100%-24px))] -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-background/95 px-3 py-1.5 text-xs shadow-sm backdrop-blur"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <CompareDot color={COMPARE_COLORS.a} letter="A" />
              <span className="truncate font-medium">{comparison.a.name}</span>
            </span>
            <span className="text-muted-foreground">vs</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <CompareDot color={COMPARE_COLORS.b} letter="B" />
              <span className="truncate font-medium">{comparison.b.name}</span>
            </span>
            <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />
            <span className="flex shrink-0 items-center gap-2.5 tabular-nums" data-testid="compare-counts">
              <CompareCount color={COMPARE_COLORS.a} label="A only" value={comparison.aOnly.size} />
              <CompareCount color={COMPARE_COLORS.b} label="B only" value={comparison.bOnly.size} />
              <CompareCount color={COMPARE_COLORS.both} label="Both" value={comparison.both.size} />
              <CompareCount color={UNCOVERED_COLOR} label="Orphaned" value={comparison.orphaned.size} ring />
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 text-muted-foreground"
              aria-label="Stop comparing"
              onClick={() => setCompareIds([])}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </section>
        )}

        {playback && playbackRoute && (
          <PlaybackBar
            route={playbackRoute}
            progress={playback.progress}
            playing={playback.playing}
            speed={playback.speed}
            onTogglePlay={() =>
              setPlayback((current) =>
                current
                  ? {
                      ...current,
                      // Play again from the start once the journey has ended.
                      progress: !current.playing && current.progress >= stopCount - 1 ? 0 : current.progress,
                      playing: !current.playing,
                    }
                  : current,
              )
            }
            onSpeedChange={(speed) => setPlayback((current) => (current ? { ...current, speed } : current))}
            onScrub={(progress) => setPlayback((current) => (current ? { ...current, progress, playing: false } : current))}
            onClose={() => setPlayback(null)}
            className="absolute bottom-8 z-30 -translate-x-1/2"
            style={{
              // Centred over the map, or over the part of it the Selected area panel leaves free.
              left: hasSelection ? "calc(432px + (100% - 432px) / 2)" : "50%",
              width: hasSelection ? "min(560px, calc(100% - 456px))" : "min(560px, calc(100% - 24px))",
            }}
          />
        )}

        <div className="absolute bottom-8 right-3 z-30 flex items-center gap-2">
          <LayersPanel
            baseMap={baseMap}
            onBaseMapChange={chooseBaseMap}
            areas={areaLayers}
            enabledAreaIds={enabledAreaIds}
            onToggleArea={toggleArea}
            onShowAllAreas={showAllAreas}
            onHideAllAreas={hideAllAreas}
            onZoomToArea={zoomToArea}
            serviceAreas={drawnServiceAreas}
            enabledServiceAreaIds={enabledServiceAreaIds}
            onToggleServiceArea={toggleServiceArea}
            onZoomToServiceArea={zoomToServiceArea}
            routes={windowRoutes}
            routesOnMap={windowRoutesOnMap}
            onToggleRoutes={setWindowRoutesOnMap}
            windowLabel={COLLECTION_WINDOW_LABELS[window]}
            coverage={{
              on: coverageOnMap,
              needing: gaps.needing.size,
              uncovered: gaps.uncovered.size,
              unservable: gaps.unservable.size,
              schemes: gaps.schemesConsidered,
            }}
            onToggleCoverage={setCoverageOnMap}
            schemes={stopSets}
            compareIds={compareIds}
            onToggleCompare={toggleCompare}
          />
        </div>

        {routeCard && (
          <Popover open onOpenChange={(open) => !open && setRouteCard(null)}>
            <PopoverAnchor asChild>
              <span
                className="pointer-events-none absolute size-px"
                style={{ left: routeCard.anchor.x, top: routeCard.anchor.y }}
              />
            </PopoverAnchor>
            <PopoverContent align="start" className="w-72 p-3 text-sm" data-testid="route-card">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-2">
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: routeCard.route.color }}
                      aria-hidden
                    />
                    <span className="truncate font-semibold">{routeCard.route.name}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {routeCard.route.date ? formatShortDate(routeCard.route.date) : "Undated"}
                    {routeCard.route.timeWindow ? ` · ${routeCard.route.timeWindow}` : ""}
                  </p>
                </div>
                <StatusBadge status={routeCard.route.status} />
              </div>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Vehicle</dt>
                <dd className="truncate">{routeCard.route.vehicle ?? "Unassigned"}</dd>
                <dt className="text-muted-foreground">Driver</dt>
                <dd className="truncate">{routeCard.route.driver ?? "Unassigned"}</dd>
                <dt className="text-muted-foreground">Stops</dt>
                <dd className="tabular-nums">
                  {routeCard.route.stopCount}
                  {routeCard.route.stops.length < routeCard.route.stopCount
                    ? ` · ${routeCard.route.stops.length} on the map`
                    : ""}
                </dd>
                {routeCardRoad?.status === "ready" && routeCardRoad.geometry.legs.length > 0 && (
                  <>
                    <dt className="text-muted-foreground">Drive</dt>
                    <dd className="tabular-nums" data-testid="route-card-drive">
                      {formatDistance(routeCardRoad.geometry.distanceMetres)} ·{" "}
                      {formatDuration(routeCardRoad.geometry.durationSeconds)}
                    </dd>
                  </>
                )}
              </dl>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="default"
                  size="sm"
                  className="h-8 flex-1 gap-1.5 text-xs"
                  disabled={routeCard.route.stops.length === 0}
                  onClick={() => startPlayback(routeCard.route)}
                >
                  <Play className="h-3.5 w-3.5" weight="fill" />
                  Play route
                </Button>
                <Button asChild variant="outline" size="sm" className="h-8 flex-1 gap-1.5 text-xs">
                  <Link href={routeCard.route.href}>
                    Open route
                    <ArrowSquareOut className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        )}

        {clusterList && (
          <Popover open onOpenChange={(open) => !open && setClusterList(null)}>
            <PopoverAnchor asChild>
              <span
                className="pointer-events-none absolute size-px"
                style={{ left: clusterList.anchor.x, top: clusterList.anchor.y }}
              />
            </PopoverAnchor>
            <PopoverContent align="start" className="w-72 p-2" data-testid="cluster-list">
              <div className="flex items-center justify-between px-1 pb-2">
                <p className="text-xs font-medium">
                  {clusterList.cluster.count} at this address
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    addToSelection(clusterList.cluster.points.flatMap((point) => point.containerIds))
                    setClusterList(null)
                  }}
                >
                  Select all
                </Button>
              </div>
              <ul className="max-h-64 space-y-0.5 overflow-y-auto">
                {clusterList.cluster.points.map((point) => (
                  <li key={point.id}>
                    <button
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent",
                        point.containerIds.some((id) => highlightedIds.has(id)) && "bg-accent",
                      )}
                      onMouseEnter={() => hoverContainers(point.containerIds)}
                      onMouseLeave={() => hoverContainers(null)}
                      onClick={() => {
                        setClusterList(null)
                        openPoint(point)
                      }}
                    >
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{
                          backgroundColor: point.fractions[0] ? colorFor(point.fractions[0]) : undefined,
                        }}
                      />
                      <span className="flex-1 truncate font-medium">{point.label}</span>
                      <span className="truncate text-muted-foreground">
                        {point.fractions.join(" · ")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        )}
      </div>

      <ContainerDetailsSheet
        key={detail?.id ?? "closed-container"}
        module={containersModule}
        record={detail}
        onClose={() => setDetail(null)}
        onAction={(action) =>
          toast.info(`${action} runs from Assets & Inventory`, {
            description: "Open the container there to change its lifecycle.",
          })
        }
      />

      {wizardOpen && (
        <SchemeWizard
          open
          initialData={wizardSeedOverride ?? wizardSeed}
          onOpenChange={(open) => {
            if (!open) {
              setWizardOpen(false)
              setWizardSeedOverride(null)
            }
          }}
          onCreate={(data) => {
            setWizardOpen(false)
            setWizardSeedOverride(null)
            onCreateScheme(data)
            clearSelection()
          }}
        />
      )}
    </div>
  )
}

function CompareDot({ color, letter }: { color: string; letter: string }) {
  return (
    <span
      className="flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white"
      style={{ backgroundColor: color }}
      aria-hidden
    >
      {letter}
    </span>
  )
}

function CompareCount({ color, label, value, ring }: { color: string; label: string; value: number; ring?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={cn("size-2.5 rounded-full", ring && "border-2 bg-background")}
        style={ring ? { borderColor: color } : { backgroundColor: color }}
        aria-hidden
      />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold">{value}</span>
    </span>
  )
}

function ToolButton({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string
  pressed?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("h-8 w-8", pressed && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground")}
          aria-label={label}
          aria-pressed={pressed}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
