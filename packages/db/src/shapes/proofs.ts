// A Proof of Service on the wire (Issue #104): the columns, the row type and
// `proofOf`, which a pickup's read, the driver door's answers and the pickup
// and route events carrying the proofs a command made all go through.
import type { FlatPoint } from "@waste/contracts/geojson"
import type { ProofOfService } from "@waste/contracts/proofs"
import { and, asc, eq } from "drizzle-orm"

import type { Tx } from "../client"
import { proofOfService } from "../schema/execution"

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
  volumeLitres: proofOfService.volumeLitres,
  objectKey: proofOfService.objectKey,
  outcome: proofOfService.outcome,
  contaminantCodeId: proofOfService.contaminantCodeId,
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
    kind: row.kind,
    source: row.source,
    occurredAt: row.occurredAt.toISOString(),
    recordedBy: row.recordedBy,
    deviceId: row.deviceId,
    location: row.location as FlatPoint | null,
    locationAccuracyM: row.locationAccuracyM,
    reason: row.reason,
    note: row.note,
    weightKg: row.weightKg,
    volumeLitres: row.volumeLitres,
    objectKey: row.objectKey,
    outcome: row.outcome,
    contaminantCodeId: row.contaminantCodeId,
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
