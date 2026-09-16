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

import { CaretDown, MapTrifold, PencilSimple, Plus, X } from "@phosphor-icons/react/dist/ssr"

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import type { ServiceAreaCoverage } from "@/lib/map-planning/coverage"
import { formatArea, formatShortDate, formatVolume, formatWeight } from "@/lib/map-planning/format"
import { polygonAreaSquareMetres } from "@/lib/map-planning/geo"
import type { AreaRoutes } from "@/lib/map-planning/routes"
import type { SelectionShape } from "@/lib/map-planning/selection"
import type { SelectionStatistics } from "@/lib/map-planning/statistics"
import { cn } from "@/lib/utils"

export type SelectedAreaPanelProps = {
  shape: SelectionShape | null
  stats: SelectionStatistics
  serviceAreas: readonly ServiceAreaCoverage[]
  routes: AreaRoutes
  /** Whether the routes are drawn on the map right now. */
  routesOnMap: boolean
  onToggleRoutesOnMap: () => void
  /** "September 16, 2026 – September 22, 2026", or "Per collection" without a window. */
  quantitiesLabel: string
  colorFor: (fraction: string) => string
  editing: boolean
  onToggleEdit: () => void
  canCreateScheme: boolean
  onCreateScheme: () => void
  onClose: () => void
  className?: string
}

const SHAPE_LABELS: Readonly<Record<SelectionShape["kind"], string>> = {
  rectangle: "Rectangle",
  polygon: "Polygon",
}

const SECTIONS = ["overview", "quantities", "fractions", "service-areas", "routes"]
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
  quantitiesLabel,
  colorFor,
  editing,
  onToggleEdit,
  canCreateScheme,
  onCreateScheme,
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
                <ul className="space-y-2.5">
                  {stats.byFraction.map(([fraction, count]) => (
                    <li key={fraction} className="flex items-center gap-3">
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
              <dl className="grid grid-cols-2 gap-3" data-testid="area-routes">
                <StatTile label="Total routes" value={routes.total} />
                <StatTile label="Awaiting" value={routes.awaiting} />
                <StatTile label="In progress" value={routes.inProgress} />
                <StatTile label="Completed" value={routes.completed} />
              </dl>
              {routes.routes.length > 0 && (
                <ul className="mt-3 divide-y divide-border/70">
                  {routes.routes.slice(0, MAX_LISTED_ROUTES).map((route) => (
                    <li key={route.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
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
                    </li>
                  ))}
                  {routes.routes.length > MAX_LISTED_ROUTES && (
                    <li className="pt-2 text-xs text-muted-foreground">
                      +{routes.routes.length - MAX_LISTED_ROUTES} more
                    </li>
                  )}
                </ul>
              )}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>

      {canCreateScheme && (
        <>
          <Separator />
          <footer className="px-5 py-4">
            <Button className="h-9 w-full" onClick={onCreateScheme} disabled={stats.containers === 0}>
              <Plus className="h-4 w-4" weight="bold" />
              Create route scheme
            </Button>
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

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>
}

const POSITIVE_STATUSES = new Set(["active", "scheduled", "effective", "valid"])
const WARNING_STATUSES = new Set(["expiring", "overlap", "validated", "upcoming", "draft"])

function StatusBadge({ status }: { status: string }) {
  const key = status.trim().toLowerCase()
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 shrink-0 px-1.5 text-[10px] font-medium",
        POSITIVE_STATUSES.has(key) &&
          "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
        WARNING_STATUSES.has(key) &&
          "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
      )}
    >
      {status}
    </Badge>
  )
}
