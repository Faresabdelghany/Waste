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
import { ArrowSquareOut, Polygon, Selection, Trash } from "@phosphor-icons/react/dist/ssr"
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
import { MAP_FILTER_READERS } from "@/lib/map-planning/filters"
import { formatDateRange, formatShortDate } from "@/lib/map-planning/format"
import { pointInPolygon, type LngLat } from "@/lib/map-planning/geo"
import { containerPoints, type MapPoint } from "@/lib/map-planning/points"
import { containerLocation } from "@/lib/map-planning/positions"
import { routesInSelection, routesInWindow, type AreaRoute } from "@/lib/map-planning/routes"
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
import { schemeDraftFromSelection, type SelectionShape } from "@/lib/map-planning/selection"
import { selectionStatistics } from "@/lib/map-planning/statistics"
import type { GuidedSchemeData } from "@/lib/route-schemes/quick-create"
import { todayIso } from "@/lib/route-schemes/recurrence"
import { cn } from "@/lib/utils"

import { LayersPanel } from "./layers-panel"
import { MapSearch } from "./map-search"
import { MapToolbar } from "./map-toolbar"
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
  /** The Containers module — the details sheet reads its copy and lifecycle. */
  containersModule: ModuleDefinition
  canCreateScheme: boolean
  onCreateScheme: (data: GuidedSchemeData) => void
}

type ClusterList = { cluster: MapCluster; anchor: { x: number; y: number } }
type RouteCard = { route: AreaRoute; anchor: { x: number; y: number } }

/** The quantities line when no collection window bounds them. */
const PER_COLLECTION_LABEL = "Per collection"

export function MapPlanningView({
  containers,
  planningAreas,
  serviceAreas,
  routes,
  pickups,
  containersModule,
  canCreateScheme,
  onCreateScheme,
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
  const [detail, setDetail] = useState<BusinessRecord | null>(null)
  const [clusterList, setClusterList] = useState<ClusterList | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  // null = follow the app theme until the user picks a base map.
  const [baseMapChoice, setBaseMapChoice] = useState<BaseMapId | null>(null)
  const [enabledAreaIds, setEnabledAreaIds] = useState<ReadonlySet<string>>(() => new Set())

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
  const filteredContainers = useMemo(
    () =>
      applyBusinessFilters(inServiceContainers, filters, MAP_FILTER_READERS).filter((record) =>
        inCollectionWindow(nextCollectionDate(record, stopIndex, today), window, today),
      ),
    [filters, inServiceContainers, stopIndex, today, window],
  )
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
  const selectedContainers = useMemo(
    () => filteredContainers.filter((record) => selectedContainerIds.has(record.id)),
    [filteredContainers, selectedContainerIds],
  )
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
  const routeLines = useMemo(() => {
    const lines = new Map<string, AreaRoute>()
    if (routesOnMap) for (const route of areaRoutes.routes) lines.set(route.id, route)
    if (windowRoutesOnMap) for (const route of windowRoutes) lines.set(route.id, route)
    return Array.from(lines.values())
  }, [areaRoutes.routes, routesOnMap, windowRoutes, windowRoutesOnMap])

  const activeChips = businessFilterChips(filters).length
  const canReset = activeChips > 0 || window !== DEFAULT_COLLECTION_WINDOW
  const hasSelection = shape !== null || selectedContainerIds.size > 0

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
  }

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
          routeLines={routeLines}
          onRouteClick={(route, anchor) => setRouteCard({ route, anchor })}
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
        </div>

        {hasSelection && (
          <SelectedAreaPanel
            shape={shape}
            stats={stats}
            serviceAreas={serviceAreaRows}
            routes={areaRoutes}
            routesOnMap={routesOnMap}
            onToggleRoutesOnMap={toggleRoutesOnMap}
            quantitiesLabel={quantitiesLabel}
            colorFor={colorFor}
            editing={editingShape}
            onToggleEdit={() => setEditingShape((current) => !current)}
            canCreateScheme={canCreateScheme}
            onCreateScheme={startWizard}
            onClose={clearSelection}
            className="absolute bottom-8 left-3 top-14 z-30 w-[min(420px,calc(100%-24px))]"
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
            routes={windowRoutes}
            routesOnMap={windowRoutesOnMap}
            onToggleRoutes={setWindowRoutesOnMap}
            windowLabel={COLLECTION_WINDOW_LABELS[window]}
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
              </dl>
              <Button asChild variant="outline" size="sm" className="mt-3 h-8 w-full gap-1.5 text-xs">
                <Link href={routeCard.route.href}>
                  Open route
                  <ArrowSquareOut className="h-3.5 w-3.5" />
                </Link>
              </Button>
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
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
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
          initialData={wizardSeed}
          onOpenChange={(open) => {
            if (!open) setWizardOpen(false)
          }}
          onCreate={(data) => {
            setWizardOpen(false)
            onCreateScheme(data)
            clearSelection()
          }}
        />
      )}
    </div>
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
