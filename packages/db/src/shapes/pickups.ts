// A pickup on the wire (Issue #104; since 0016, #111, a pickup carries its
// `origin` and may name no container): the columns every pickup statement
// selects, the row type, and `pickupOf`. The office's commands and the driver
// door emit the pickup events with the `Pickup` as the route answers it,
// through these.
import type { Pickup } from "@waste/contracts/pickups"
import { and, asc, eq } from "drizzle-orm"

import type { Tx } from "../client"
import { pickup } from "../schema/execution"
import { instantOf, stampsOf } from "./times"

export const pickupColumns = {
  id: pickup.id,
  projectId: pickup.projectId,
  routeId: pickup.routeId,
  containerId: pickup.containerId,
  position: pickup.position,
  status: pickup.status,
  origin: pickup.origin,
  service: pickup.service,
  reason: pickup.reason,
  contaminantCodeId: pickup.contaminantCodeId,
  note: pickup.note,
  propertyId: pickup.propertyId,
  sharedCollectionPointId: pickup.sharedCollectionPointId,
  wasteFractionId: pickup.wasteFractionId,
  arrivedAt: pickup.arrivedAt,
  outcomeAt: pickup.outcomeAt,
  subscriptionId: pickup.subscriptionId,
  warehouseId: pickup.warehouseId,
  replacementContainerId: pickup.replacementContainerId,
  bulkyBookingId: pickup.bulkyBookingId,
  movedFromPickupId: pickup.movedFromPickupId,
  fillLevel: pickup.fillLevel,
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
    status: row.status,
    origin: row.origin,
    service: row.service,
    reason: row.reason,
    contaminantCodeId: row.contaminantCodeId,
    note: row.note,
    propertyId: row.propertyId,
    sharedCollectionPointId: row.sharedCollectionPointId,
    wasteFractionId: row.wasteFractionId,
    arrivedAt: instantOf(row.arrivedAt),
    outcomeAt: instantOf(row.outcomeAt),
    subscriptionId: row.subscriptionId,
    warehouseId: row.warehouseId,
    replacementContainerId: row.replacementContainerId,
    bulkyBookingId: row.bulkyBookingId,
    movedFromPickupId: row.movedFromPickupId,
    fill: row.fillLevel,
    ...stampsOf(row),
  }
}

/** One route's pickups, by position and then by id: the stop list in order. */
export async function pickupsOfRoute(tx: Tx, companyId: string, routeId: string): Promise<PickupRow[]> {
  return await tx
    .select(pickupColumns)
    .from(pickup)
    .where(and(eq(pickup.companyId, companyId), eq(pickup.routeId, routeId)))
    .orderBy(asc(pickup.position), asc(pickup.id))
}
