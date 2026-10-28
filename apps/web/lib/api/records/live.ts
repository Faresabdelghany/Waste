// The Live board on the prototype's records (Issue #179, slice 6 of #81):
// the routes running or due today, as the rows of `route-studio.live`. The
// wire shape is the contracts' `LiveRoute` (`@waste/contracts/routes`) — a
// route with its open session and three readings of it: the latest point a
// proof carried, when the device was last seen, whether it is paused — read
// from `GET /routes/live` (every active route, whatever its day, and every
// ready one due today on its project's clock); a route's sessions are read
// from `GET /sessions` (apps/api/src/routes/live.ts).
//
// Read-only. The driver's device moves a live route, and what the office may
// do to one — reassign it, cancel it — is the route's own command, in the
// Routes module: a live row is its route under the route's own web id, so a
// link from the board lands on the route's details. The row is the route's
// record (routes.ts) with the board's readings on top: the actual assignment
// the session went out with, or the planned one before a session, the
// progress as a percentage the table's circle reads, and the position as a
// person reads it. Since O8 of #290 the position is the open session's newest
// one the Driver App recorded, a proof's point only where there is none yet;
// the row tells the next stop's estimate and the trip's expected end; and a
// route's details read its track and its estimates per stop
// (`routeTrack`, `routeEtas`, `GET /routes/:id/positions` and `/eta`).
import type { RouteEta, RouteTrack } from "@waste/contracts/positions"
import type { LiveRoute } from "@waste/contracts/routes"
import type { Session } from "@waste/contracts/sessions"

import type { BusinessRecord, ModuleLocation } from "@/lib/data/business-modules"

import { get, listAll } from "../client"
import { ofKind, typed, type Client, type MappingContext, type ResourceAdapter, type ServerModule } from "./adapter"
import { shownOn, timeOn } from "./clock"
import { refusal } from "./places"
import { assignmentOf, toRouteRecord } from "./routes"

/** The workspace module the live routes are the rows of. */
export const LIVE_MODULE: ModuleLocation = { workspaceId: "route-studio", moduleId: "live" }

/** How often the board is read again while a person watches it. */
export const LIVE_BOARD_REFRESH_MS = 30_000

/**
 * Reads the board again every 30 s while it is watched — the store's
 * `refreshModule`, #213's re-read exposed — on one interval; the stop it
 * answers clears it when the board is left. The load that showed the board
 * is its first read.
 */
export function whileWatched(read: () => void, every = LIVE_BOARD_REFRESH_MS): () => void {
  const timer = setInterval(read, every)
  return () => clearInterval(timer)
}

const ROUTE_PREFIX = "route"

/** "4 minutes ago": how long since the device was last seen, to the minute; the board's freshness. */
function freshnessOf(instant: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(instant).getTime()) / 60_000))
  if (minutes < 1) return "Just now"
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`
  const hours = Math.floor(minutes / 60)
  return `${hours} hour${hours === 1 ? "" : "s"} ago`
}

export function toLiveRecord(live: LiveRoute, context: MappingContext): BusinessRecord {
  const route = toRouteRecord(live, context)
  const project = context.resolve.byServerId(live.projectId)
  const timezone = project === undefined ? undefined : typed(project, "timezone")
  const planned = assignmentOf(context, live.planned)
  const actual = live.session === null ? undefined : assignmentOf(context, live.session)
  const { total, planned: open } = live.progress
  // The session's newest recorded position, else the latest point a proof carried.
  const point = live.lastPosition?.location ?? live.lastLocation
  const now = context.now ?? new Date()
  const facts: Record<string, string> = {
    ...route.facts,
    "Planned assignment": planned ?? "Unassigned",
    "Actual assignment": actual ?? "Not started",
    // A point is [longitude, latitude] on the wire; a person reads latitude first.
    "Last position": point === null ? "No position yet" : `${point.coordinates[1].toFixed(5)}, ${point.coordinates[0].toFixed(5)}`,
    "Position freshness": live.lastPosition !== null ? freshnessOf(live.lastPosition.at, now) : live.lastSeenAt === null ? "No session" : freshnessOf(live.lastSeenAt, now),
  }
  if (live.lastPosition !== null) facts["Position recorded"] = shownOn(live.lastPosition.at, timezone)
  if (live.eta !== null) {
    facts["Next stop expected"] = live.eta.nextAt === null ? "No stop to come" : timeOn(live.eta.nextAt, timezone)
    if (live.eta.finishAt !== null) facts["Expected finish"] = timeOn(live.eta.finishAt, timezone)
  }
  if (live.lastSeenAt !== null) facts["Last seen"] = shownOn(live.lastSeenAt, timezone)
  if (live.session !== null) {
    facts["Session started"] = shownOn(live.session.startedAt, timezone)
    facts.Device = live.session.deviceId
  }
  return {
    ...route,
    context: actual ?? planned ?? "Unassigned",
    status: live.paused ? "Paused" : route.status,
    value: `${Math.round(live.progress.fraction * 100)}% · ${total - open}/${total} stops`,
    facts,
    recordKind: "Active route",
    submittedValues: {
      ...route.submittedValues,
      sessionId: live.session?.id ?? "",
      latitude: point === null ? "" : String(point.coordinates[1]),
      longitude: point === null ? "" : String(point.coordinates[0]),
      lastSeenAt: live.lastSeenAt ?? "",
      paused: live.paused ? "true" : "false",
    },
  }
}

/** A route's sessions, oldest first: every time a driver started it, and how it went. */
export function routeSessions(client: Client, routeServerId: string): Promise<Session[]> {
  return listAll<Session>(client, "/sessions", { routeId: routeServerId })
}

/** A route's track: its open session's positions in order, else its latest session's, as one row for the details' read. */
export function routeTrack(client: Client, routeServerId: string): Promise<RouteTrack[]> {
  return get<RouteTrack>(client, `/routes/${routeServerId}/positions`).then((track) => [track])
}

/** A route's estimates: each stop of its active Plan with when the vehicle is expected there, as one row for the details' read. */
export function routeEtas(client: Client, routeServerId: string): Promise<RouteEta[]> {
  return get<RouteEta>(client, `/routes/${routeServerId}/eta`).then((eta) => [eta])
}

/** A track drawn in a box of `width` by `height`: the points as an SVG path, north up, scaled to their extent at the track's latitude; null for fewer than two. */
export function trackPath(points: readonly { location: { coordinates: readonly [number, number] } }[], width: number, height: number): string | null {
  if (points.length < 2) return null
  const lons = points.map((point) => point.location.coordinates[0])
  const lats = points.map((point) => point.location.coordinates[1])
  const [west, east, south, north] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)]
  // A degree of longitude is shorter than one of latitude away from the equator.
  const scaleX = Math.cos((((south + north) / 2) * Math.PI) / 180)
  const spanX = Math.max((east - west) * scaleX, 1e-9)
  const spanY = Math.max(north - south, 1e-9)
  const scale = Math.min(width / spanX, height / spanY)
  const offsetX = (width - spanX * scale) / 2
  const offsetY = (height - spanY * scale) / 2
  return points
    .map((point, index) => {
      const x = offsetX + (point.location.coordinates[0] - west) * scaleX * scale
      const y = offsetY + (north - point.location.coordinates[1]) * scale
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(" ")
}

const READ_ONLY = "The Live board reads what the driver's device reports; a route is moved by its commands in Routes"

export const liveRouteAdapter: ResourceAdapter<LiveRoute> = {
  prefix: ROUTE_PREFIX,
  owns: ofKind(ROUTE_PREFIX, ["Active route"]),
  statuses: undefined,
  list: (client) => listAll<LiveRoute>(client, "/routes/live"),
  toRecord: toLiveRecord,
  toPatchBody: () => refusal("", READ_ONLY),
  update: () => Promise.reject(new Error(READ_ONLY)),
}

/** Route Studio › Live Operations: the routes running or due today, after the routes whose rows they are. */
export const liveModule: ServerModule = {
  workspaceId: LIVE_MODULE.workspaceId,
  moduleId: LIVE_MODULE.moduleId,
  resources: [liveRouteAdapter],
}

export type { Client }
