// What the Execution route modules share (Issue #104): the rows of `route`,
// `pickup`, `session`, `proof_of_service`, `unload` and `driver_command` on
// the wire, the scopes every route statement is bounded by — the office's,
// the tenant and `inProjects`; the driver door's, the tenant and the
// assignment — the two page-wide reads a route carries, its progress and
// its open session, and the route's detail (`detailOf`, and
// `routeWithSessions` underneath it, which the driver's read adds its own
// pickups to), so routes/routes.ts, routes/pickups.ts, routes/live.ts,
// routes/unloads.ts and routes/driver.ts each say only which route does what,
// the way routes/scheme-groups.ts holds Planning's shapes for its two modules.
//
// A route's `progress` is derived and never stored (#104 §2): one aggregate
// over the page's ids, grouped by route and status, folded by the domain's
// `progressOf`, so a page of fifty routes costs one statement and not fifty,
// and the list, the single read and the live read all answer the same fold.
// The open session of every route on a page is one statement too, over the
// partial unique index that holds one live session per route.
//
// The route's `label` is `routeLabel(number)`, the contracts' one spelling of
// `RC-1042`, and every sentence of the four modules names a route by it.
// `generationRunId` is null throughout: the column arrives with #97 B's
// `generation_run` table and its key, and until then no route carries one.
import type { DriverCommandReceipt } from "@waste/contracts/driver-commands"
import { routeLabel } from "@waste/contracts/execution"
import type { FlatPoint } from "@waste/contracts/geojson"
import type { Pickup } from "@waste/contracts/pickups"
import type { Problem } from "@waste/contracts/problem"
import type { ProofOfService } from "@waste/contracts/proofs"
import type { Route, RouteDetail, RouteProgress } from "@waste/contracts/routes"
import type { Session } from "@waste/contracts/sessions"
import type { Unload } from "@waste/contracts/unloads"
import type { Tx } from "@waste/db/client"
import { driverCommand, pickup, proofOfService, route, session, unload } from "@waste/db/schema/execution"
import { noRouteAssigned } from "@waste/domain/execution/commands"
import { progressOf, type PickupCounts } from "@waste/domain/execution/progress"
import type { CommandOutcome, DriverCommandKind, ExecutionSource, PickupOutcome, PickupReason, PickupStatus, ProofKind, RouteStatus } from "@waste/domain/execution/vocabulary"
import { and, asc, count, eq, inArray, isNull, type SQL } from "drizzle-orm"

import { assignedTo, type DriverProfile } from "../auth/driver"
import type { Principal } from "../auth/principal"
import { inProjects } from "../auth/projects"
import { problem } from "../problem"
import { instantOf, stampsOf, timeOf } from "./shared"

export const noSuchRoute = (id: string) => problem(404, { detail: `No route ${id} in the projects this account works in` })
export const noSuchPickup = (id: string) => problem(404, { detail: `No pickup ${id} in the projects this account works in` })
export const noSuchSession = (id: string) => problem(404, { detail: `No session ${id} in the projects this account works in` })
export const noSuchUnload = (id: string) => problem(404, { detail: `No unload ${id} in the projects this account works in` })

export const routeColumns = {
  id: route.id,
  projectId: route.projectId,
  routeSchemeId: route.routeSchemeId,
  collectionGroupId: route.collectionGroupId,
  serviceDate: route.serviceDate,
  operatingDate: route.operatingDate,
  number: route.number,
  status: route.status,
  note: route.note,
  cancelledByGeneration: route.cancelledByGeneration,
  plannedStartTime: route.plannedStartTime,
  plannedVehicleId: route.plannedVehicleId,
  plannedDriverId: route.plannedDriverId,
  plannedTrailerId: route.plannedTrailerId,
  depotId: route.depotId,
  plannedServiceProviderId: route.plannedServiceProviderId,
  unloadingStationId: route.unloadingStationId,
  actualVehicleId: route.actualVehicleId,
  actualDriverId: route.actualDriverId,
  actualTrailerId: route.actualTrailerId,
  dispatchedAt: route.dispatchedAt,
  startedAt: route.startedAt,
  completedAt: route.completedAt,
  cancelledAt: route.cancelledAt,
  createdAt: route.createdAt,
  updatedAt: route.updatedAt,
}

export type RouteRow = Pick<typeof route.$inferSelect, keyof typeof routeColumns>

/** How every sentence names a route: `RC-1042`. */
export const labelOf = (row: { number: number }): string => routeLabel(row.number)

/** The row on the wire with the progress read for it. The status is text with a CHECK in the database and an enum here; the start drops Postgres's seconds. */
export function routeOf(row: RouteRow, progress: RouteProgress): Route {
  return {
    id: row.id,
    projectId: row.projectId,
    routeSchemeId: row.routeSchemeId,
    collectionGroupId: row.collectionGroupId,
    serviceDate: row.serviceDate,
    operatingDate: row.operatingDate,
    number: row.number,
    label: labelOf(row),
    status: row.status as RouteStatus,
    note: row.note,
    cancelledByGeneration: row.cancelledByGeneration,
    generationRunId: null,
    plannedStartTime: row.plannedStartTime === null ? null : timeOf(row.plannedStartTime),
    planned: {
      vehicleId: row.plannedVehicleId,
      driverId: row.plannedDriverId,
      trailerId: row.plannedTrailerId,
      serviceProviderId: row.plannedServiceProviderId,
      depotId: row.depotId,
      unloadingStationId: row.unloadingStationId,
    },
    actual: { vehicleId: row.actualVehicleId, driverId: row.actualDriverId, trailerId: row.actualTrailerId },
    dispatchedAt: instantOf(row.dispatchedAt),
    startedAt: instantOf(row.startedAt),
    completedAt: instantOf(row.completedAt),
    cancelledAt: instantOf(row.cancelledAt),
    progress,
    ...stampsOf(row),
  }
}

/** The routes of this company, in the projects the caller works in: what every route statement is bounded by. */
export const routeScope = (principal: Principal): SQL | undefined => and(eq(route.companyId, principal.companyId), inProjects(route.projectId, principal))

/** One route of this company by id, inside the caller's projects; undefined when it is neither. */
export async function findRoute(tx: Tx, principal: Principal, id: string): Promise<RouteRow | undefined> {
  const [row] = await tx
    .select(routeColumns)
    .from(route)
    .where(and(routeScope(principal), eq(route.id, id)))
    .limit(1)
  return row
}

/**
 * The progress of every route asked for, by route: one aggregate over the
 * page's ids grouped by route and status, folded by the domain. A route with
 * no pickups is absent from the counts and reads as done at zero, so a caller
 * reads through `progressFor`.
 */
export async function progressByRoute(tx: Tx, companyId: string, routeIds: readonly string[]): Promise<Map<string, RouteProgress>> {
  const byRoute = new Map<string, Record<PickupStatus, number>>()
  if (routeIds.length === 0) return new Map()
  const rows = await tx
    .select({ routeId: pickup.routeId, status: pickup.status, n: count() })
    .from(pickup)
    .where(and(eq(pickup.companyId, companyId), inArray(pickup.routeId, [...routeIds])))
    .groupBy(pickup.routeId, pickup.status)
  for (const row of rows) {
    const counts = byRoute.get(row.routeId) ?? { planned: 0, completed: 0, skipped: 0, failed: 0 }
    counts[row.status as PickupStatus] = row.n
    byRoute.set(row.routeId, counts)
  }
  return new Map(routeIds.map((id) => [id, progressOf(byRoute.get(id) ?? {})] as const))
}

/** The progress of one route out of a page's, or the empty fold for a route the aggregate did not mention. */
export const progressFor = (progress: ReadonlyMap<string, RouteProgress>, routeId: string): RouteProgress => progress.get(routeId) ?? progressOf({} as Partial<PickupCounts>)

/** The routes on the wire, their progress read in one statement. */
export async function routesOf(tx: Tx, companyId: string, rows: readonly RouteRow[]): Promise<Route[]> {
  const progress = await progressByRoute(
    tx,
    companyId,
    rows.map((row) => row.id),
  )
  return rows.map((row) => routeOf(row, progressFor(progress, row.id)))
}

/** One route on the wire, its progress read the way a page reads it, so what a write answers is what the next read says. */
export async function routeWithProgress(tx: Tx, companyId: string, row: RouteRow): Promise<Route> {
  const [answered] = await routesOf(tx, companyId, [row])
  return answered
}

export const pickupColumns = {
  id: pickup.id,
  projectId: pickup.projectId,
  routeId: pickup.routeId,
  containerId: pickup.containerId,
  position: pickup.position,
  status: pickup.status,
  reason: pickup.reason,
  note: pickup.note,
  propertyId: pickup.propertyId,
  sharedCollectionPointId: pickup.sharedCollectionPointId,
  wasteFractionId: pickup.wasteFractionId,
  arrivedAt: pickup.arrivedAt,
  outcomeAt: pickup.outcomeAt,
  createdAt: pickup.createdAt,
  updatedAt: pickup.updatedAt,
}

export type PickupRow = Pick<typeof pickup.$inferSelect, keyof typeof pickupColumns>

/** The pickup on the wire. */
export function pickupOf(row: PickupRow): Pickup {
  return {
    id: row.id,
    projectId: row.projectId,
    routeId: row.routeId,
    containerId: row.containerId,
    position: row.position,
    status: row.status as PickupStatus,
    reason: row.reason as PickupReason | null,
    note: row.note,
    propertyId: row.propertyId,
    sharedCollectionPointId: row.sharedCollectionPointId,
    wasteFractionId: row.wasteFractionId,
    arrivedAt: instantOf(row.arrivedAt),
    outcomeAt: instantOf(row.outcomeAt),
    ...stampsOf(row),
  }
}

/** The pickups of this company, in the projects the caller works in. */
export const pickupScope = (principal: Principal): SQL | undefined => and(eq(pickup.companyId, principal.companyId), inProjects(pickup.projectId, principal))

/** One route's pickups, by position and then by id: the stop list in order. */
export async function pickupsOfRoute(tx: Tx, companyId: string, routeId: string): Promise<PickupRow[]> {
  return await tx
    .select(pickupColumns)
    .from(pickup)
    .where(and(eq(pickup.companyId, companyId), eq(pickup.routeId, routeId)))
    .orderBy(asc(pickup.position), asc(pickup.id))
}

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

export const proofColumns = {
  id: proofOfService.id,
  recordedAt: proofOfService.recordedAt,
  projectId: proofOfService.projectId,
  routeId: proofOfService.routeId,
  pickupId: proofOfService.pickupId,
  sessionId: proofOfService.sessionId,
  kind: proofOfService.kind,
  source: proofOfService.source,
  occurredAt: proofOfService.occurredAt,
  recordedBy: proofOfService.recordedBy,
  deviceId: proofOfService.deviceId,
  location: proofOfService.location,
  locationAccuracyM: proofOfService.locationAccuracyM,
  reason: proofOfService.reason,
  note: proofOfService.note,
  weightKg: proofOfService.weightKg,
  objectKey: proofOfService.objectKey,
  outcome: proofOfService.outcome,
}

export type ProofRow = Pick<typeof proofOfService.$inferSelect, keyof typeof proofColumns>

/** The proof on the wire. The point is the contracts' `FlatPoint`, since the column is flat and refuses a third ordinate on write. */
export function proofOf(row: ProofRow): ProofOfService {
  return {
    id: row.id,
    recordedAt: row.recordedAt.toISOString(),
    projectId: row.projectId,
    routeId: row.routeId,
    pickupId: row.pickupId,
    sessionId: row.sessionId,
    kind: row.kind as ProofKind,
    source: row.source as ExecutionSource,
    occurredAt: row.occurredAt.toISOString(),
    recordedBy: row.recordedBy,
    deviceId: row.deviceId,
    location: row.location as FlatPoint | null,
    locationAccuracyM: row.locationAccuracyM,
    reason: row.reason as PickupReason | null,
    note: row.note,
    weightKg: row.weightKg,
    objectKey: row.objectKey,
    outcome: row.outcome as PickupOutcome | null,
  }
}

/** One pickup's proofs in recording order: a cursor over time-ordered ids is a cursor over recording order. */
export async function proofsOfPickup(tx: Tx, companyId: string, pickupId: string): Promise<ProofRow[]> {
  return await tx
    .select(proofColumns)
    .from(proofOfService)
    .where(and(eq(proofOfService.companyId, companyId), eq(proofOfService.pickupId, pickupId)))
    .orderBy(asc(proofOfService.id))
}

export const unloadColumns = {
  id: unload.id,
  recordedAt: unload.recordedAt,
  projectId: unload.projectId,
  routeId: unload.routeId,
  sessionId: unload.sessionId,
  unloadingStationId: unload.unloadingStationId,
  wasteFractionId: unload.wasteFractionId,
  source: unload.source,
  occurredAt: unload.occurredAt,
  recordedBy: unload.recordedBy,
  deviceId: unload.deviceId,
  location: unload.location,
  grossKg: unload.grossKg,
  tareKg: unload.tareKg,
  netKg: unload.netKg,
  weighbridgeTicket: unload.weighbridgeTicket,
  objectKey: unload.objectKey,
  note: unload.note,
}

export type UnloadRow = Pick<typeof unload.$inferSelect, keyof typeof unloadColumns>

/** The unload on the wire. */
export function unloadOf(row: UnloadRow): Unload {
  return {
    id: row.id,
    recordedAt: row.recordedAt.toISOString(),
    projectId: row.projectId,
    routeId: row.routeId,
    sessionId: row.sessionId,
    unloadingStationId: row.unloadingStationId,
    wasteFractionId: row.wasteFractionId,
    source: row.source as ExecutionSource,
    occurredAt: row.occurredAt.toISOString(),
    recordedBy: row.recordedBy,
    deviceId: row.deviceId,
    location: row.location as FlatPoint | null,
    grossKg: row.grossKg,
    tareKg: row.tareKg,
    netKg: row.netKg,
    weighbridgeTicket: row.weighbridgeTicket,
    objectKey: row.objectKey,
    note: row.note,
  }
}

/** The unloads of this company, in the projects the caller works in. */
export const unloadScope = (principal: Principal): SQL | undefined => and(eq(unload.companyId, principal.companyId), inProjects(unload.projectId, principal))

/** One route's unloads, oldest first. */
export async function unloadsOfRoute(tx: Tx, companyId: string, routeId: string): Promise<UnloadRow[]> {
  return await tx
    .select(unloadColumns)
    .from(unload)
    .where(and(eq(unload.companyId, companyId), eq(unload.routeId, routeId)))
    .orderBy(asc(unload.id))
}

/**
 * What hangs off a route beside its stops: the route with its progress, the
 * open session or null, every session oldest first, its unloads oldest
 * first — the pieces the office's `RouteDetail` and the driver's
 * `DriverRouteDetail` share, each adding pickups of its own shape (the
 * office's bare, the driver's with their places joined, routes/driver.ts).
 */
export async function routeWithSessions(tx: Tx, companyId: string, row: RouteRow): Promise<Omit<RouteDetail, "pickups">> {
  const [answered, sessions, unloads] = await Promise.all([routeWithProgress(tx, companyId, row), sessionsOfRoute(tx, companyId, row.id), unloadsOfRoute(tx, companyId, row.id)])
  const open = sessions.find((candidate) => candidate.endedAt === null)
  return { ...answered, session: open === undefined ? null : sessionOf(open), sessions: sessions.map(sessionOf), unloads: unloads.map(unloadOf) }
}

/** The route with everything that hangs off it, as the office reads and every office command answers it: the pickups by position beside the rest. */
export async function detailOf(tx: Tx, companyId: string, row: RouteRow): Promise<RouteDetail> {
  const [answered, pickups] = await Promise.all([routeWithSessions(tx, companyId, row), pickupsOfRoute(tx, companyId, row.id)])
  return { ...answered, pickups: pickups.map(pickupOf) }
}

export const receiptColumns = {
  id: driverCommand.id,
  recordedAt: driverCommand.recordedAt,
  projectId: driverCommand.projectId,
  routeId: driverCommand.routeId,
  sessionId: driverCommand.sessionId,
  pickupId: driverCommand.pickupId,
  driverId: driverCommand.driverId,
  deviceId: driverCommand.deviceId,
  kind: driverCommand.kind,
  occurredAt: driverCommand.occurredAt,
  body: driverCommand.body,
  outcome: driverCommand.outcome,
  problem: driverCommand.problem,
}

export type ReceiptRow = Pick<typeof driverCommand.$inferSelect, keyof typeof receiptColumns>

/**
 * The receipt on the wire: the command as received and what became of it.
 * The two `jsonb` columns are kept verbatim — the body as the device sent it,
 * the problem as the applier answered it. `routeId` is null on a rejection
 * for a route the driver does not reach (another company's, another
 * project's, or none), which routes/driver.ts records in the driver's project
 * with the claimed id kept beside the body as `{ routeId, body }`; the
 * contract carries the null, so a route's log (`GET /routes/:id/commands`),
 * which never meets one, and the driver's receipts page, which does, both
 * answer `DriverCommandReceipt`.
 */
export function receiptOf(row: ReceiptRow): DriverCommandReceipt {
  return {
    id: row.id,
    recordedAt: row.recordedAt.toISOString(),
    projectId: row.projectId,
    routeId: row.routeId,
    sessionId: row.sessionId,
    pickupId: row.pickupId,
    driverId: row.driverId,
    deviceId: row.deviceId,
    kind: row.kind as DriverCommandKind,
    occurredAt: row.occurredAt.toISOString(),
    body: row.body as DriverCommandReceipt["body"],
    outcome: row.outcome as CommandOutcome,
    problem: row.problem as Problem | null,
  }
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
