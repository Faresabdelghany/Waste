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
import type { Route } from "@waste/contracts/routes"
import type { Session } from "@waste/contracts/sessions"
import type { DriverPickupReason, PickupStatus, RouteStatus } from "@waste/domain/execution/vocabulary"

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

/** "Open in Maps" over the pickup's own point, which the phone hands to its maps app; null for a property not yet geocoded. */
export function mapsHref(location: FlatPoint | null): string | null {
  if (location === null) return null
  const [longitude, latitude] = location.coordinates
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${latitude},${longitude}`)}`
}

/** Whether the route is underway as far as offering goes: active, or its start waiting to be sent. */
const underway = (route: Pick<Route, "id" | "status">, waiting: readonly QueueEntry[]): boolean => route.status === "active" || (route.status === "ready" && waits(waiting, route.id, ["start-route"]))

export type StopActions = {
  /** One of the stop's commands waits: the stop shows "Sending" and offers nothing more. */
  sending: boolean
  /** Complete, skip and fail. */
  outcome: boolean
  report: boolean
}

export function stopActions(route: Pick<Route, "id" | "status">, stop: Pick<DriverPickup, "id" | "status">, waiting: readonly QueueEntry[]): StopActions {
  const sending = waitingOn(waiting, route.id).some((entry) => pickupIdOf(entry.command) === stop.id)
  const open = underway(route, waiting) && !waits(waiting, route.id, ["end-route"]) && !sending
  return { sending, outcome: open && stop.status === "planned", report: open }
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
