// Execution's rows as the driver door reads and answers them (Issue #104,
// slice 4): the column set of each of the six tables the door touches and the
// one function per table that puts a row on the wire in the contracts' shape.
// Slice 3, the office API, carries the same shapes in its
// `routes/execution-shapes.ts` under the same names and signatures —
// `routeOf`, `pickupOf`, `sessionOf`, `proofOf`, `unloadOf`, `receiptOf`,
// `progressByRoute` — and the integrator folds this file into that one; what
// is the driver door's alone is the scope (`driverRouteScope`,
// `findAssignedRoute`), whose fence is the assignment (auth/driver.ts) where
// the office's is `inProjects`.
//
// The coded columns are text with a CHECK in the database and an enum on the
// wire; the vocabulary holds the two in lockstep, so the casts below assert
// what the column already guarantees. A `timestamptz` arrives as a Date and
// goes out as its ISO string; a `time` drops Postgres's seconds (`timeOf`); a
// point is the contracts' `FlatPoint`, since every stored point is flat. A
// route's `progress` is derived from its pickups and never stored (#104 §2,
// "Derived, never persisted"): `progressByRoute` counts a set of routes'
// pickups by status in one statement and folds each through the domain's
// `progressOf`, so a page of routes costs one aggregate and not one per row.
import { routeLabel } from "@waste/contracts/execution"
import type { DriverCommandReceipt } from "@waste/contracts/driver-commands"
import type { FlatPoint } from "@waste/contracts/geojson"
import type { Pickup } from "@waste/contracts/pickups"
import type { Problem } from "@waste/contracts/problem"
import type { ProofOfService } from "@waste/contracts/proofs"
import type { Route } from "@waste/contracts/routes"
import type { Session } from "@waste/contracts/sessions"
import type { Unload } from "@waste/contracts/unloads"
import type { Tx } from "@waste/db/client"
import { driverCommand, pickup, proofOfService, route, session, unload } from "@waste/db/schema/execution"
import { noRouteAssigned } from "@waste/domain/execution/commands"
import { progressOf, type Progress } from "@waste/domain/execution/progress"
import type { CommandOutcome, DriverCommandKind, ExecutionSource, PickupOutcome, PickupReason, PickupStatus, ProofKind, RouteStatus } from "@waste/domain/execution/vocabulary"
import { and, count, eq, inArray, type SQL } from "drizzle-orm"

import type { DriverProfile } from "../auth/driver"
import { assignedTo } from "../auth/driver"
import type { Principal } from "../auth/principal"
import { problem } from "../problem"
import { stampsOf, timeOf } from "./shared"

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString())

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

/** The row on the wire, with the progress the caller counted for it. `generationRunId` is #97 B's column and null until its file lands. */
export function routeOf(row: RouteRow, progress: Progress): Route {
  return {
    id: row.id,
    projectId: row.projectId,
    routeSchemeId: row.routeSchemeId,
    collectionGroupId: row.collectionGroupId,
    serviceDate: row.serviceDate,
    operatingDate: row.operatingDate,
    number: row.number,
    label: routeLabel(row.number),
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
    dispatchedAt: iso(row.dispatchedAt),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    cancelledAt: iso(row.cancelledAt),
    progress: { planned: progress.planned, completed: progress.completed, skipped: progress.skipped, failed: progress.failed, total: progress.total, fraction: progress.fraction },
    ...stampsOf(row),
  }
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
    arrivedAt: iso(row.arrivedAt),
    outcomeAt: iso(row.outcomeAt),
    ...stampsOf(row),
  }
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
    endedAt: iso(row.endedAt),
    pausedAt: iso(row.pausedAt),
    lastSeenAt: row.lastSeenAt.toISOString(),
    ...stampsOf(row),
  }
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
 * The receipt as the wire spells it, with the one column the contract has not
 * caught up with: `driver_command.route_id` is nullable since the review of
 * slices 1 and 2 (a rejection for a route the driver does not reach is
 * recorded with none, the claimed id kept in `body`), and the contracts'
 * `DriverCommandReceipt.routeId` is still `Id`. Until the contract says
 * `Id.nullable()`, this is the shape the door answers, and a client parsing a
 * route-less receipt with the contract refuses it (reported with slice 4).
 */
export type Receipt = Omit<DriverCommandReceipt, "routeId"> & { routeId: string | null }

/** The receipt on the wire. `body` and `problem` are `jsonb` kept verbatim: the body as the device sent it, the problem as the applier answered it. */
export function receiptOf(row: ReceiptRow): Receipt {
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

/**
 * The progress of each route named, from one aggregate over their pickups:
 * `route_id, status, count(*)`, folded through the domain's `progressOf`. A
 * route with no pickups is in the answer with zeros, so a caller reads every
 * id it asked for. Always with `company_id`; the routes were read under the
 * caller's scope a moment ago, and a pickup's route carries its project.
 */
export async function progressByRoute(tx: Tx, companyId: string, routeIds: readonly string[]): Promise<Map<string, Progress>> {
  const progress = new Map<string, Progress>()
  if (routeIds.length === 0) return progress
  const rows = await tx
    .select({ routeId: pickup.routeId, status: pickup.status, count: count() })
    .from(pickup)
    .where(and(eq(pickup.companyId, companyId), inArray(pickup.routeId, [...routeIds])))
    .groupBy(pickup.routeId, pickup.status)
  const counts = new Map<string, Partial<Record<PickupStatus, number>>>()
  for (const row of rows) {
    const byStatus = counts.get(row.routeId) ?? {}
    byStatus[row.status as PickupStatus] = row.count
    counts.set(row.routeId, byStatus)
  }
  for (const id of routeIds) progress.set(id, progressOf(counts.get(id) ?? {}))
  return progress
}

// The driver door's scope: the tenant and the assignment, never `inProjects`.

/** The routes of this company assigned to this driver — planned for them, or started by them: what every driver route statement is bounded by. */
export const driverRouteScope = (principal: Principal, profile: DriverProfile): SQL | undefined => and(eq(route.companyId, principal.companyId), assignedTo(profile))

/** A route that is not assigned to this driver, or not there: the domain's one sentence, so the device learns nothing about routes it was not given. */
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
