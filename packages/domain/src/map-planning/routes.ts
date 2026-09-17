// The dated Routes on the planning map (2026-09-16): the ones that touch a
// selection ("Existing routes in this area" — how many are awaiting, in
// progress, or completed) and, since the Routes layer, every drawable route
// in the collection window. A route is linked through its Pickups (typed
// routeId/containerId first, the Route and Container ID display facts
// second); a fixture route day without pickups falls back to its Area fact
// naming a selected container's planning area. Lines are coloured by status
// bucket, and each route carries what its map card shows and, per located
// stop, what playback narrates: order, kind, label, planned and actual time.
// A pickup at no container but with an address (a depot start) is placed by
// that address when its street is in the gazetteer. Cancelled routes are
// never counted. Pure data logic.

import type { BusinessRecord } from "../prototype-record"
import { isSoftDeleted } from "../record-visibility"
import { isIsoDate } from "../route-schemes/recurrence"
import type { LngLat } from "./geo"
import { containerLocation, knownAddressLocation } from "./positions"
import { parseDisplayDate } from "./schedule"
import type { QuantityRange } from "./statistics"

export type RouteBucket = "awaiting" | "in-progress" | "completed"

export type RouteStopKind = "container" | "depot" | "address"

export type RouteStop = {
  /** Stop order as the pickup says, 1-based. */
  index: number
  kind: RouteStopKind
  /** The container served, when the pickup resolves to one. */
  containerId: string | null
  /** "Adelgade 12", "Nordhavn Depot" — the pickup name's tail, else the address street line. */
  label: string
  lngLat: LngLat
  /** The pickup's status: Planned, Next, Completed, Skipped, … */
  status: string
  /** Planned clock ("06:32") from the Scheduled fact, when known. */
  planned: string | null
  /** Actual clock from the Completed-at fact, when the stop is done. */
  actual: string | null
}

export type AreaRoute = {
  id: string
  name: string
  status: string
  bucket: RouteBucket
  /** The date the route runs, ISO, when the record says. */
  date: string | null
  /** The status bucket's colour — every line of a bucket looks the same. */
  color: string
  /** Located stops in stop order — empty when the route's pickups are unknown. */
  stops: RouteStop[]
  containerIds: string[]
  vehicle: string | null
  driver: string | null
  timeWindow: string | null
  /** The record's own stop count ("42 stops") first, its pickups second. */
  stopCount: number
  /** Where "Open route" goes. */
  href: string
}

export type AreaRoutes = {
  total: number
  awaiting: number
  inProgress: number
  completed: number
  /** Awaiting first, then in progress, then completed; by date within a bucket. */
  routes: AreaRoute[]
}

/** Where dated Routes live — the record link the map card opens. */
export const ROUTES_MODULE = { workspaceId: "route-studio", moduleId: "routes" } as const

/** Line colour per status bucket (amber, blue, emerald — the panel's dots). */
export const ROUTE_BUCKET_COLORS: Readonly<Record<RouteBucket, string>> = {
  awaiting: "#f59e0b",
  "in-progress": "#3b82f6",
  completed: "#10b981",
}

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

export const routeHref = (routeId: string) =>
  `/${ROUTES_MODULE.workspaceId}?module=${ROUTES_MODULE.moduleId}&record=${encodeURIComponent(routeId)}`

function routeDate(route: BusinessRecord): string | null {
  const typed = clean(route.submittedValues?.actualDate) ?? clean(route.submittedValues?.serviceDate)
  if (typed && isIsoDate(typed)) return typed
  return parseDisplayDate(route.facts.Date)
}

/** "42 stops" → 42; anything else → null. */
function statedStopCount(route: BusinessRecord): number | null {
  const match = /^(\d+)\s+stops?\b/i.exec(route.value.trim())
  return match ? Number.parseInt(match[1], 10) : null
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

type LinkedStop = { pickup: BusinessRecord; container: BusinessRecord | null }

type LinkedRoute = {
  route: BusinessRecord
  bucket: RouteBucket
  pickups: BusinessRecord[]
  /** Every pickup with the container it resolves to, if any, in stop order. */
  stops: LinkedStop[]
  /** The containers the pickups resolve to, in stop order. */
  stopContainers: BusinessRecord[]
}

/** Every countable route with its pickups and the containers they resolve to. */
function linkRoutes(
  routes: readonly BusinessRecord[],
  pickups: readonly BusinessRecord[],
  allContainers: readonly BusinessRecord[],
): LinkedRoute[] {
  const containersByKey = new Map<string, BusinessRecord>()
  for (const container of allContainers) {
    containersByKey.set(container.id, container)
    const label = clean(container.facts["Container ID"])
    if (label) containersByKey.set(label.toLowerCase(), container)
  }

  const pickupsByRoute = new Map<string, BusinessRecord[]>()
  for (const pickup of pickups) {
    if (isSoftDeleted(pickup)) continue
    for (const key of pickupRouteKeys(pickup)) {
      const list = pickupsByRoute.get(key) ?? []
      list.push(pickup)
      pickupsByRoute.set(key, list)
    }
  }

  const linked: LinkedRoute[] = []
  for (const route of routes) {
    if (isSoftDeleted(route)) continue
    const bucket = routeBucket(route.status)
    if (!bucket) continue
    const routeKeys = [route.id, lower(route.name), clean(route.facts["Route ID"])?.toLowerCase()].filter(Boolean) as string[]
    const routePickups = Array.from(
      new Map(routeKeys.flatMap((key) => pickupsByRoute.get(key) ?? []).map((pickup) => [pickup.id, pickup])).values(),
    ).sort((a, b) => stopNumber(a) - stopNumber(b) || a.id.localeCompare(b.id))
    const stops = routePickups.map((pickup) => ({
      pickup,
      container: pickupContainerKeys(pickup).map((key) => containersByKey.get(key)).find(Boolean) ?? null,
    }))
    const stopContainers = stops
      .map((stop) => stop.container)
      .filter((container): container is BusinessRecord => Boolean(container))
    linked.push({ route, bucket, pickups: routePickups, stops, stopContainers })
  }
  return linked
}

const CLOCK = /(\d{1,2}:\d{2})/

/** The first "hh:mm" in a display value, zero-padded, or null. */
function clockOf(value: string | undefined): string | null {
  const match = CLOCK.exec(value ?? "")
  return match ? match[1].padStart(5, "0") : null
}

const streetLine = (address: string | undefined) => clean(address)?.split(",")[0]?.trim()

/** The located stop a pickup stands for, or null when nothing places it on the map. */
function routeStop({ pickup, container }: LinkedStop, position: number): RouteStop | null {
  const address = clean(pickup.facts.Address)
  // No container: the address places the stop, but only on a gazetteer street — never a hashed spot.
  const lngLat = container ? containerLocation(container) : address ? knownAddressLocation(address) : null
  if (!lngLat) return null
  const order = stopNumber(pickup)
  const nameTail = pickup.name.split("·")[1]?.trim()
  return {
    index: order === Number.MAX_SAFE_INTEGER ? position + 1 : order,
    kind: container ? "container" : lower(clean(pickup.facts.Type) ?? "") === "depot" ? "depot" : "address",
    containerId: container?.id ?? null,
    label: nameTail || streetLine(address) || streetLine(container?.facts.Address) || container?.name || pickup.name,
    lngLat,
    status: pickup.status,
    planned: clockOf(pickup.facts.Scheduled) ?? (/scheduled/i.test(pickup.value) ? clockOf(pickup.value) : null),
    actual: clockOf(pickup.facts["Completed at"]) ?? (lower(pickup.status) === "completed" ? clockOf(pickup.value) : null),
  }
}

function toAreaRoute({ route, bucket, pickups, stops: linkedStops }: LinkedRoute): AreaRoute {
  const containerIds: string[] = []
  const stops: RouteStop[] = []
  for (const [position, linked] of linkedStops.entries()) {
    // A container served twice is one stop on the map; depots and addresses may repeat (start and end).
    if (linked.container) {
      if (containerIds.includes(linked.container.id)) continue
      containerIds.push(linked.container.id)
    }
    const stop = routeStop(linked, position)
    if (stop) stops.push(stop)
  }
  return {
    id: route.id,
    name: route.name,
    status: route.status,
    bucket,
    date: routeDate(route),
    color: ROUTE_BUCKET_COLORS[bucket],
    stops,
    containerIds,
    vehicle: clean(route.facts.Vehicle) ?? null,
    driver: clean(route.facts.Driver) ?? null,
    timeWindow: clean(route.facts["Time window"]) ?? null,
    stopCount: statedStopCount(route) ?? pickups.length,
    href: routeHref(route.id),
  }
}

const byBucketDateName = (a: AreaRoute, b: AreaRoute) =>
  BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] ||
  (a.date ?? "9999").localeCompare(b.date ?? "9999") ||
  a.name.localeCompare(b.name)

export function routesInSelection(
  selected: readonly BusinessRecord[],
  routes: readonly BusinessRecord[],
  pickups: readonly BusinessRecord[],
  allContainers: readonly BusinessRecord[],
): AreaRoutes {
  const empty: AreaRoutes = { total: 0, awaiting: 0, inProgress: 0, completed: 0, routes: [] }
  if (selected.length === 0) return empty

  const selectedIds = new Set(selected.map((container) => container.id))
  const selectedAreas = new Set(
    selected.map((container) => clean(container.facts["Planning area"])?.toLowerCase()).filter(Boolean) as string[],
  )

  const rows = linkRoutes(routes, pickups, allContainers)
    .filter(
      (linked) =>
        linked.stopContainers.some((container) => selectedIds.has(container.id)) ||
        (linked.pickups.length === 0 && areaMatches(linked.route, selectedAreas)),
    )
    .map(toAreaRoute)
    .sort(byBucketDateName)

  return {
    total: rows.length,
    awaiting: rows.filter((row) => row.bucket === "awaiting").length,
    inProgress: rows.filter((row) => row.bucket === "in-progress").length,
    completed: rows.filter((row) => row.bucket === "completed").length,
    routes: rows,
  }
}

/**
 * Every route the Routes layer can draw: located stops, and — when the
 * collection window bounds the map — a date inside it. Without a window,
 * every drawable route, dated or not.
 */
export function routesInWindow(
  routes: readonly BusinessRecord[],
  pickups: readonly BusinessRecord[],
  allContainers: readonly BusinessRecord[],
  range: QuantityRange,
): AreaRoute[] {
  return linkRoutes(routes, pickups, allContainers)
    .map(toAreaRoute)
    .filter((route) => route.stops.length > 0)
    .filter((route) => (range ? route.date !== null && route.date >= range.from && route.date <= range.to : true))
    .sort(byBucketDateName)
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
