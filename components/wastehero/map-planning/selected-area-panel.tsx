"use client"

// The Selected area panel (2026-09-16): what a drawn shape (or a manual
// pick) holds and what already covers it — properties, collection points,
// and containers; the assumed and collected quantities over the quantities
// range; the containers by waste fraction; the Service Areas over those
// containers; the dated Routes already touching the area, by status, with a
// switch that draws them on the map — and what can happen to it: edit the
// shape, hand it to the Guided Setup wizard, or clear it. shadcn Accordion
// sections so each block folds away; every number comes from
// lib/map-planning/statistics.ts, coverage.ts, and routes.ts at render time.

import { CaretDown, Handshake, MapTrifold, PencilSimple, Plus, X, Play } from "@phosphor-icons/react/dist/ssr"

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { NO_FRACTION_COLOR } from "@/lib/map-planning/colors"
import type { ServiceAreaCoverage } from "@/lib/map-planning/coverage"
import { formatArea, formatShortDate, formatVolume, formatWeight } from "@/lib/map-planning/format"
import { polygonAreaSquareMetres } from "@/lib/map-planning/geo"
import type { MapPoint } from "@/lib/map-planning/points"
import type { AreaRoute, AreaRoutes, RouteBucket } from "@/lib/map-planning/routes"
import { containerIdsWithFraction, type SelectionShape } from "@/lib/map-planning/selection"
import type { SelectionStatistics } from "@/lib/map-planning/statistics"
import { cn } from "@/lib/utils"

import { StatusBadge } from "./status-badge"

export type SelectedAreaPanelProps = {
  shape: SelectionShape | null
  stats: SelectionStatistics
  serviceAreas: readonly ServiceAreaCoverage[]
  routes: AreaRoutes
  /** Whether the routes are drawn on the map right now. */
  routesOnMap: boolean
  onToggleRoutesOnMap: () => void
  /** Replay a route stop by stop on the map. */
  onPlayRoute: (route: AreaRoute) => void
  /** The selected containers by address — the Containers list. */
  containers: readonly MapPoint[]
  /** What the map is pointing at, so the matching rows stand out. */
  highlightedContainerIds: ReadonlySet<string>
  highlightedRouteId: string | null
  /** The pointer rests on a row naming these containers, or left one (null). */
  onHoverContainers: (containerIds: readonly string[] | null) => void
  onHoverRoute: (routeId: string | null) => void
  onOpenContainer: (point: MapPoint) => void
  /** "September 16, 2026 – September 22, 2026", or "Per collection" without a window. */
  quantitiesLabel: string
  colorFor: (fraction: string) => string
  editing: boolean
  onToggleEdit: () => void
  canCreateScheme: boolean
  onCreateScheme: () => void
  canCreateServiceArea: boolean
  onCreateServiceArea: () => void
  onClose: () => void
  className?: string
}

const SHAPE_LABELS: Readonly<Record<SelectionShape["kind"], string>> = {
  rectangle: "Rectangle",
  polygon: "Polygon",
}

const SECTIONS = ["overview", "quantities", "fractions", "service-areas", "routes", "containers"]
/** Routes listed under the counts before the list folds into "+N more". */
const MAX_LISTED_ROUTES = 4

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

export function SelectedAreaPanel({
  shape,
  stats,
  serviceAreas,
  routes,
  routesOnMap,
  onToggleRoutesOnMap,
  onPlayRoute,
  containers,
  highlightedContainerIds,
  highlightedRouteId,
  onHoverContainers,
  onHoverRoute,
  onOpenContainer,
  quantitiesLabel,
  colorFor,
  editing,
  onToggleEdit,
  canCreateScheme,
  onCreateScheme,
  canCreateServiceArea,
  onCreateServiceArea,
  onClose,
  className,
}: SelectedAreaPanelProps) {
  const subtitle = shape
    ? `${SHAPE_LABELS[shape.kind]} · ${formatArea(polygonAreaSquareMetres(shape.polygon))}`
    : "Manual selection"
  const maxFraction = Math.max(1, ...stats.byFraction.map(([, count]) => count))

  return (
    <section
      aria-label="Selected area"
      data-testid="selected-area"
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border border-border bg-background/95 text-sm shadow-lg backdrop-blur",
        className,
      )}
    >
      <header className="flex items-start gap-3 px-5 pb-4 pt-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold tracking-tight">Selected area</h2>
          <p className="mt-0.5 text-sm text-muted-foreground" data-testid="selected-area-subtitle">
            {subtitle}
          </p>
        </div>
        {shape && (
          <Button
            variant={editing ? "default" : "outline"}
            size="sm"
            className="h-8 gap-1.5"
            onClick={onToggleEdit}
            aria-pressed={editing}
          >
            <PencilSimple className="h-4 w-4" />
            {editing ? "Done" : "Edit"}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground"
          onClick={onClose}
          aria-label="Clear selection"
        >
          <X className="h-4 w-4" />
        </Button>
      </header>
      <Separator />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Accordion type="multiple" defaultValue={SECTIONS}>
          <AccordionItem value="overview">
            <SectionTrigger>Overview</SectionTrigger>
            <AccordionContent className="px-5 pb-5">
              <dl className="grid grid-cols-3 gap-3">
                <StatTile label="Properties" value={stats.properties} />
                <StatTile label="Collection points" value={stats.collectionPoints} />
                <StatTile label="Containers" value={stats.containers} />
              </dl>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="quantities">
            <SectionTrigger aside={quantitiesLabel} asideTestId="quantities-range">
              Quantities
            </SectionTrigger>
            <AccordionContent className="px-5 pb-5">
              <dl className="divide-y divide-border/70">
                <Row label="Assumed weight" value={formatWeight(stats.assumedWeightKg)} />
                <Row label="Collected weight" value={formatWeight(stats.collectedWeightKg)} />
                <Row label="Assumed volume" value={formatVolume(stats.assumedVolumeLitres)} />
                <Row label="Waste services" value={plural(stats.activeAgreements, "active agreement")} />
              </dl>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="fractions">
            <SectionTrigger>Containers by waste fraction</SectionTrigger>
            <AccordionContent className="px-5 pb-5">
              {stats.byFraction.length === 0 ? (
                <EmptyLine>No containers inside the shape yet.</EmptyLine>
              ) : (
                <ul className="-mx-2 space-y-1">
                  {stats.byFraction.map(([fraction, count]) => (
                    <li
                      key={fraction}
                      className="flex items-center gap-3 rounded-md px-2 py-0.5 hover:bg-accent/60"
                      data-fraction-row={fraction}
                      onMouseEnter={() => onHoverContainers(containerIdsWithFraction(containers, fraction))}
                      onMouseLeave={() => onHoverContainers(null)}
                    >
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: colorFor(fraction) }}
                      />
                      <span className="w-28 shrink-0 truncate">{fraction}</span>
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <span
                          className="block h-full rounded-full"
                          style={{
                            width: `${Math.round((count / maxFraction) * 100)}%`,
                            backgroundColor: colorFor(fraction),
                          }}
                        />
                      </span>
                      <span className="w-6 shrink-0 text-right font-semibold tabular-nums">{count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="service-areas">
            <SectionTrigger aside={serviceAreas.length ? String(serviceAreas.length) : undefined}>
              Service areas
            </SectionTrigger>
            <AccordionContent className="px-5 pb-5">
              {serviceAreas.length === 0 ? (
                <EmptyLine>No service area covers these containers.</EmptyLine>
              ) : (
                <ul className="divide-y divide-border/70">
                  {serviceAreas.map((area) => (
                    <li key={area.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{area.name}</span>
                          <StatusBadge status={area.status} />
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {area.serviceProvider} · {area.services}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {plural(area.containers, "container")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="routes">
            <SectionTrigger aside={routes.total ? String(routes.total) : undefined}>
              Existing routes in this area
            </SectionTrigger>
            <AccordionContent className="px-5 pb-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {routes.total === 0
                    ? "No dated route touches these containers."
                    : `${plural(routes.total, "route")} ${routes.total === 1 ? "touches" : "touch"} these containers.`}
                </p>
                <Button
                  variant={routesOnMap ? "default" : "outline"}
                  size="sm"
                  className="h-7 shrink-0 gap-1.5 text-xs"
                  disabled={routes.total === 0}
                  aria-pressed={routesOnMap}
                  onClick={onToggleRoutesOnMap}
                >
                  <MapTrifold className="h-3.5 w-3.5" />
                  {routesOnMap ? "Hide from map" : "See on map"}
                </Button>
              </div>
              <dl className="divide-y divide-border/70" data-testid="area-routes">
                <CountRow label="Total routes" value={routes.total} />
                <CountRow label="Awaiting" value={routes.awaiting} tone="awaiting" />
                <CountRow label="In progress" value={routes.inProgress} tone="in-progress" />
                <CountRow label="Completed" value={routes.completed} tone="completed" />
              </dl>
              {routes.routes.length > 0 && (
                <ul className="-mx-2 mt-3 divide-y divide-border/70">
                  {routes.routes.slice(0, MAX_LISTED_ROUTES).map((route) => (
                    <li
                      key={route.id}
                      className={cn(
                        "flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/60",
                        highlightedRouteId === route.id && "bg-accent",
                      )}
                      data-route-row={route.id}
                      data-highlighted={highlightedRouteId === route.id ? "true" : undefined}
                      onMouseEnter={() => onHoverRoute(route.id)}
                      onMouseLeave={() => onHoverRoute(null)}
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: route.color }}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 truncate font-medium">{route.name}</span>
                      <StatusBadge status={route.status} />
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {route.date
                          ? formatShortDate(route.date)
                          : route.stops.length
                            ? plural(route.stops.length, "stop")
                            : "No stop data"}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0"
                        aria-label={`Play route ${route.name}`}
                        disabled={route.stops.length === 0}
                        onClick={() => onPlayRoute(route)}
                      >
                        <Play className="h-3.5 w-3.5" />
                      </Button>
                    </li>
                  ))}
                  {routes.routes.length > MAX_LISTED_ROUTES && (
                    <li className="px-2 pt-2 text-xs text-muted-foreground">
                      +{routes.routes.length - MAX_LISTED_ROUTES} more
                    </li>
                  )}
                </ul>
              )}
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="containers">
            <SectionTrigger aside={containers.length ? String(containers.length) : undefined}>
              Containers
            </SectionTrigger>
            <AccordionContent className="px-5 pb-5">
              {containers.length === 0 ? (
                <EmptyLine>No containers inside the shape yet.</EmptyLine>
              ) : (
                <ul className="-mx-2 max-h-72 overflow-y-auto" data-testid="selected-containers">
                  {containers.map((point) => {
                    const highlighted = point.containerIds.some((id) => highlightedContainerIds.has(id))
                    return (
                      <li key={point.id}>
                        <button
                          type="button"
                          data-container-row={point.id}
                          data-highlighted={highlighted ? "true" : undefined}
                          className={cn(
                            "flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            highlighted && "bg-accent",
                          )}
                          onMouseEnter={() => onHoverContainers(point.containerIds)}
                          onMouseLeave={() => onHoverContainers(null)}
                          onFocus={() => onHoverContainers(point.containerIds)}
                          onBlur={() => onHoverContainers(null)}
                          onClick={() => onOpenContainer(point)}
                        >
                          <span
                            className="size-2.5 shrink-0 rounded-full"
                            style={{
                              backgroundColor: point.fractions[0] ? colorFor(point.fractions[0]) : NO_FRACTION_COLOR,
                            }}
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{point.label}</span>
                            <span className="block truncate text-xs text-muted-foreground">{point.sublabel}</span>
                          </span>
                          <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
                            {point.fractions.join(" · ")}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>

      {(canCreateScheme || canCreateServiceArea) && (
        <>
          <Separator />
          <footer className="flex flex-col gap-2 px-5 py-4">
            {canCreateScheme && (
              <Button className="h-9 w-full" onClick={onCreateScheme} disabled={stats.containers === 0}>
                <Plus className="h-4 w-4" weight="bold" />
                Create route scheme
              </Button>
            )}
            {canCreateServiceArea && (
              <Button
                variant="outline"
                className="h-9 w-full"
                onClick={onCreateServiceArea}
                disabled={stats.containers === 0}
              >
                <Handshake className="h-4 w-4" />
                Create service area
              </Button>
            )}
          </footer>
        </>
      )}
    </section>
  )
}

function SectionTrigger({
  children,
  aside,
  asideTestId,
}: {
  children: React.ReactNode
  aside?: string
  asideTestId?: string
}) {
  return (
    <AccordionTrigger className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:bg-transparent hover:text-foreground">
      <span className="flex-1 text-left">{children}</span>
      {aside && (
        <span className="max-w-[60%] truncate text-[11px] font-medium normal-case tracking-normal" data-testid={asideTestId}>
          {aside}
        </span>
      )}
      <CaretDown className="h-3.5 w-3.5 shrink-0 transition-transform duration-200" />
    </AccordionTrigger>
  )
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-muted/60 px-3 py-3">
      <dd className="text-2xl font-semibold leading-none tracking-tight tabular-nums">
        {value.toLocaleString("en-US")}
      </dd>
      <dt className="mt-1.5 text-xs text-muted-foreground">{label}</dt>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

const COUNT_TONES: Readonly<Record<RouteBucket, { dot: string; value: string }>> = {
  awaiting: { dot: "bg-amber-500", value: "text-amber-600 dark:text-amber-400" },
  "in-progress": { dot: "bg-blue-500", value: "text-blue-600 dark:text-blue-400" },
  completed: { dot: "bg-emerald-500", value: "text-emerald-600 dark:text-emerald-400" },
}

/** A label/value row with the status colour on the dot and the number. */
function CountRow({ label, value, tone }: { label: string; value: number; tone?: RouteBucket }) {
  const colours = tone ? COUNT_TONES[tone] : null
  return (
    <div className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0">
      <dt className="flex items-center gap-2 text-muted-foreground">
        <span className={cn("size-2.5 rounded-full", colours ? colours.dot : "bg-foreground")} aria-hidden />
        {label}
      </dt>
      <dd className={cn("text-base font-semibold tabular-nums", colours?.value)}>{value}</dd>
    </div>
  )
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>
}
