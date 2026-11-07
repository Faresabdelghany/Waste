// An alert on the wire (Issue #109): the columns a statement selects or
// returns, the row type, and `alertOf`. The office's routes answer an alert
// through these, and `raiseAlerts`, which the office's raise and the worker's
// rules both run, emits `alert-raised` with the same `Alert`.
import type { Alert } from "@waste/contracts/alerts"

import { alert } from "../schema/resolution"
import { instantOf, stampsOf } from "./times"

export const alertColumns = {
  id: alert.id,
  projectId: alert.projectId,
  kind: alert.kind,
  severity: alert.severity,
  source: alert.source,
  status: alert.status,
  title: alert.title,
  details: alert.details,
  detectedAt: alert.detectedAt,
  routeId: alert.routeId,
  vehicleId: alert.vehicleId,
  driverId: alert.driverId,
  containerId: alert.containerId,
  outboundLoadId: alert.outboundLoadId,
  ticketId: alert.ticketId,
  raisedBy: alert.raisedBy,
  acknowledgedAt: alert.acknowledgedAt,
  acknowledgedBy: alert.acknowledgedBy,
  resolvedAt: alert.resolvedAt,
  resolvedBy: alert.resolvedBy,
  resolutionNote: alert.resolutionNote,
  rule: alert.rule,
  createdAt: alert.createdAt,
  updatedAt: alert.updatedAt,
}

export type AlertRow = Pick<typeof alert.$inferSelect, keyof typeof alertColumns>

/** The alert on the wire. */
export function alertOf(row: AlertRow): Alert {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    severity: row.severity,
    source: row.source,
    status: row.status,
    title: row.title,
    details: row.details,
    detectedAt: row.detectedAt.toISOString(),
    routeId: row.routeId,
    vehicleId: row.vehicleId,
    driverId: row.driverId,
    containerId: row.containerId,
    outboundLoadId: row.outboundLoadId,
    ticketId: row.ticketId,
    raisedBy: row.raisedBy,
    acknowledgedAt: instantOf(row.acknowledgedAt),
    acknowledgedBy: row.acknowledgedBy,
    resolvedAt: instantOf(row.resolvedAt),
    resolvedBy: row.resolvedBy,
    resolutionNote: row.resolutionNote,
    rule: row.rule,
    ...stampsOf(row),
  }
}
