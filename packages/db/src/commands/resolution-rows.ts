// The rows of `ticket`, `ticket_event` and `alert` as the shared statements
// read and answer them (Issue #109; here since part B): the column sets a
// statement selects or returns, the row types those give, and the three
// functions that put a row on the wire — `ticketOf` with `label` =
// `ticketLabel(number)`, `linksOf` (the nine link columns as the wire's one
// `links` object, the one place the two meet), `eventOf`, `alertOf`. The
// API's routes/resolution-shapes.ts re-exports all of it and adds what only
// a request has — the office's scope, the family's 404s, the detail's two
// reads — so a route reads these where it always did, and the worker's
// consumer, which answers nothing over HTTP but emits `ticket-opened` with
// the `Ticket` as the route would answer it, reads them here.
//
// Every status, kind and visibility column is text with a CHECK in the
// database and an enum on the wire, so the row's string is asserted to the
// vocabulary's type here and nowhere else. `stampsOf` and `instantOf` are
// the API's routes/shared.ts spellings, moved with the rows that need them
// and re-exported there.
import type { Alert } from "@waste/contracts/alerts"
import { ticketLabel } from "@waste/contracts/resolution"
import type { Ticket, TicketEvent, TicketLinks } from "@waste/contracts/tickets"
import type { AlertKind, AlertSeverity, AlertSource, AlertStatus, TicketEventKind, TicketKind, TicketPriority, TicketResolution, TicketSource, TicketStatus, TicketVisibility } from "@waste/domain/resolution/vocabulary"

import { alert, ticket, ticketEvent } from "../schema/resolution"

/** The instants of a row, as the wire spells them. */
export function stampsOf(row: { createdAt: Date; updatedAt: Date }): { createdAt: string; updatedAt: string } {
  return { createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
}

/** The instant of a row's nullable column, as the wire spells it; null stays null. `stampsOf` is the same over the two stamps every record carries. */
export const instantOf = (value: Date | null): string | null => (value === null ? null : value.toISOString())

export const ticketColumns = {
  id: ticket.id,
  projectId: ticket.projectId,
  number: ticket.number,
  kind: ticket.kind,
  status: ticket.status,
  priority: ticket.priority,
  source: ticket.source,
  subject: ticket.subject,
  description: ticket.description,
  occurredAt: ticket.occurredAt,
  dueAt: ticket.dueAt,
  assigneeUserAccountId: ticket.assigneeUserAccountId,
  createdBy: ticket.createdBy,
  sourceEventId: ticket.sourceEventId,
  routeId: ticket.routeId,
  pickupId: ticket.pickupId,
  containerId: ticket.containerId,
  propertyId: ticket.propertyId,
  sharedCollectionPointId: ticket.sharedCollectionPointId,
  customerId: ticket.customerId,
  agreementId: ticket.agreementId,
  driverId: ticket.driverId,
  parentTicketId: ticket.parentTicketId,
  resolution: ticket.resolution,
  recollectionRouteId: ticket.recollectionRouteId,
  closedAt: ticket.closedAt,
  createdAt: ticket.createdAt,
  updatedAt: ticket.updatedAt,
}

export type TicketRow = Pick<typeof ticket.$inferSelect, keyof typeof ticketColumns>

/** How every sentence names a ticket: `T-8831`. */
export const labelOf = (row: { number: number }): string => ticketLabel(row.number)

/** The nine links as the wire carries them, off the row's nine columns. */
export const linksOf = (row: Pick<TicketRow, keyof TicketLinks>): TicketLinks => ({
  routeId: row.routeId,
  pickupId: row.pickupId,
  containerId: row.containerId,
  propertyId: row.propertyId,
  sharedCollectionPointId: row.sharedCollectionPointId,
  customerId: row.customerId,
  agreementId: row.agreementId,
  driverId: row.driverId,
  parentTicketId: row.parentTicketId,
})

/** The ticket on the wire. */
export function ticketOf(row: TicketRow): Ticket {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    label: labelOf(row),
    kind: row.kind as TicketKind,
    status: row.status as TicketStatus,
    priority: row.priority as TicketPriority,
    source: row.source as TicketSource,
    subject: row.subject,
    description: row.description,
    occurredAt: row.occurredAt.toISOString(),
    dueAt: instantOf(row.dueAt),
    assigneeUserAccountId: row.assigneeUserAccountId,
    createdBy: row.createdBy,
    sourceEventId: row.sourceEventId,
    links: linksOf(row),
    resolution: row.resolution as TicketResolution | null,
    recollectionRouteId: row.recollectionRouteId,
    closedAt: instantOf(row.closedAt),
    ...stampsOf(row),
  }
}

export const eventColumns = {
  id: ticketEvent.id,
  recordedAt: ticketEvent.recordedAt,
  projectId: ticketEvent.projectId,
  ticketId: ticketEvent.ticketId,
  kind: ticketEvent.kind,
  status: ticketEvent.status,
  assigneeUserAccountId: ticketEvent.assigneeUserAccountId,
  resolution: ticketEvent.resolution,
  body: ticketEvent.body,
  visibility: ticketEvent.visibility,
  objectKey: ticketEvent.objectKey,
  sourceEventId: ticketEvent.sourceEventId,
  recordedBy: ticketEvent.recordedBy,
}

export type TicketEventRow = Pick<typeof ticketEvent.$inferSelect, keyof typeof eventColumns>

/** The history row on the wire. */
export function eventOf(row: TicketEventRow): TicketEvent {
  return {
    id: row.id,
    recordedAt: row.recordedAt.toISOString(),
    projectId: row.projectId,
    ticketId: row.ticketId,
    kind: row.kind as TicketEventKind,
    status: row.status as TicketStatus,
    assigneeUserAccountId: row.assigneeUserAccountId,
    resolution: row.resolution as TicketResolution | null,
    body: row.body,
    visibility: row.visibility as TicketVisibility,
    objectKey: row.objectKey,
    sourceEventId: row.sourceEventId,
    recordedBy: row.recordedBy,
  }
}

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
  ticketId: alert.ticketId,
  raisedBy: alert.raisedBy,
  acknowledgedAt: alert.acknowledgedAt,
  acknowledgedBy: alert.acknowledgedBy,
  resolvedAt: alert.resolvedAt,
  resolvedBy: alert.resolvedBy,
  resolutionNote: alert.resolutionNote,
  createdAt: alert.createdAt,
  updatedAt: alert.updatedAt,
}

export type AlertRow = Pick<typeof alert.$inferSelect, keyof typeof alertColumns>

/** The alert on the wire. */
export function alertOf(row: AlertRow): Alert {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind as AlertKind,
    severity: row.severity as AlertSeverity,
    source: row.source as AlertSource,
    status: row.status as AlertStatus,
    title: row.title,
    details: row.details,
    detectedAt: row.detectedAt.toISOString(),
    routeId: row.routeId,
    vehicleId: row.vehicleId,
    driverId: row.driverId,
    containerId: row.containerId,
    ticketId: row.ticketId,
    raisedBy: row.raisedBy,
    acknowledgedAt: instantOf(row.acknowledgedAt),
    acknowledgedBy: row.acknowledgedBy,
    resolvedAt: instantOf(row.resolvedAt),
    resolvedBy: row.resolvedBy,
    resolutionNote: row.resolutionNote,
    ...stampsOf(row),
  }
}
