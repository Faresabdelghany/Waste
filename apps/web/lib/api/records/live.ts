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
// person reads it. There is no track: the board shows the last point, never
// a line.
import type { LiveRoute } from "@waste/contracts/routes"
import type { Session } from "@waste/contracts/sessions"

import type { BusinessRecord, ModuleLocation } from "@/lib/data/business-modules"

import { listAll } from "../client"
import { ofKind, typed, type Client, type MappingContext, type ResourceAdapter, type ServerModule } from "./adapter"
import { shownOn } from "./clock"
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
  const facts: Record<string, string> = {
    ...route.facts,
    "Planned assignment": planned ?? "Unassigned",
    "Actual assignment": actual ?? "Not started",
    // A point is [longitude, latitude] on the wire; a person reads latitude first.
    "Last position": live.lastLocation === null ? "No position yet" : `${live.lastLocation.coordinates[1].toFixed(5)}, ${live.lastLocation.coordinates[0].toFixed(5)}`,
    "Position freshness": live.lastSeenAt === null ? "No session" : freshnessOf(live.lastSeenAt, context.now ?? new Date()),
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
      latitude: live.lastLocation === null ? "" : String(live.lastLocation.coordinates[1]),
      longitude: live.lastLocation === null ? "" : String(live.lastLocation.coordinates[0]),
      lastSeenAt: live.lastSeenAt ?? "",
      paused: live.paused ? "true" : "false",
    },
  }
}

/** A route's sessions, oldest first: every time a driver started it, and how it went. */
export function routeSessions(client: Client, routeServerId: string): Promise<Session[]> {
  return listAll<Session>(client, "/sessions", { routeId: routeServerId })
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
