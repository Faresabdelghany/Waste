// What the Driver App's screens read off the door's last read and the
// Command Queue (Issue #145). The browser disables what the read model makes
// impossible — no Start on a route that is not ready, no outcome on a stop
// already decided, nothing on a route completed — holds off a second tap
// while one waits, and otherwise lets the server decide: nothing here judges
// a licence, a vehicle's status or another route's session, so a start the
// server will refuse is still offered and its sentence shown when it comes
// back (no local `decide`, ADR-0004).
//
// One reading goes past the last read, and only to offer, never to show: a
// start waiting in the queue counts as the route underway, so a driver who
// started out of reach can go on recording stops, which the server then
// judges in order behind the start.
import type { DriverPickup, DriverRouteDetail } from "@waste/contracts/driver-commands"
import type { FlatPoint } from "@waste/contracts/geojson"
import type { ActivePlan } from "@waste/contracts/plans"
import type { Route } from "@waste/contracts/routes"
import type { Session } from "@waste/contracts/sessions"
import type { DriverPickupReason, PickupStatus, RouteStatus } from "@waste/domain/execution/vocabulary"
import { extraEmptyings } from "@waste/domain/execution/services"

import { itemsSentence, PICKUP_SERVICE_LABELS } from "../data/pickup-services"
import type { QueueEntry } from "./command-queue"
import { pickupIdOf, type PilotCommandKind } from "./commands"

const OUTCOMES: readonly PilotCommandKind[] = ["complete-pickup", "skip-pickup", "fail-pickup"]

/** A route's commands still in the queue. */
export function waitingOn(waiting: readonly QueueEntry[], routeId: string): QueueEntry[] {
  return waiting.filter((entry) => entry.command.routeId === routeId)
}

const waits = (waiting: readonly QueueEntry[], routeId: string, kinds: readonly PilotCommandKind[]): boolean => waitingOn(waiting, routeId).some((entry) => kinds.includes(entry.command.kind))

/** The stops in the order they are driven: the active Plan's `sequence` where the read carries one, the generated `position` otherwise. */
export function stopsInOrder<Stop extends Pick<DriverPickup, "position" | "sequence">>(pickups: readonly Stop[]): Stop[] {
  return [...pickups].sort((a, b) => (a.sequence ?? a.position) - (b.sequence ?? b.position) || a.position - b.position)
}

/** One entry of the route screen's list: a stop, or an unload visit the active Plan makes on the way (O15 of #290). */
export type RouteEntry<Stop> = { kind: "stop"; stop: Stop } | { kind: "unload"; unloadingStationId: string }

/**
 * The stops in the order they are driven with the active Plan's unload
 * visits between them, each after the stop it follows: where the vehicle is
 * full, it empties at the station and goes on. A visit after a stop the read
 * does not carry is left out, and a Plan from an API before them has none.
 */
export function entriesInOrder<Stop extends Pick<DriverPickup, "id" | "position" | "sequence">>(pickups: readonly Stop[], plan: Pick<ActivePlan, "unloads"> | null): RouteEntry<Stop>[] {
  const unloads = plan?.unloads ?? []
  return stopsInOrder(pickups).flatMap((stop): RouteEntry<Stop>[] => [
    { kind: "stop", stop },
    ...unloads.filter((unload) => unload.afterPickupId === stop.id).map((unload): RouteEntry<Stop> => ({ kind: "unload", unloadingStationId: unload.unloadingStationId })),
  ])
}

/**
 * What a stop collects, beneath its address: the container's label and the
 * fraction, or the fraction alone at an address-only stop the office added
 * (#111), which names no container — never a dangling separator.
 */
export function stopCollects(stop: Pick<DriverPickup, "containerLabel" | "wasteFractionName">): string {
  return stop.containerLabel === null ? stop.wasteFractionName : `${stop.containerLabel} · ${stop.wasteFractionName}`
}

/** What an office emptying of a container generation's plan empties on the route as well is: a second visit the office asked for. */
export const EXTRA_EMPTYING = "Extra emptying"

/**
 * What each of a route's stops is for, beside its status, where it is more
 * than its collection (O3 of #290): a work order by its service — a swap with
 * the container the driver brings, by its label (O3b), a bulky collection
 * with the items the driver takes away (O11) — an extra emptying by
 * the domain's one rule (`extraEmptyings`), read once for the route; a
 * collection is not in the map. A stop read from an API before the service is
 * a collection.
 */
export function stopServices(stops: readonly DriverPickup[]): ReadonlyMap<string, string> {
  const extra = extraEmptyings(stops)
  const labels = new Map<string, string>()
  for (const stop of stops) {
    const service = stop.service ?? "empty"
    if (service === "swap" && stop.replacementContainerLabel != null) labels.set(stop.id, `${PICKUP_SERVICE_LABELS.swap} for ${stop.replacementContainerLabel}`)
    else if (service === "bulky" && (stop.bulkyItems?.length ?? 0) > 0) labels.set(stop.id, `${PICKUP_SERVICE_LABELS.bulky}: ${itemsSentence(stop.bulkyItems)}`)
    else if (service !== "empty") labels.set(stop.id, PICKUP_SERVICE_LABELS[service])
    else if (extra.has(stop.id)) labels.set(stop.id, EXTRA_EMPTYING)
  }
  return labels
}

/** A point as Maps reads it: latitude, then longitude. */
const mapsPlace = ({ coordinates: [longitude, latitude] }: FlatPoint): string => `${latitude},${longitude}`

/** "Open in Maps" over the pickup's own point, which the phone hands to its maps app; null for a property not yet geocoded. */
export function mapsHref(location: FlatPoint | null): string | null {
  if (location === null) return null
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsPlace(location))}`
}

/** The most places one Maps link hands over: a destination and three waypoints, the most a Maps URL takes in a phone's browser (nine in the app or on a desktop). */
export const MAPS_STOPS_MAX = 4

/**
 * "Navigate the next stops in Maps": from wherever the phone is, through the
 * next places still to do in the order they are driven, the last of those one
 * link carries the destination. A stop already decided, or with its outcome
 * waiting to be sent, is behind the driver; a stop with no point is left out;
 * stops at one place (a property's several bins) are one waypoint. The link
 * moves on as stops are decided. Null when no stop still to do has a point.
 */
export function routeMapsHref(route: Pick<DriverRouteDetail, "id" | "pickups">, waiting: readonly QueueEntry[]): string | null {
  const decided = new Set(
    waitingOn(waiting, route.id)
      .filter((entry) => OUTCOMES.includes(entry.command.kind))
      .map((entry) => pickupIdOf(entry.command)),
  )
  const places: string[] = []
  for (const stop of stopsInOrder(route.pickups)) {
    if (stop.status !== "planned" || decided.has(stop.id) || stop.location === null) continue
    const place = mapsPlace(stop.location)
    if (places[places.length - 1] !== place) places.push(place)
    if (places.length === MAPS_STOPS_MAX) break
  }
  if (places.length === 0) return null
  const destination = places[places.length - 1]
  const waypoints = places.slice(0, -1)
  return `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURIComponent(destination)}${waypoints.length > 0 ? `&waypoints=${encodeURIComponent(waypoints.join("|"))}` : ""}`
}

/** Whether the route is underway as far as offering goes: active, or its start waiting to be sent. */
const underway = (route: Pick<Route, "id" | "status">, waiting: readonly QueueEntry[]): boolean => route.status === "active" || (route.status === "ready" && waits(waiting, route.id, ["start-route"]))

export type StopActions = {
  /** One of the stop's commands waits: the stop shows "Sending" and offers nothing more. */
  sending: boolean
  /** "Arrived", once, on a stop still to do: the door keeps the first arrival's instant and only adds a proof for another. */
  arrive: boolean
  /** Complete, skip and fail. */
  outcome: boolean
  /** A problem, a note or a weight: what adds to the stop's record without deciding it, before or after its outcome. */
  report: boolean
}

export function stopActions(route: Pick<Route, "id" | "status">, stop: Pick<DriverPickup, "id" | "status" | "arrivedAt">, waiting: readonly QueueEntry[]): StopActions {
  const sending = waitingOn(waiting, route.id).some((entry) => pickupIdOf(entry.command) === stop.id)
  const open = underway(route, waiting) && !waits(waiting, route.id, ["end-route"]) && !sending
  return { sending, arrive: open && stop.status === "planned" && stop.arrivedAt === null, outcome: open && stop.status === "planned", report: open }
}

export type RouteActions = {
  start: boolean
  pause: boolean
  resume: boolean
  report: boolean
  unload: boolean
  end: boolean
  /** The route's start or end waits to be sent. */
  sending: boolean
}

export function routeActions(route: Pick<Route, "id" | "status">, session: Pick<Session, "pausedAt"> | null, waiting: readonly QueueEntry[]): RouteActions {
  const starting = waits(waiting, route.id, ["start-route"])
  const ending = waits(waiting, route.id, ["end-route"])
  const open = underway(route, waiting) && !ending
  const toggling = waits(waiting, route.id, ["pause", "resume"])
  const paused = session?.pausedAt != null
  return {
    start: route.status === "ready" && !starting,
    pause: open && !toggling && !paused,
    resume: open && !toggling && paused,
    report: open,
    unload: open,
    end: open,
    sending: starting || ending,
  }
}

/** The end-route confirm: how many planned stops no waiting outcome covers, which the end closes as skipped. */
export function endRouteWarning(route: Pick<DriverRouteDetail, "id" | "pickups">, waiting: readonly QueueEntry[]): string {
  const decided = new Set(
    waitingOn(waiting, route.id)
      .filter((entry) => OUTCOMES.includes(entry.command.kind))
      .map((entry) => pickupIdOf(entry.command)),
  )
  const open = route.pickups.filter((stop) => stop.status === "planned" && !decided.has(stop.id)).length
  if (open === 0) return "Every stop has an outcome."
  return `${open} ${open === 1 ? "stop" : "stops"} not done will be marked skipped`
}

/** The banner while the server is out of reach. */
export function unreachableBanner(waiting: number): string {
  return `Can't reach the server · ${waiting} ${waiting === 1 ? "action" : "actions"} waiting`
}

/** The start screen's order: by operating date, then planned start, then number. */
export function routesInDayOrder<Item extends Pick<Route, "operatingDate" | "plannedStartTime" | "number">>(routes: readonly Item[]): Item[] {
  return [...routes].sort((a, b) => a.operatingDate.localeCompare(b.operatingDate) || (a.plannedStartTime ?? "").localeCompare(b.plannedStartTime ?? "") || a.number - b.number)
}

export const ROUTE_STATUS_LABELS: Readonly<Record<RouteStatus, string>> = {
  planned: "Planned",
  ready: "Ready",
  active: "Active",
  completed: "Completed",
  cancelled: "Cancelled",
}

export const PICKUP_STATUS_LABELS: Readonly<Record<PickupStatus, string>> = {
  planned: "To do",
  completed: "Completed",
  skipped: "Skipped",
  failed: "Failed",
}

/** The six reasons a driver gives, in the words the screen offers them. */
export const DRIVER_REASON_LABELS: Readonly<Record<DriverPickupReason, string>> = {
  inaccessible: "Inaccessible",
  contamination: "Contamination",
  "not-presented": "Not presented",
  capacity: "Over capacity",
  safety: "Safety",
  other: "Other",
}
