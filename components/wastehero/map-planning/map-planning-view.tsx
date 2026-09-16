"use client"

// Map Planning (2026-09-16): the Plan workspace's page. The container and
// property registry as clustered markers over a real base map, filtered by
// the shared filter popover and a collection window, selected with a
// rectangle or polygon, and handed to the Guided Setup wizard as a Route
// Scheme draft. Every number on screen derives from live records at render
// time; the page stores nothing but the saved views in the browser. Rendered
// by BusinessWorkspace for plan.map-planning.

import dynamic from "next/dynamic"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Polygon, Selection, Trash } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { useAssetManagementStore } from "@/components/settings/asset-management-store"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
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
import type { MapCluster } from "@/lib/map-planning/clusters"
import { fractionColor } from "@/lib/map-planning/colors"
import { MAP_FILTER_READERS } from "@/lib/map-planning/filters"
import { pointInPolygon, type LngLat } from "@/lib/map-planning/geo"
import {
  containerPoints,
  propertyPoints,
  type MapMode,
  type MapPoint,
} from "@/lib/map-planning/points"
import { containerLocation } from "@/lib/map-planning/positions"
import {
  MAP_PLANNING_STORAGE_KEY,
  parseSavedViews,
  serializeSavedViews,
  type SavedMapView,
} from "@/lib/map-planning/saved-views"
import {
  COLLECTION_WINDOW_LABELS,
  DEFAULT_COLLECTION_WINDOW,
  inCollectionWindow,
  nextCollectionDate,
  routeStopIndex,
  type CollectionWindow,
} from "@/lib/map-planning/schedule"
import { schemeDraftFromSelection, selectionSummary } from "@/lib/map-planning/selection"
import type { GuidedSchemeData } from "@/lib/route-schemes/quick-create"
import { todayIso } from "@/lib/route-schemes/recurrence"
import { cn } from "@/lib/utils"

import { LegendPanel, type LegendEntry } from "./legend-panel"
import { MapToolbar } from "./map-toolbar"
import type { DrawTool } from "./planning-map"
import { SelectionBar } from "./selection-bar"

const PlanningMap = dynamic(
  () => import("./planning-map").then((module) => module.PlanningMap),
  {
    ssr: false,
    loading: () => <Skeleton className="h-full w-full rounded-none" />,
  },
)

export type MapPlanningViewProps = {
  /** Project-scoped containers and properties, and every route and pickup. */
  containers: readonly BusinessRecord[]
  properties: readonly BusinessRecord[]
  routes: readonly BusinessRecord[]
  pickups: readonly BusinessRecord[]
  /** The Containers module — the details sheet reads its copy and lifecycle. */
  containersModule: ModuleDefinition
  canCreateScheme: boolean
  onCreateScheme: (data: GuidedSchemeData) => void
}

type ClusterList = { cluster: MapCluster; anchor: { x: number; y: number } }

export function MapPlanningView({
  containers,
  properties,
  routes,
  pickups,
  containersModule,
  canCreateScheme,
  onCreateScheme,
}: MapPlanningViewProps) {
  const router = useRouter()
  const { resolvedTheme } = useTheme()
  const { wasteFractions } = useAssetManagementStore()
  const today = todayIso()

  const [mode, setMode] = useState<MapMode>("containers")
  const [filters, setFilters] = useState<BusinessFilters>(emptyBusinessFilters)
  const [window, setWindow] = useState<CollectionWindow>(DEFAULT_COLLECTION_WINDOW)
  const [savedViews, setSavedViews] = useState<SavedMapView[]>([])
  const [savedViewsLoaded, setSavedViewsLoaded] = useState(false)
  const [drawTool, setDrawTool] = useState<DrawTool>("none")
  const [selectedContainerIds, setSelectedContainerIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [detail, setDetail] = useState<BusinessRecord | null>(null)
  const [clusterList, setClusterList] = useState<ClusterList | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)

  // Saved views live in the browser only; load after mount so SSR and the
  // first client render agree, then persist every change.
  useEffect(() => {
    try {
      setSavedViews(parseSavedViews(globalThis.localStorage?.getItem(MAP_PLANNING_STORAGE_KEY) ?? null))
    } catch {
      setSavedViews([])
    }
    setSavedViewsLoaded(true)
  }, [])
  useEffect(() => {
    if (!savedViewsLoaded) return
    try {
      globalThis.localStorage?.setItem(MAP_PLANNING_STORAGE_KEY, serializeSavedViews(savedViews))
    } catch {
      // Storage may be unavailable; the menu simply forgets on reload.
    }
  }, [savedViews, savedViewsLoaded])

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
  // Container points always exist — selection, summary, and the wizard draft
  // count containers whatever the markers show.
  const allContainerPoints = useMemo(() => containerPoints(filteredContainers), [filteredContainers])
  const points = useMemo<MapPoint[]>(
    () => (mode === "containers" ? allContainerPoints : propertyPoints(filteredContainers, properties)),
    [allContainerPoints, filteredContainers, mode, properties],
  )
  const selectedPointIds = useMemo(
    () =>
      new Set(
        points
          .filter((point) => point.containerIds.some((id) => selectedContainerIds.has(id)))
          .map((point) => point.id),
      ),
    [points, selectedContainerIds],
  )
  const summary = useMemo(
    () => selectionSummary(allContainerPoints, selectedContainerIds),
    [allContainerPoints, selectedContainerIds],
  )
  const legendEntries = useMemo<LegendEntry[]>(() => {
    const counts = new Map<string, number>()
    for (const point of allContainerPoints) {
      for (const fraction of point.fractions) counts.set(fraction, (counts.get(fraction) ?? 0) + 1)
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([fraction, count]) => ({ fraction, color: colorFor(fraction), count }))
  }, [allContainerPoints, colorFor])

  const activeChips = businessFilterChips(filters).length
  const canReset = activeChips > 0 || window !== DEFAULT_COLLECTION_WINDOW

  /* -------------------------------- actions -------------------------------- */

  const resetAll = () => {
    setFilters(emptyBusinessFilters)
    setWindow(DEFAULT_COLLECTION_WINDOW)
  }

  const applyView = (view: SavedMapView) => {
    setMode(view.mode)
    setWindow(view.window)
    setFilters(view.filters)
    toast.success("Saved view applied", { description: view.name })
  }

  const saveView = (name: string) => {
    const view: SavedMapView = {
      id: `view-${Date.now()}`,
      name,
      mode,
      window,
      filters,
      createdAt: new Date().toISOString(),
    }
    setSavedViews((current) => [view, ...current])
    toast.success("View saved", { description: name })
  }

  const deleteView = (id: string) => {
    setSavedViews((current) => current.filter((view) => view.id !== id))
  }

  const addToSelection = (containerIds: readonly string[]) => {
    setSelectedContainerIds((current) => {
      const next = new Set(current)
      for (const id of containerIds) next.add(id)
      return next
    })
  }

  const clearSelection = () => setSelectedContainerIds(new Set())

  const completeDraw = (polygon: LngLat[]) => {
    const hits = allContainerPoints.filter((point) => pointInPolygon(point.lngLat, polygon))
    addToSelection(hits.map((point) => point.id))
    setDrawTool("none")
    if (hits.length === 0) {
      toast.info("No containers inside that shape", {
        description: "Draw around the markers you want, or widen the filters.",
      })
    }
  }

  const openPoint = (point: MapPoint) => {
    if (point.kind === "container") {
      setDetail(point.record)
      return
    }
    // A property point opens its property record when the CRM has one;
    // otherwise it lists the containers standing at that address.
    if (point.record.id !== point.containerIds[0]) {
      router.push(`/customers?module=properties&record=${encodeURIComponent(point.record.id)}`)
      return
    }
    const members = allContainerPoints.filter((candidate) => point.containerIds.includes(candidate.id))
    setClusterList({
      cluster: {
        id: point.id,
        lngLat: point.lngLat,
        count: members.length,
        points: members,
        fractions: point.fractions,
        singleLocation: true,
      },
      anchor: { x: 0, y: 0 },
    })
  }

  const startWizard = () => setWizardOpen(true)
  const wizardSeed = useMemo(
    () => schemeDraftFromSelection(allContainerPoints, selectedContainerIds),
    [allContainerPoints, selectedContainerIds],
  )

  const exportSelection = () => {
    toast.success("Export queued", {
      description: `${summary.containers} container${summary.containers === 1 ? "" : "s"} · current selection · audit recorded`,
    })
  }

  const theme = resolvedTheme === "dark" ? "dark" : "light"
  const hiddenByFilters = inServiceContainers.length - filteredContainers.length

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="map-planning">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Map Planning</h1>
          <p className="text-xs text-muted-foreground" data-testid="map-planning-counter">
            {filteredContainers.length} of {inServiceContainers.length} containers on the map
            {mode === "properties" ? ` · ${points.length} propert${points.length === 1 ? "y" : "ies"}` : ""}
            {window !== "any" ? ` · ${COLLECTION_WINDOW_LABELS[window]}` : ""}
            {hiddenByFilters > 0 ? ` · ${hiddenByFilters} hidden by filters` : ""}
          </p>
        </div>
        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={(value) => {
            if (value === "containers" || value === "properties") setMode(value)
          }}
          aria-label="Marker mode"
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="containers" className="px-3 text-xs">
            Containers
          </ToggleGroupItem>
          <ToggleGroupItem value="properties" className="px-3 text-xs">
            Properties
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="px-4 py-3">
        <MapToolbar
          records={inServiceContainers}
          filters={filters}
          onFiltersChange={setFilters}
          window={window}
          onWindowChange={setWindow}
          savedViews={savedViews}
          onApplyView={applyView}
          onSaveView={saveView}
          onDeleteView={deleteView}
          canReset={canReset}
          onResetAll={resetAll}
        />
      </div>

      <div className="relative min-h-[420px] flex-1 border-t border-border">
        <PlanningMap
          points={points}
          selectedIds={selectedPointIds}
          drawTool={drawTool}
          colorFor={colorFor}
          theme={theme}
          onDrawComplete={completeDraw}
          onDrawCancel={() => setDrawTool("none")}
          onPointClick={openPoint}
          onClusterList={(cluster, anchor) => setClusterList({ cluster, anchor })}
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
          <ToolButton
            label="Clear selection"
            disabled={selectedContainerIds.size === 0}
            onClick={clearSelection}
          >
            <Trash className="h-4 w-4" />
          </ToolButton>
        </div>

        <LegendPanel entries={legendEntries} mode={mode} className="absolute bottom-8 right-3 z-30" />

        {summary.containers > 0 && (
          <SelectionBar
            summary={summary}
            colorFor={colorFor}
            canCreateScheme={canCreateScheme}
            onCreateScheme={startWizard}
            onExport={exportSelection}
            onClear={clearSelection}
            className="absolute bottom-8 left-1/2 z-30 w-[min(720px,calc(100%-24px))] -translate-x-1/2"
          />
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
