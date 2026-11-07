// A driver command's receipt on the wire (Issue #104): the columns, the row
// type and `receiptOf`, which the route's command log, the driver's receipts
// and `command-rejected`'s payload all go through.
import type { DriverCommandReceipt } from "@waste/contracts/driver-commands"
import type { Problem } from "@waste/contracts/problem"
import type { CommandOutcome, DriverCommandKind } from "@waste/domain/execution/vocabulary"

import { driverCommand } from "../schema/execution"

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
