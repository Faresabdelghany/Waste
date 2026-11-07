// A Stock Movement on the wire (Issue #101, ADR-0003): the columns, the row
// type and `stockMovementOf`, which the ledger's commands answer with
// (`commands/stock-ledger.ts`) and the API's two reads of the ledger page.
import type { StockMovement } from "@waste/contracts/stock"

import { stockMovement } from "../schema/stock"

export const stockMovementColumns = {
  id: stockMovement.id,
  recordedAt: stockMovement.recordedAt,
  projectId: stockMovement.projectId,
  containerId: stockMovement.containerId,
  kind: stockMovement.kind,
  fromKind: stockMovement.fromKind,
  fromWarehouseId: stockMovement.fromWarehouseId,
  toKind: stockMovement.toKind,
  toWarehouseId: stockMovement.toWarehouseId,
  placementId: stockMovement.placementId,
  occurredAt: stockMovement.occurredAt,
  recordedBy: stockMovement.recordedBy,
  reason: stockMovement.reason,
  decommissionReasonId: stockMovement.decommissionReasonId,
  reference: stockMovement.reference,
  correctsMovementId: stockMovement.correctsMovementId,
}

export type StockMovementRow = Pick<typeof stockMovement.$inferSelect, keyof typeof stockMovementColumns>

/** The row on the wire. The three coded fields are text with a CHECK in the database and enums here; the vocabulary holds the two in lockstep. */
export function stockMovementOf(row: StockMovementRow): StockMovement {
  return {
    id: row.id,
    recordedAt: row.recordedAt.toISOString(),
    projectId: row.projectId,
    containerId: row.containerId,
    kind: row.kind,
    fromKind: row.fromKind,
    fromWarehouseId: row.fromWarehouseId,
    toKind: row.toKind,
    toWarehouseId: row.toWarehouseId,
    placementId: row.placementId,
    occurredAt: row.occurredAt.toISOString(),
    recordedBy: row.recordedBy,
    reason: row.reason,
    decommissionReasonId: row.decommissionReasonId,
    reference: row.reference,
    correctsMovementId: row.correctsMovementId,
  }
}
