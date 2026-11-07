// What the Execution route modules share (Issue #104) beside the rows on the
// wire, which are `@waste/db/shapes/`' (routes, pickups, proofs, unloads,
// driver commands), since the commands and the outbox answer them too: the
// scopes every route statement is bounded by — the office's, the tenant and
// `inProjects`, which every command carries; the reach of the routes' and the
// pickups' reads, the tenant and `reachesRoute`, which is the office's fence
// for an office account and `servesRoute` for a Service Provider's
// (auth/provider.ts, #291 slice 23); the driver door's, the tenant and the
// assignment — the session on the wire, the open session of every route on a
// page in one statement, over the partial unique index that holds one live
// session per route, and the route's detail (`detailOf`, and
// `routeWithSessions` underneath it, which the driver's read adds its own
// pickups to), so routes/routes.ts, routes/pickups.ts, routes/live.ts,
// routes/unloads.ts and routes/driver.ts each say only which route does what.
import type { RouteDetail } from "@waste/contracts/routes"
import type { Session } from "@waste/contracts/sessions"
import type { Tx } from "@waste/db/client"
import { pickupOf, pickupsOfRoute } from "@waste/db/shapes/pickups"
import { routeColumns, routeWithProgress, type RouteRow } from "@waste/db/shapes/routes"
import { instantOf, stampsOf } from "@waste/db/shapes/times"
import { unloadsAnswered, unloadsFrom, unloadsOfRoute, type UnloadRow } from "@waste/db/shapes/unloads"
import { pickup, route, session, unload } from "@waste/db/schema/execution"
import { noRouteAssigned } from "@waste/domain/execution/commands"
import { and, asc, eq, inArray, isNull, type SQL } from "drizzle-orm"

import { assignedTo, type DriverProfile } from "../auth/driver"
import type { Principal } from "../auth/principal"
import { inProjects } from "../auth/projects"
import { reachesRoute, reachesThroughRoute, type ReachedRouteColumns } from "../auth/provider"
import { problem } from "../problem"
import { planContextOf, sequencedPickups } from "./plan-shapes"
import { NO_SHIFT, NO_WORKLOAD, shiftsByRoute, workloadsByRoute } from "./workload"
import { NOT_A_ROUTE } from "./references"
import { requireRow } from "./shared"

export const noSuchRoute = (id: string) => problem(404, { detail: `No route ${id} in the projects this account works in` })
export const noSuchPickup = (id: string) => problem(404, { detail: `No pickup ${id} in the projects this account works in` })
export const noSuchSession = (id: string) => problem(404, { detail: `No session ${id} in the projects this account works in` })
export const noSuchUnload = (id: string) => problem(404, { detail: `No unload ${id} in the projects this account works in` })

/** The routes of this company, in the projects the caller works in: what every route command, and every route statement outside the routes' and the pickups' reads, is bounded by. */
export const routeScope = (principal: Principal): SQL | undefined => and(eq(route.companyId, principal.companyId), inProjects(route.projectId, principal))

/** The routes of this company the caller reads: its projects' for an office account, the ones its provider serves for a Service Provider's (`reachesRoute`). What the routes' and the pickups' reads are bounded by, and nothing that writes. */
export const routeReach = (tx: Tx, principal: Principal): SQL | undefined => and(eq(route.companyId, principal.companyId), reachesRoute(tx, principal))

/** One route of this company by id, inside the caller's projects; undefined when it is neither. What a command reads. */
export async function findRoute(tx: Tx, principal: Principal, id: string): Promise<RouteRow | undefined> {
  const [row] = await tx
    .select(routeColumns)
    .from(route)
    .where(and(routeScope(principal), eq(route.id, id)))
    .limit(1)
  return row
}

/** One route of this company by id that the caller reads (`routeReach`); undefined when it is not one. What a read reads. */
export async function findReachedRoute(tx: Tx, principal: Principal, id: string): Promise<RouteRow | undefined> {
  const [row] = await tx
    .select(routeColumns)
    .from(route)
    .where(and(routeReach(tx, principal), eq(route.id, id)))
    .limit(1)
  return row
}

/**
 * A route a query names, as a read takes it: one the caller reads, and of the
 * project the query names beside it where it names one, or a 400 at the
 * field in the references' sentence. A Service Provider's account names a
 * route its provider serves; an office account a route of its projects.
 */
export async function requireReachedRoute(tx: Tx, principal: Principal, id: string, projectId: string | undefined, path = "routeId"): Promise<void> {
  await requireRow(tx, route, { companyId: principal.companyId, id, also: and(reachesRoute(tx, principal), projectId === undefined ? undefined : eq(route.projectId, projectId)) }, { path, message: NOT_A_ROUTE }, "query")
}

/** The pickups of this company, in the projects the caller works in: what a pickup command is bounded by. */
export const pickupScope = (principal: Principal): SQL | undefined => and(eq(pickup.companyId, principal.companyId), inProjects(pickup.projectId, principal))

/**
 * The pickups of this company the caller reads: its projects' for an office
 * account, the stops of the routes its provider serves for a Service
 * Provider's (`reachesThroughRoute`). A statement that joins the stop's
 * route already hands it as `joined`, so a provider's fence is the predicate
 * over that join rather than a second read of the same route.
 */
export const pickupReach = (tx: Tx, principal: Principal, joined?: ReachedRouteColumns): SQL | undefined => and(eq(pickup.companyId, principal.companyId), reachesThroughRoute(tx, principal, pickup, joined))

export const sessionColumns = {
  id: session.id,
  projectId: session.projectId,
  routeId: session.routeId,
  driverId: session.driverId,
  vehicleId: session.vehicleId,
  trailerId: session.trailerId,
  deviceId: session.deviceId,
  appVersion: session.appVersion,
  startedAt: session.startedAt,
  endedAt: session.endedAt,
  pausedAt: session.pausedAt,
  lastSeenAt: session.lastSeenAt,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
}

export type SessionRow = Pick<typeof session.$inferSelect, keyof typeof sessionColumns>

/** The session on the wire. */
export function sessionOf(row: SessionRow): Session {
  return {
    id: row.id,
    projectId: row.projectId,
    routeId: row.routeId,
    driverId: row.driverId,
    vehicleId: row.vehicleId,
    trailerId: row.trailerId,
    deviceId: row.deviceId,
    appVersion: row.appVersion,
    startedAt: row.startedAt.toISOString(),
    endedAt: instantOf(row.endedAt),
    pausedAt: instantOf(row.pausedAt),
    lastSeenAt: row.lastSeenAt.toISOString(),
    ...stampsOf(row),
  }
}

/** The sessions of this company, in the projects the caller works in. */
export const sessionScope = (principal: Principal): SQL | undefined => and(eq(session.companyId, principal.companyId), inProjects(session.projectId, principal))

/** One route's sessions, oldest first. */
export async function sessionsOfRoute(tx: Tx, companyId: string, routeId: string): Promise<SessionRow[]> {
  return await tx
    .select(sessionColumns)
    .from(session)
    .where(and(eq(session.companyId, companyId), eq(session.routeId, routeId)))
    .orderBy(asc(session.id))
}

/** The open session of every route asked for, by route, in one statement: the rows the partial unique index holds to one per route. */
export async function openSessionsByRoute(tx: Tx, companyId: string, routeIds: readonly string[]): Promise<Map<string, SessionRow>> {
  if (routeIds.length === 0) return new Map()
  const rows = await tx
    .select(sessionColumns)
    .from(session)
    .where(and(eq(session.companyId, companyId), inArray(session.routeId, [...routeIds]), isNull(session.endedAt)))
  return new Map(rows.map((row) => [row.routeId, row] as const))
}

/** The unloads of this company, in the projects the caller works in. */
export const unloadScope = (principal: Principal): SQL | undefined => and(eq(unload.companyId, principal.companyId), inProjects(unload.projectId, principal))

/** One unload of this company by id, inside the caller's projects, with its reading; undefined when it is neither. */
export async function findUnload(tx: Tx, principal: Principal, id: string): Promise<UnloadRow | undefined> {
  const [row] = await unloadsFrom(tx, principal.companyId)
    .query.where(and(unloadScope(principal), eq(unload.id, id)))
    .limit(1)
  return row
}

/**
 * What hangs off a route beside its stops: the route with its progress, the
 * open session or null, every session oldest first, its unloads oldest
 * first — the pieces the office's `RouteDetail` and the driver's
 * `DriverRouteDetail` share, each adding pickups of its own shape (the
 * office's bare, the driver's with their places joined, routes/driver.ts) and
 * the active Plan's reading with the `sequence` it gives them (#170,
 * routes/plan-shapes.ts).
 */
export async function routeWithSessions(tx: Tx, companyId: string, row: RouteRow): Promise<Omit<RouteDetail, "pickups" | "activePlan" | "workload" | "shift">> {
  const [answered, sessions, unloads] = await Promise.all([routeWithProgress(tx, companyId, row), sessionsOfRoute(tx, companyId, row.id), unloadsOfRoute(tx, companyId, row.id)])
  const open = sessions.find((candidate) => candidate.endedAt === null)
  return { ...answered, session: open === undefined ? null : sessionOf(open), sessions: sessions.map(sessionOf), unloads: await unloadsAnswered(tx, companyId, unloads) }
}

/**
 * The route with everything that hangs off it, as the office reads and every
 * office command answers it: the pickups by `sequence` — the active Plan's
 * order where there is one, the baseline's otherwise (#170), each stop
 * carrying its ordinal — and the active Plan's reading beside them.
 */
export async function detailOf(tx: Tx, companyId: string, row: RouteRow): Promise<RouteDetail> {
  const [answered, pickups, workloads] = await Promise.all([routeWithSessions(tx, companyId, row), pickupsOfRoute(tx, companyId, row.id), workloadsByRoute(tx, companyId, [row])])
  const [context, shifts] = await Promise.all([planContextOf(tx, companyId, row, pickups), shiftsByRoute(tx, companyId, [row], workloads)])
  return { ...answered, pickups: sequencedPickups(pickups.map(pickupOf), context), activePlan: context.activePlan, workload: workloads.get(row.id) ?? NO_WORKLOAD, shift: shifts.get(row.id) ?? NO_SHIFT }
}

// The driver door's scope (routes/driver.ts): the tenant and the assignment,
// never `inProjects`. A route reaches a device because the dispatcher assigned
// it to that driver (auth/driver.ts), and a route outside that is a route that
// is not there, in the domain's own sentence, so the device learns nothing
// about routes it was not given.

/** The routes of this company assigned to this driver — planned for them, or started by them: what every driver route statement is bounded by. */
export const driverRouteScope = (principal: Principal, profile: DriverProfile): SQL | undefined => and(eq(route.companyId, principal.companyId), assignedTo(profile))

/** A route that is not assigned to this driver, or not there: the domain's one sentence. */
export const noSuchAssignedRoute = (id: string) => problem(404, { detail: noRouteAssigned(id) })

/** One route of this company by id, assigned to this driver; undefined when it is neither. */
export async function findAssignedRoute(tx: Tx, principal: Principal, profile: DriverProfile, id: string): Promise<RouteRow | undefined> {
  const [row] = await tx
    .select(routeColumns)
    .from(route)
    .where(and(driverRouteScope(principal, profile), eq(route.id, id)))
    .limit(1)
  return row
}
