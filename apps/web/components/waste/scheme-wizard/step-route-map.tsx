"use client"

// Step 4 — How do the generated routes look? Day tabs, per-day tiles, one
// card per route with its verdict, and the map. Since Issue #39 the map is
// the planning map's kind: each route's stops placed the way the planning map
// places containers, the depot and the station where the registry puts them,
// and the line between them the road a routing engine answered with, fetched
// through the same hook and cache as the planning map's dated routes. Every
// number says what it is: a route whose road is known shows the routed
// distance and the drive time plus the catalogue's emptying times plus the
// closeout generation allows past the last stop (Road); a route still
// waiting for the road, or refused one, shows the prototype's heuristic
// (Estimate). The stop order is generation's — the optimiser is
// a later job (ADR-0002) — and the footer says so. Regenerate re-stamps the
// numbers. There is no in-wizard route editing yet, so there is no "keep
// edited routes" switch and no Edited lock — nothing to protect.

import { useMemo, useState } from "react"
import dynamic from "next/dynamic"
import { useTheme } from "next-themes"
import { Factory, RefreshCw, Warehouse } from "lucide-react"

import { useRoadGeometries } from "@/components/waste/map-planning/use-road-geometries"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { defaultBaseMapForTheme } from "@/lib/map-planning/base-maps"
import { previewsBounds } from "@waste/domain/map-planning/route-preview"
import {
  ROUTE_ESTIMATE_STATUS_LABELS,
  formatKilometres,
  formatMinutes,
  routeEstimateAdapter,
  type RouteEstimateBasis,
  type RouteEstimateStatus,
  type RouteMeasure,
} from "@waste/domain/route-schemes/estimates"
import { formatClockTime } from "@waste/domain/route-schemes/occurrences"
import type { GuidedSchemeData } from "@waste/domain/route-schemes/quick-create"
import { SERVICE_DAY_LABELS, type ServiceDay } from "@waste/domain/route-schemes/recurrence"
import { cn } from "@/lib/utils"

import type { WizardRecords } from "./use-wizard-records"
import type { WizardModel, WizardRoute } from "./wizard-model"
import { PILL_TABS_LIST_CLASS, PILL_TABS_TRIGGER_CLASS } from "./wizard-fields"

const RouteMap = dynamic(() => import("./route-map").then((module) => module.RouteMap), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full rounded-none" />,
})

const STATUS_BADGE_CLASS: Record<RouteEstimateStatus, string> = {
  within: "border-transparent bg-emerald-50 text-emerald-700",
  tight: "border-transparent bg-amber-50 text-amber-800",
  "over-shift": "border-transparent bg-amber-50 text-amber-800",
  "over-capacity": "border-transparent bg-red-50 text-red-700",
}

/** What the footer says the day's numbers are: one basis when every route agrees, both otherwise. */
function basisLabel(routes: readonly WizardRoute[]): string {
  const bases = new Set<RouteEstimateBasis>(routes.map((route) => route.estimate.basis))
  if (bases.size === 0) return routeEstimateAdapter.labels.estimate
  if (bases.size === 1) return routeEstimateAdapter.labels[[...bases][0]]
  return `${routeEstimateAdapter.labels.road} · ${routeEstimateAdapter.labels.estimate} while roads load`
}

export function StepRouteMap({
  data,
  model,
  records,
}: {
  data: GuidedSchemeData
  model: WizardModel
  records: WizardRecords
}) {
  const days = model.serviceDays
  const [dayState, setDay] = useState<ServiceDay | null>(null)
  const day = dayState && days.includes(dayState) ? dayState : days[0]
  const [selected, setSelected] = useState<string | null>(null)
  const [regeneratedAt, setRegeneratedAt] = useState<Date | null>(null)
  const { resolvedTheme } = useTheme()
  const baseMap = defaultBaseMapForTheme(resolvedTheme === "dark" ? "dark" : "light")

  // The day's routes without a road, for their stops; then with the roads
  // the hook has for them, for their numbers.
  const drafted = useMemo(() => (day ? model.routesOn(day) : []), [day, model])
  const roadRoutes = useMemo(
    () => drafted.map((route) => ({ id: route.routeId, stops: route.preview.stops })),
    [drafted],
  )
  const roadStates = useRoadGeometries(roadRoutes)
  const roads = useMemo(() => {
    const measures = new Map<string, RouteMeasure | null>()
    for (const route of drafted) {
      const state = roadStates.get(route.routeId)
      measures.set(
        route.routeId,
        state?.status === "ready" && state.geometry.legs.length > 0
          ? { distanceMetres: state.geometry.distanceMetres, durationSeconds: state.geometry.durationSeconds }
          : null,
      )
    }
    return measures
  }, [drafted, roadStates])
  const routes = useMemo(() => (day ? model.routesOn(day, roads) : []), [day, model, roads])

  const totals = routes.reduce(
    (sum, route) => ({ stops: sum.stops + route.estimate.stops, km: sum.km + route.estimate.km }),
    { stops: 0, km: 0 },
  )
  const unplaced = routes.reduce((sum, route) => sum + route.preview.unplaced, 0)
  const bounds = useMemo(() => previewsBounds(routes.map((route) => route.preview)), [routes])
  const depotName = model.nameOf(records.depots, data.depotId) ?? "—"
  const stationName = model.nameOf(records.stations, data.unloadingStationId) ?? "—"
  const anyRoute = routes[0]
  // Bases the routes leave off the line: named on step 1 but not placed by the registry.
  const missingBases = [
    data.depotId && anyRoute && !anyRoute.preview.fromDepot ? `${depotName} has no map position` : null,
    data.unloadingStationId && anyRoute && !anyRoute.preview.toStation ? `${stationName} has no map position` : null,
  ].filter((text): text is string => text !== null)

  const regenerate = () => setRegeneratedAt(new Date())

  if (!day) return null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={day} onValueChange={(value) => setDay(value as ServiceDay)}>
          <TabsList className={PILL_TABS_LIST_CLASS}>
            {days.map((candidate) => (
              <TabsTrigger key={candidate} value={candidate} className={PILL_TABS_TRIGGER_CLASS}>
                {SERVICE_DAY_LABELS[candidate]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Button variant="outline" className="rounded-xl" onClick={regenerate}>
          <RefreshCw /> Regenerate
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-2 lg:col-span-2">
          <div className="grid grid-cols-3 gap-2 text-sm">
            {[
              ["Routes", String(routes.length)],
              ["Stops", totals.stops.toLocaleString("en-GB")],
              ["Distance", formatKilometres(totals.km)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-border px-3 py-2">
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className="font-medium tabular-nums">{value}</div>
              </div>
            ))}
          </div>
          <ul className="space-y-2">
            {routes.map((route) => {
              const { group, color, vehicle, driver } = route.summary
              const active = selected === group.id
              const roadState = roadStates.get(route.routeId)
              return (
                <li key={group.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(active ? null : group.id)}
                    aria-pressed={active}
                    data-route-basis={route.estimate.basis}
                    className={cn(
                      "w-full rounded-xl border px-3 py-2.5 text-left transition-colors",
                      active ? "border-foreground bg-muted/60" : "border-border hover:bg-muted/60",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="size-2.5 rounded-full" style={{ background: color }} />
                      <span className="flex-1 truncate text-sm font-medium">{group.name}</span>
                      <Badge className={STATUS_BADGE_CLASS[route.estimate.status]}>
                        {ROUTE_ESTIMATE_STATUS_LABELS[route.estimate.status]}
                      </Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-xs tabular-nums text-muted-foreground">
                      <span>
                        {vehicle?.callsign ?? group.vehicleId} · {driver?.name ?? "Unassigned"}
                      </span>
                      <span>{route.estimate.stops.toLocaleString("en-GB")} stops</span>
                      <span>{formatKilometres(route.estimate.km)}</span>
                      <span>{formatMinutes(route.estimate.mins)}</span>
                      <span>
                        {route.loadT} t / {route.estimate.capacityT} t
                      </span>
                      <span data-testid="route-basis">
                        {route.estimate.basis === "road"
                          ? routeEstimateAdapter.labels.road
                          : roadState?.status === "failed"
                            ? `${routeEstimateAdapter.labels.estimate} · road unavailable`
                            : route.preview.stops.length < 2
                              ? routeEstimateAdapter.labels.estimate
                              : `${routeEstimateAdapter.labels.estimate} · road loading`}
                      </span>
                    </div>
                  </button>
                </li>
              )
            })}
            {routes.length === 0 && (
              <li className="flex h-24 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
                No routes on {SERVICE_DAY_LABELS[day]}
              </li>
            )}
          </ul>
          {(unplaced > 0 || missingBases.length > 0) && (
            <p className="text-xs text-muted-foreground" data-testid="route-map-unplaced">
              {[
                unplaced > 0
                  ? `${unplaced.toLocaleString("en-GB")} container${unplaced === 1 ? "" : "s"} without a map position ${unplaced === 1 ? "is" : "are"} counted but not drawn.`
                  : null,
                ...missingBases.map((text) => `${text} and is left off the line.`),
              ]
                .filter(Boolean)
                .join(" ")}
            </p>
          )}
        </div>
        <div className="overflow-hidden rounded-2xl border border-border bg-background lg:col-span-3">
          <div className="h-[400px]">
            <RouteMap routes={routes} roads={roadStates} selected={selected} day={day} baseMap={baseMap} bounds={bounds} />
          </div>
          <div className="flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border px-4 py-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-4">
              <span className="inline-flex items-center gap-1">
                <Warehouse className="size-3.5" /> {depotName}
              </span>
              <span className="inline-flex items-center gap-1">
                <Factory className="size-3.5" /> {stationName}
              </span>
            </span>
            <span data-testid="route-map-basis">
              {basisLabel(routes)}
              {" · Stops in generation order, not optimised"}
              {regeneratedAt
                ? ` · Regenerated ${formatClockTime(`${regeneratedAt.getHours()}:${regeneratedAt.getMinutes()}`)}`
                : ""}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
