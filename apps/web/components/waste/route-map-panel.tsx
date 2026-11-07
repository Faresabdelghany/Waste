"use client"

// The Map panel of a route's page on the Pilot: the route drawn on a real map
// (route-map-canvas.tsx) from what the API answered — each stop where its
// container, property or shared point stands, the depot and the unloading
// station where they stand, and the road of its active Plan once that Plan is
// measured (`GET /plans/:id`, the one route's alone), else the places joined
// straight. Under the map, what the line is and which stops it could not
// place; Expand opens the same map large.

import dynamic from "next/dynamic"
import { useTheme } from "next-themes"
import { useEffect, useMemo, useState } from "react"
import { CornersOut } from "@phosphor-icons/react/dist/ssr"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { useApiClient } from "@/components/waste/api-session-store"
import { useServerModuleState } from "@/components/waste/business-record-store"
import { useRecordsByServerId } from "@/components/waste/commands/use-command-support"
import type { RouteMapPoint, RouteMapStopState } from "@/components/waste/route-map-canvas"
import { CONTAINERS_MODULE } from "@/lib/api/records/containers"
import { planDetail } from "@/lib/api/routing"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { PROPERTIES_MODULE, SHARED_POINTS_MODULE } from "@/lib/data/properties"
import { FIXTURE_GAZETTEER } from "@waste/fixtures/gazetteer"
import { defaultBaseMapForTheme } from "@/lib/map-planning/base-maps"
import { activePlanOf, planReading, routePlanOf } from "@/lib/map-planning/plan-readings"
import { roadGeometryOfLegs, type RoadGeometry } from "@/lib/map-planning/road-geometry"
import { containerLocation, placeLocation } from "@/lib/prototype/map-planning/positions"
import type { Pickup } from "@waste/contracts/pickups"
import type { PlanDetail } from "@waste/contracts/plans"

const RouteMapCanvas = dynamic(() => import("./route-map-canvas").then((module) => module.RouteMapCanvas), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full rounded-none" />,
})

/** Resources › Depots & Unloading: where a route's depot and unloading station are read from (`placesModule`). */
const PLACES_MODULE = { workspaceId: "resources", moduleId: "depots" } as const

const STATE_OF: Record<Pickup["status"], RouteMapStopState> = {
  planned: "open",
  completed: "done",
  skipped: "missed",
  failed: "missed",
}

/** A route's stops and bases where the map can place them, in the order the route visits them, and the stops it cannot. */
function useRoutePlaces(record: BusinessRecord, pickups: readonly Pickup[] | undefined, stopName: (pickup: Pickup) => string) {
  const containerOf = useRecordsByServerId(CONTAINERS_MODULE)
  const propertyOf = useRecordsByServerId(PROPERTIES_MODULE)
  const sharedPointOf = useRecordsByServerId(SHARED_POINTS_MODULE)
  const places = useServerModuleState(PLACES_MODULE.workspaceId, PLACES_MODULE.moduleId)?.records ?? []
  const placeOf = (webId: unknown) => (typeof webId === "string" && webId !== "" ? places.find((place) => place.id === webId) : undefined)

  const located = (pickup: Pickup) => {
    if (pickup.containerId !== null) {
      const container = containerOf(pickup.containerId)
      return container === undefined ? null : containerLocation(container, FIXTURE_GAZETTEER)
    }
    const place = pickup.propertyId !== null ? propertyOf(pickup.propertyId) : pickup.sharedCollectionPointId !== null ? sharedPointOf(pickup.sharedCollectionPointId) : undefined
    return place === undefined ? null : placeLocation(place, FIXTURE_GAZETTEER)
  }

  const points: RouteMapPoint[] = []
  const unplaced: string[] = []
  const depot = placeOf(record.submittedValues?.depotId)
  const depotAt = depot === undefined ? null : placeLocation(depot, FIXTURE_GAZETTEER)
  if (depot !== undefined && depotAt !== null) points.push({ kind: "depot", key: "depot", at: depotAt, title: `Depot · ${depot.name}` })
  const ordered = [...(pickups ?? [])].sort((a, b) => (a.sequence ?? a.position) - (b.sequence ?? b.position))
  for (const pickup of ordered) {
    const at = located(pickup)
    const number = pickup.sequence ?? pickup.position
    if (at === null) unplaced.push(`${number}. ${stopName(pickup)}`)
    else points.push({ kind: "stop", key: pickup.id, at, number, title: `${number}. ${stopName(pickup)}`, state: STATE_OF[pickup.status] })
  }
  const unloading = placeOf(record.submittedValues?.unloadingStationId)
  const unloadingAt = unloading === undefined ? null : placeLocation(unloading, FIXTURE_GAZETTEER)
  if (unloading !== undefined && unloadingAt !== null) points.push({ kind: "unloading", key: "unloading", at: unloadingAt, title: `Unloading station · ${unloading.name}` })
  return { points, unplaced }
}

/** The active Plan's road once it is measured, fetched once per Plan, and what the line reads as. */
function usePlanRoad(record: BusinessRecord): { road: RoadGeometry | null; reading: string } {
  const client = useApiClient()
  const active = activePlanOf(record)
  const [fetched, setFetched] = useState<PlanDetail | undefined>(undefined)
  const [failed, setFailed] = useState<string | null>(null)
  const planId = active?.id
  const ready = active?.status === "ready"

  useEffect(() => {
    if (client === null || planId === undefined || !ready) return
    const controller = new AbortController()
    planDetail(client, planId, controller.signal).then(
      (detail) => {
        setFetched(detail)
        setFailed(null)
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setFailed(error instanceof Error ? error.message : "The road could not be read.")
      },
    )
    return () => controller.abort()
  }, [client, planId, ready])

  const detail = fetched !== undefined && fetched.id === planId ? fetched : undefined
  const road = useMemo(() => (detail?.status === "ready" ? roadGeometryOfLegs(detail.legs, { provider: detail.provider, optimised: detail.solver === "optimiser" }) : null), [detail])
  const plan = routePlanOf(active, null, detail)
  if (plan === null) return { road: null, reading: "Not measured yet: the places are joined straight, in the order they will be visited." }
  if (failed !== null) return { road: null, reading: `The road could not be read: ${failed}. The places are joined straight.` }
  const sentence = planReading(plan, new Date()).sentence
  if (road !== null) return { road, reading: `The road of its active Plan · ${sentence}` }
  return { road: null, reading: `${sentence}. Until the road is read, the places are joined straight.` }
}

export function RouteMapPanel({ record, pickups, stopName }: { record: BusinessRecord; pickups: readonly Pickup[] | undefined; stopName: (pickup: Pickup) => string }) {
  const { resolvedTheme } = useTheme()
  const baseMap = defaultBaseMapForTheme(resolvedTheme === "dark" ? "dark" : "light")
  const { points, unplaced } = useRoutePlaces(record, pickups, stopName)
  const { road, reading } = usePlanRoad(record)
  const [expanded, setExpanded] = useState(false)
  const label = `${record.name} on the map: ${points.filter((point) => point.kind === "stop").length} stops`

  return (
    <div className="border-b border-border">
      <div className="relative h-[clamp(320px,50vh,600px)]">
        {pickups === undefined ? (
          <Skeleton className="h-full w-full rounded-none" />
        ) : points.length === 0 ? (
          <div className="flex h-full items-center justify-center bg-muted/40 px-6 text-center text-sm text-muted-foreground">Nothing of this route can be placed on the map yet: its stops name no place with a position.</div>
        ) : (
          <>
            {!expanded && <RouteMapCanvas points={points} road={road} baseMap={baseMap} label={label} />}
            <Button variant="outline" size="icon-sm" className="absolute bottom-3 right-3 z-20 bg-background" aria-label="Expand map" onClick={() => setExpanded(true)}>
              <CornersOut className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>
      <div className="space-y-2 px-5 py-3">
        <p className="text-xs text-muted-foreground" data-testid="route-map-reading">
          {reading}
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <Legend color="var(--primary)">To collect</Legend>
          <Legend color="var(--success)">Collected</Legend>
          <Legend color="var(--destructive)">Not collected</Legend>
          <span className="flex items-center gap-1.5">
            <span className="flex h-3.5 w-3.5 items-center justify-center rounded-[3px] bg-foreground text-[8px] font-bold text-background">D</span>
            Depot
          </span>
          <span className="flex items-center gap-1.5">
            <span className="flex h-3.5 w-3.5 items-center justify-center rounded-[3px] bg-foreground text-[8px] font-bold text-background">U</span>
            Unloading
          </span>
        </div>
        {unplaced.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Not on the map, with no position to place: {unplaced.join(", ")}.
          </p>
        )}
      </div>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent aria-describedby={undefined} className="max-w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0 sm:max-w-6xl">
          <DialogHeader className="border-b border-border px-5 py-4 pr-12">
            <DialogTitle>{record.name} · Route map</DialogTitle>
          </DialogHeader>
          <div className="relative h-[min(78vh,760px)] min-h-[360px]">{expanded && <RouteMapCanvas points={points} road={road} baseMap={baseMap} label={label} />}</div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Legend({ color, children }: { color: string; children: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-3 w-3 rounded-full border-2 border-background ring-1 ring-border" style={{ backgroundColor: color }} />
      {children}
    </span>
  )
}
