// The dated Routes that touch a map selection (2026-09-16): "Existing routes
// in this area" — how many are awaiting, in progress, or completed, and the
// stops each one makes, in order, so the map can draw them. A route is
// linked through its Pickups (typed routeId/containerId first, the Route
// and Container ID display facts second); a fixture route day without
// pickups falls back to its Area fact naming a selected container's
// planning area. Cancelled routes are never counted. Pure data logic.

import type { BusinessRecord } from "../data/business-modules"
import { isSoftDeleted } from "../data/record-visibility"
import { isIsoDate } from "../route-schemes/recurrence"
import type { LngLat } from "./geo"
import { containerLocation } from "./positions"
import { parseDisplayDate } from "./schedule"

export type RouteBucket = "awaiting" | "in-progress" | "completed"

export type AreaRoute = {
  id: string
  name: string
  status: string
  bucket: RouteBucket
  /** The date the route runs, ISO, when the record says. */
  date: string | null
  color: string
  /** Located stops in stop order — empty when the route's pickups are unknown. */
  stops: LngLat[]
  containerIds: string[]
}

export type AreaRoutes = {
  total: number
  awaiting: number
  inProgress: number
  completed: number
  /** Awaiting first, then in progress, then completed; by date within a bucket. */
  routes: AreaRoute[]
}

/** Route line colours, cycled in list order. */
export const ROUTE_LINE_PALETTE = ["#dc2626", "#7c3aed", "#0891b2", "#d97706", "#059669", "#db2777"] as const

const BUCKETS: ReadonlyArray<[RouteBucket, ReadonlySet<string>]> = [
  ["completed", new Set(["completed"])],
  ["in-progress", new Set(["active", "in progress", "running", "started", "paused"])],
  ["awaiting", new Set(["draft", "planned", "ready", "next", "scheduled", "assigned", "awaiting"])],
]

const BUCKET_ORDER: Readonly<Record<RouteBucket, number>> = { awaiting: 0, "in-progress": 1, completed: 2 }

const EMPTY_FACT = "—"
const lower = (value: string) => value.trim().toLowerCase()
const clean = (value: string | boolean | undefined): string | undefined => {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed && trimmed !== EMPTY_FACT ? trimmed : undefined
}

export function routeBucket(status: string): RouteBucket | null {
  const key = lower(status)
  return BUCKETS.find(([, statuses]) => statuses.has(key))?.[0] ?? null
}

function routeDate(route: BusinessRecord): string | null {
  const typed = clean(route.submittedValues?.actualDate) ?? clean(route.submittedValues?.serviceDate)
  if (typed && isIsoDate(typed)) return typed
  return parseDisplayDate(route.facts.Date)
}

const stopNumber = (pickup: BusinessRecord): number => {
  const value = Number.parseInt(clean(pickup.facts.Stop) ?? "", 10)
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
}

/** Every key a pickup may use to name its container. */
function pickupContainerKeys(pickup: BusinessRecord): string[] {
  return [clean(pickup.submittedValues?.containerId), clean(pickup.facts["Container ID"])?.toLowerCase()].filter(
    (key): key is string => Boolean(key),
  )
}

/** Every key a pickup may use to name its route. */
function pickupRouteKeys(pickup: BusinessRecord): string[] {
  return [clean(pickup.submittedValues?.routeId), clean(pickup.facts.Route)?.toLowerCase()].filter(
    (key): key is string => Boolean(key),
  )
}

export function routesInSelection(
  selected: readonly BusinessRecord[],
  routes: readonly BusinessRecord[],
  pickups: readonly BusinessRecord[],
  allContainers: readonly BusinessRecord[],
): AreaRoutes {
  const empty: AreaRoutes = { total: 0, awaiting: 0, inProgress: 0, completed: 0, routes: [] }
  if (selected.length === 0) return empty

  // Container lookup by id and by display id, for locations and identity.
  const containersByKey = new Map<string, BusinessRecord>()
  for (const container of allContainers) {
    containersByKey.set(container.id, container)
    const label = clean(container.facts["Container ID"])
    if (label) containersByKey.set(label.toLowerCase(), container)
  }
  const selectedIds = new Set(selected.map((container) => container.id))
  const selectedAreas = new Set(
    selected.map((container) => clean(container.facts["Planning area"])?.toLowerCase()).filter(Boolean) as string[],
  )

  // Pickups grouped under every key their route may go by.
  const pickupsByRoute = new Map<string, BusinessRecord[]>()
  for (const pickup of pickups) {
    if (isSoftDeleted(pickup)) continue
    for (const key of pickupRouteKeys(pickup)) {
      const list = pickupsByRoute.get(key) ?? []
      list.push(pickup)
      pickupsByRoute.set(key, list)
    }
  }

  const rows: AreaRoute[] = []
  for (const route of routes) {
    if (isSoftDeleted(route)) continue
    const bucket = routeBucket(route.status)
    if (!bucket) continue
    const routeKeys = [route.id, lower(route.name), clean(route.facts["Route ID"])?.toLowerCase()].filter(Boolean) as string[]
    const routePickups = Array.from(
      new Map(routeKeys.flatMap((key) => pickupsByRoute.get(key) ?? []).map((pickup) => [pickup.id, pickup])).values(),
    ).sort((a, b) => stopNumber(a) - stopNumber(b) || a.id.localeCompare(b.id))

    const stopContainers = routePickups
      .map((pickup) => pickupContainerKeys(pickup).map((key) => containersByKey.get(key)).find(Boolean))
      .filter((container): container is BusinessRecord => Boolean(container))
    const touches =
      stopContainers.some((container) => selectedIds.has(container.id)) ||
      (routePickups.length === 0 && areaMatches(route, selectedAreas))
    if (!touches) continue

    const containerIds: string[] = []
    const stops: LngLat[] = []
    for (const container of stopContainers) {
      if (containerIds.includes(container.id)) continue
      containerIds.push(container.id)
      const spot = containerLocation(container)
      if (spot) stops.push(spot)
    }
    rows.push({
      id: route.id,
      name: route.name,
      status: route.status,
      bucket,
      date: routeDate(route),
      color: "",
      stops,
      containerIds,
    })
  }

  rows.sort(
    (a, b) =>
      BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] ||
      (a.date ?? "9999").localeCompare(b.date ?? "9999") ||
      a.name.localeCompare(b.name),
  )
  const coloured = rows.map((row, index) => ({ ...row, color: ROUTE_LINE_PALETTE[index % ROUTE_LINE_PALETTE.length] }))
  return {
    total: coloured.length,
    awaiting: coloured.filter((row) => row.bucket === "awaiting").length,
    inProgress: coloured.filter((row) => row.bucket === "in-progress").length,
    completed: coloured.filter((row) => row.bucket === "completed").length,
    routes: coloured,
  }
}

/** A fixture route day names its geography loosely ("Østerbro" for "Østerbro Zone 2"). */
function areaMatches(route: BusinessRecord, selectedAreas: ReadonlySet<string>): boolean {
  const area = clean(route.facts.Area)?.toLowerCase()
  if (!area) return false
  for (const selectedArea of selectedAreas) {
    if (selectedArea.startsWith(area) || area.startsWith(selectedArea)) return true
  }
  return false
}
