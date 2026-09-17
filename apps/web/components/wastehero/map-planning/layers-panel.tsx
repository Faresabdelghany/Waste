"use client"

// The Layers control (2026-09-16): the bottom-right "Layers n/N" button
// and its panel — the base map picker (CSS-drawn swatches, no network), the
// planning-area outlines, each with a checkbox and a zoom-to button, and the
// Routes layer: every drawable route in the collection window, counted by
// status, and the service areas drawn on the map. Areas come from
// @waste/domain/map-planning/areas, routes from routes.ts, service areas from
// service-areas.ts; the map draws the ones that are on.

import { Check, Crosshair, Stack } from "@phosphor-icons/react/dist/ssr"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { PlanningAreaLayer } from "@waste/domain/map-planning/areas"
import { BASE_MAPS, type BaseMap, type BaseMapId } from "@/lib/map-planning/base-maps"
import { UNCOVERED_COLOR } from "@waste/domain/map-planning/coverage-gaps"
import { COMPARE_COLORS, type SchemeStopSet } from "@waste/domain/map-planning/scheme-compare"
import { ROUTE_BUCKET_COLORS, type AreaRoute, type RouteBucket } from "@waste/domain/map-planning/routes"
import type { ServiceAreaLayer } from "@waste/domain/map-planning/service-areas"
import { cn } from "@/lib/utils"

export type LayersPanelProps = {
  baseMap: BaseMapId
  onBaseMapChange: (id: BaseMapId) => void
  areas: readonly PlanningAreaLayer[]
  enabledAreaIds: ReadonlySet<string>
  onToggleArea: (id: string, enabled: boolean) => void
  onShowAllAreas: () => void
  onHideAllAreas: () => void
  onZoomToArea: (area: PlanningAreaLayer) => void
  /** Service areas that carry a drawn boundary. */
  serviceAreas: readonly ServiceAreaLayer[]
  enabledServiceAreaIds: ReadonlySet<string>
  onToggleServiceArea: (id: string, enabled: boolean) => void
  onZoomToServiceArea: (area: ServiceAreaLayer) => void
  /** Every drawable route in the collection window. */
  routes: readonly AreaRoute[]
  routesOnMap: boolean
  onToggleRoutes: (enabled: boolean) => void
  /** "Any date", "Next 7 days", … — names the window the routes are read from. */
  windowLabel: string
  /** The Coverage gaps layer: whether it is on, and the registry-wide counts behind it. */
  coverage: CoverageLayer
  onToggleCoverage: (enabled: boolean) => void
  /** Every comparable Route Scheme with its resolved stops. */
  schemes: readonly SchemeStopSet[]
  /** The schemes being compared, A first — at most two. */
  compareIds: readonly string[]
  onToggleCompare: (schemeId: string, enabled: boolean) => void
  className?: string
}

export type CoverageLayer = {
  on: boolean
  /** Containers that need service. */
  needing: number
  /** …of which no counting Route Scheme lists. */
  uncovered: number
  /** Scheme stops on containers that cannot be served. */
  unservable: number
  /** Route Schemes whose stops counted. */
  schemes: number
}

const ROUTE_BUCKET_LABELS: Readonly<Record<RouteBucket, string>> = {
  awaiting: "awaiting",
  "in-progress": "in progress",
  completed: "completed",
}
const ROUTE_BUCKETS: readonly RouteBucket[] = ["awaiting", "in-progress", "completed"]

export function LayersPanel({
  baseMap,
  onBaseMapChange,
  areas,
  enabledAreaIds,
  onToggleArea,
  onShowAllAreas,
  onHideAllAreas,
  onZoomToArea,
  serviceAreas,
  enabledServiceAreaIds,
  onToggleServiceArea,
  onZoomToServiceArea,
  routes,
  routesOnMap,
  onToggleRoutes,
  windowLabel,
  coverage,
  onToggleCoverage,
  schemes,
  compareIds,
  onToggleCompare,
  className,
}: LayersPanelProps) {
  const drawable = areas.filter((area) => area.bounds !== null)
  const enabled = drawable.filter((area) => enabledAreaIds.has(area.id)).length
  const routeCounts = ROUTE_BUCKETS.map(
    (bucket) => [bucket, routes.filter((route) => route.bucket === bucket).length] as const,
  ).filter(([, count]) => count > 0)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn("h-8 gap-1.5 bg-background/95 text-xs shadow-sm", className)}
          aria-label={`Layers, ${enabled} of ${drawable.length} planning areas shown`}
        >
          <Stack className="h-4 w-4" />
          Layers
          <span className="font-mono text-muted-foreground" data-testid="layers-count">
            {enabled}/{drawable.length}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80 p-0 text-sm" aria-label="Layers">
        <div className="border-b border-border px-3 py-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Base map</p>
          <div role="radiogroup" aria-label="Base map" className="grid grid-cols-4 gap-2">
            {BASE_MAPS.map((option) => (
              <BaseMapSwatch
                key={option.id}
                option={option}
                selected={option.id === baseMap}
                onSelect={() => onBaseMapChange(option.id)}
              />
            ))}
          </div>
        </div>
        <div className="border-b border-border px-3 py-3" data-testid="routes-layer">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">Routes</p>
            <span className="text-[11px] text-muted-foreground">{windowLabel}</span>
          </div>
          <div className="flex items-start gap-2 rounded-md px-1 py-1 hover:bg-accent/60">
            <Checkbox
              id="routes-layer-toggle"
              className="mt-0.5"
              checked={routesOnMap && routes.length > 0}
              disabled={routes.length === 0}
              onCheckedChange={(checked) => onToggleRoutes(checked === true)}
            />
            <label
              htmlFor="routes-layer-toggle"
              className={cn("min-w-0 flex-1 cursor-pointer", routes.length === 0 && "text-muted-foreground")}
            >
              <span className="block">Routes in the collection window</span>
              {routes.length === 0 ? (
                <span className="block text-[11px] text-muted-foreground">
                  No route has stop positions yet. Generate routes from a Route Scheme to draw them.
                </span>
              ) : (
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-muted-foreground">
                  {routeCounts.map(([bucket, count]) => (
                    <span key={bucket} className="inline-flex items-center gap-1 tabular-nums">
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: ROUTE_BUCKET_COLORS[bucket] }}
                        aria-hidden
                      />
                      {count} {ROUTE_BUCKET_LABELS[bucket]}
                    </span>
                  ))}
                </span>
              )}
            </label>
          </div>
        </div>
        <div className="border-b border-border px-3 py-3" data-testid="coverage-layer">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Coverage</p>
          <div className="flex items-start gap-2 rounded-md px-1 py-1 hover:bg-accent/60">
            <Checkbox
              id="coverage-layer-toggle"
              className="mt-0.5"
              checked={coverage.on}
              onCheckedChange={(checked) => onToggleCoverage(checked === true)}
            />
            <label htmlFor="coverage-layer-toggle" className="min-w-0 flex-1 cursor-pointer">
              <span className="flex items-center gap-1.5">
                <span
                  className="size-2.5 shrink-0 rounded-full border-2 bg-background"
                  style={{ borderColor: UNCOVERED_COLOR }}
                  aria-hidden
                />
                Coverage gaps
              </span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground tabular-nums">
                {coverage.uncovered} of {coverage.needing} containers needing service are in no Route Scheme
                {coverage.unservable > 0
                  ? ` · ${coverage.unservable} scheme ${coverage.unservable === 1 ? "stop" : "stops"} cannot be served`
                  : ""}
                {` · ${coverage.schemes} ${coverage.schemes === 1 ? "scheme" : "schemes"} counted`}
              </span>
            </label>
          </div>
        </div>
        <div className="border-b border-border px-3 py-3" data-testid="schemes-layer">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">Route Schemes</p>
            <span className="text-[11px] text-muted-foreground">
              {compareIds.length === 2 ? "Comparing" : "Tick two to compare"}
            </span>
          </div>
          {schemes.length === 0 ? (
            <p className="text-xs text-muted-foreground">No Route Scheme has a readable recurrence yet.</p>
          ) : (
            <ul className="max-h-40 space-y-0.5 overflow-y-auto">
              {schemes.map((scheme) => {
                const checkboxId = `scheme-compare-${scheme.id}`
                const position = compareIds.indexOf(scheme.id)
                const side = position === 0 ? "a" : position === 1 ? "b" : null
                const full = compareIds.length >= 2 && !side
                return (
                  <li key={scheme.id} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-accent/60">
                    <Checkbox
                      id={checkboxId}
                      checked={side !== null}
                      disabled={full}
                      onCheckedChange={(checked) => onToggleCompare(scheme.id, checked === true)}
                    />
                    <label
                      htmlFor={checkboxId}
                      className={cn("min-w-0 flex-1 cursor-pointer", full && "text-muted-foreground")}
                    >
                      <span className="flex items-center gap-1.5">
                        <span
                          className="flex size-3.5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold uppercase text-white"
                          style={{ backgroundColor: side ? COMPARE_COLORS[side] : "var(--muted)" }}
                          aria-hidden
                        >
                          {side ?? ""}
                        </span>
                        <span className="truncate">{scheme.name}</span>
                      </span>
                      <span className="block truncate pl-5 text-[11px] text-muted-foreground tabular-nums">
                        {scheme.status} · {scheme.containerIds.size} {scheme.containerIds.size === 1 ? "stop" : "stops"}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <div className="border-b border-border px-3 py-3" data-testid="service-areas-layer">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Service areas</p>
          {serviceAreas.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No service area has a drawn boundary yet. Create one from a selection.
            </p>
          ) : (
            <ul className="max-h-40 space-y-0.5 overflow-y-auto">
              {serviceAreas.map((area) => {
                const checkboxId = `service-area-layer-${area.id}`
                return (
                  <li key={area.id} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-accent/60">
                    <Checkbox
                      id={checkboxId}
                      checked={enabledServiceAreaIds.has(area.id)}
                      onCheckedChange={(checked) => onToggleServiceArea(area.id, checked === true)}
                    />
                    <label htmlFor={checkboxId} className="min-w-0 flex-1 cursor-pointer">
                      <span className="flex items-center gap-1.5">
                        <span
                          className="size-2.5 shrink-0 rounded-sm border-2 border-dashed"
                          style={{ borderColor: area.color }}
                        />
                        <span className="truncate">{area.name}</span>
                      </span>
                      <span className="block truncate pl-4 text-[11px] text-muted-foreground">
                        {area.serviceProvider} · {area.status}
                      </span>
                    </label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground"
                          aria-label={`Zoom to ${area.name}`}
                          onClick={() => onZoomToServiceArea(area)}
                        >
                          <Crosshair className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="left" className="text-xs">
                        Zoom to {area.name}
                      </TooltipContent>
                    </Tooltip>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <div className="px-3 py-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">Planning areas</p>
            <div className="flex items-center gap-1 text-xs">
              <button
                type="button"
                className="text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
                onClick={onShowAllAreas}
                disabled={drawable.length === 0 || enabled === drawable.length}
              >
                Show all
              </button>
              <span className="text-muted-foreground">·</span>
              <button
                type="button"
                className="text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
                onClick={onHideAllAreas}
                disabled={enabled === 0}
              >
                Hide all
              </button>
            </div>
          </div>
          {areas.length === 0 ? (
            <p className="text-xs text-muted-foreground">No planning areas in Settings yet.</p>
          ) : (
            <ul className="max-h-64 space-y-0.5 overflow-y-auto">
              {areas.map((area) => {
                const drawableArea = area.bounds !== null
                const checkboxId = `area-layer-${area.id}`
                return (
                  <li key={area.id} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-accent/60">
                    <Checkbox
                      id={checkboxId}
                      checked={drawableArea && enabledAreaIds.has(area.id)}
                      disabled={!drawableArea}
                      onCheckedChange={(checked) => onToggleArea(area.id, checked === true)}
                    />
                    <label
                      htmlFor={checkboxId}
                      className={cn("min-w-0 flex-1 cursor-pointer", !drawableArea && "text-muted-foreground")}
                    >
                      <span className="flex items-center gap-1.5">
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: drawableArea ? area.color : undefined }}
                        />
                        <span className="truncate">{area.name}</span>
                      </span>
                      <span className="block pl-4 text-[11px] text-muted-foreground">
                        {drawableArea
                          ? `${area.containerCount} container${area.containerCount === 1 ? "" : "s"} on the map`
                          : "No located containers"}
                      </span>
                    </label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground"
                          aria-label={`Zoom to ${area.name}`}
                          disabled={!drawableArea}
                          onClick={() => onZoomToArea(area)}
                        >
                          <Crosshair className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="left" className="text-xs">
                        Zoom to {area.name}
                      </TooltipContent>
                    </Tooltip>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function BaseMapSwatch({
  option,
  selected,
  onSelect,
}: {
  option: BaseMap
  selected: boolean
  onSelect: () => void
}) {
  const { land, water, road, text } = option.swatch
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={option.label}
      onClick={onSelect}
      className={cn(
        "relative h-14 overflow-hidden rounded-md border-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-primary" : "border-transparent hover:border-border",
      )}
      style={{ backgroundColor: land }}
    >
      <span
        className="absolute -left-3 top-1 h-6 w-10 rounded-full"
        style={{ backgroundColor: water }}
        aria-hidden
      />
      <span
        className="absolute -left-2 right-0 top-8 h-1 -rotate-12"
        style={{ backgroundColor: road }}
        aria-hidden
      />
      <span
        className="absolute -top-2 bottom-0 left-9 w-1 rotate-12"
        style={{ backgroundColor: road }}
        aria-hidden
      />
      {selected && (
        <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="h-3 w-3" weight="bold" />
        </span>
      )}
      <span
        className="absolute bottom-1 left-1.5 text-[10px] font-semibold leading-none"
        style={{ color: text }}
      >
        {option.label}
      </span>
    </button>
  )
}
