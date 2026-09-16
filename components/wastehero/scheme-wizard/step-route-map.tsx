"use client"

// Step 4 — How do the generated routes look? Day tabs, per-day tiles, one
// card per route with its verdict, and the map. Regenerate re-stamps the
// estimate; with "Keep manually edited routes" off it also clears the
// edited-route locks.

import { useState, type Dispatch, type SetStateAction } from "react"
import { Factory, Lock, RefreshCw, Warehouse } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  ROUTE_ESTIMATE_STATUS_LABELS,
  formatMinutes,
  type RouteEstimateStatus,
} from "@/lib/route-schemes/estimates"
import { formatClockTime } from "@/lib/route-schemes/occurrences"
import type { GuidedSchemeData } from "@/lib/route-schemes/quick-create"
import { SERVICE_DAY_LABELS, type ServiceDay } from "@/lib/route-schemes/recurrence"
import { cn } from "@/lib/utils"

import { RouteMapSvg } from "./route-map-svg"
import type { WizardRecords } from "./use-wizard-records"
import type { WizardModel } from "./wizard-model"
import { PILL_TABS_LIST_CLASS, PILL_TABS_TRIGGER_CLASS } from "./wizard-fields"

export type EditedRoutes = Record<string, boolean>

export const editedRouteKey = (groupId: string, day: ServiceDay) => `${groupId}|${day}`

const STATUS_BADGE_CLASS: Record<RouteEstimateStatus, string> = {
  within: "border-transparent bg-emerald-50 text-emerald-700",
  tight: "border-transparent bg-amber-50 text-amber-800",
  "over-shift": "border-transparent bg-amber-50 text-amber-800",
  "over-capacity": "border-transparent bg-red-50 text-red-700",
}

export function StepRouteMap({
  data,
  model,
  records,
  editedRoutes,
  setEditedRoutes,
}: {
  data: GuidedSchemeData
  model: WizardModel
  records: WizardRecords
  editedRoutes: EditedRoutes
  setEditedRoutes: Dispatch<SetStateAction<EditedRoutes>>
}) {
  const days = model.serviceDays
  const [dayState, setDay] = useState<ServiceDay | null>(null)
  const day = dayState && days.includes(dayState) ? dayState : days[0]
  const [selected, setSelected] = useState<string | null>(null)
  const [keepEdited, setKeepEdited] = useState(true)
  const [regeneratedAt, setRegeneratedAt] = useState<Date | null>(null)

  const routes = day ? model.routesOn(day) : []
  const totals = routes.reduce(
    (sum, route) => ({ stops: sum.stops + route.estimate.stops, km: sum.km + route.estimate.km }),
    { stops: 0, km: 0 },
  )
  const depotName = model.nameOf(records.depots, data.depotId) ?? "—"
  const stationName = model.nameOf(records.stations, data.unloadingStationId) ?? "—"

  const regenerate = () => {
    if (!keepEdited) setEditedRoutes({})
    setRegeneratedAt(new Date())
  }

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
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch id="keep-edited-routes" checked={keepEdited} onCheckedChange={setKeepEdited} />
            <Label htmlFor="keep-edited-routes" className="text-sm">
              Keep manually edited routes
            </Label>
          </div>
          <Button variant="outline" className="rounded-xl" onClick={regenerate}>
            <RefreshCw /> Regenerate
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-2 lg:col-span-2">
          <div className="grid grid-cols-3 gap-2 text-sm">
            {[
              ["Routes", String(routes.length)],
              ["Stops", totals.stops.toLocaleString("en-GB")],
              ["Distance", `${totals.km} km`],
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
              const edited = Boolean(editedRoutes[editedRouteKey(group.id, day)])
              return (
                <li key={group.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(active ? null : group.id)}
                    aria-pressed={active}
                    className={cn(
                      "w-full rounded-xl border px-3 py-2.5 text-left transition-colors",
                      active ? "border-foreground bg-muted/60" : "border-border hover:bg-muted/60",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="size-2.5 rounded-full" style={{ background: color }} />
                      <span className="flex-1 truncate text-sm font-medium">{group.name}</span>
                      {edited && (
                        <Badge variant="outline" className="gap-1 text-muted-foreground">
                          <Lock className="size-3" /> Edited
                        </Badge>
                      )}
                      <Badge className={STATUS_BADGE_CLASS[route.estimate.status]}>
                        {ROUTE_ESTIMATE_STATUS_LABELS[route.estimate.status]}
                      </Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-xs tabular-nums text-muted-foreground">
                      <span>
                        {vehicle?.callsign ?? group.vehicleId} · {driver?.name ?? "Unassigned"}
                      </span>
                      <span>{route.estimate.stops.toLocaleString("en-GB")} stops</span>
                      <span>{route.estimate.km} km</span>
                      <span>{formatMinutes(route.estimate.mins)}</span>
                      <span>
                        {route.loadT} t / {route.estimate.capacityT} t
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
        </div>
        <div className="overflow-hidden rounded-2xl border border-border bg-background lg:col-span-3">
          <RouteMapSvg
            routes={routes}
            selected={selected}
            day={day}
            depotName={depotName}
            stationName={stationName}
          />
          <div className="flex h-10 items-center justify-between border-t border-border px-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-4">
              <span className="inline-flex items-center gap-1">
                <Warehouse className="size-3.5" /> {depotName}
              </span>
              <span className="inline-flex items-center gap-1">
                <Factory className="size-3.5" /> {stationName}
              </span>
            </span>
            <span>
              {regeneratedAt
                ? `Regenerated ${formatClockTime(`${regeneratedAt.getHours()}:${regeneratedAt.getMinutes()}`)}`
                : "Estimate"}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
