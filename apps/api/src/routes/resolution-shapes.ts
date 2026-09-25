// What the Resolution route modules share (Issue #109): the rows of `ticket`,
// `ticket_event` and `alert` on the wire, the office's scope every statement
// is bounded by — the tenant and `inProjects` — the two reads a ticket's
// detail carries (its history in recording order, the alerts naming it), and
// the family's 404s, so routes/tickets.ts, routes/ticket-writes.ts and
// routes/alerts.ts each say only which route does what, the way
// routes/execution-shapes.ts holds Execution's shapes for its modules.
//
// A ticket's `label` is `ticketLabel(number)`, the contracts' one spelling of
// `T-8831`, and every sentence of the family names a ticket by it. The nine
// links travel as one object on the wire (`links`) and as nine columns in the
// row; `linksOf` is the one place the two meet. Every status, kind and
// visibility column is text with a CHECK in the database and an enum on the
// wire, so the row's string is asserted to the vocabulary's type here and
// nowhere else.
import type { Alert } from "@waste/contracts/alerts"
import { ticketLabel } from "@waste/contracts/resolution"
import type { Ticket, TicketEvent, TicketLinks } from "@waste/contracts/tickets"
import type { Tx } from "@waste/db/client"
import { alert, ticket, ticketEvent } from "@waste/db/schema/resolution"
import type { AlertKind, AlertSeverity, AlertSource, AlertStatus, TicketEventKind, TicketKind, TicketPriority, TicketResolution, TicketSource, TicketStatus, TicketVisibility } from "@waste/domain/resolution/vocabulary"
import { and, asc, eq, type SQL } from "drizzle-orm"

import type { Principal } from "../auth/principal"
import { inProjects } from "../auth/projects"
import { problem } from "../problem"
import { instantOf, stampsOf } from "./shared"

export const noSuchTicket = (id: string) => problem(404, { detail: `No ticket ${id} in the projects this account works in` })
export const noSuchAlert = (id: string) => problem(404, { detail: `No alert ${id} in the projects this account works in` })

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

/** The tickets of this company, in the projects the caller works in: what every ticket statement is bounded by. */
export const ticketScope = (principal: Principal): SQL | undefined => and(eq(ticket.companyId, principal.companyId), inProjects(ticket.projectId, principal))

/** One ticket of this company by id, inside the caller's projects; undefined when it is neither. */
export async function findTicket(tx: Tx, principal: Principal, id: string): Promise<TicketRow | undefined> {
  const [row] = await tx
    .select(ticketColumns)
    .from(ticket)
    .where(and(ticketScope(principal), eq(ticket.id, id)))
    .limit(1)
  return row
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

/** One ticket's history in recording order: a cursor over time-ordered ids is a cursor over recording order. */
export async function eventsOfTicket(tx: Tx, companyId: string, ticketId: string): Promise<TicketEventRow[]> {
  return await tx
    .select(eventColumns)
    .from(ticketEvent)
    .where(and(eq(ticketEvent.companyId, companyId), eq(ticketEvent.ticketId, ticketId)))
    .orderBy(asc(ticketEvent.id))
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

/** The alerts of this company, in the projects the caller works in: what every alert statement is bounded by. */
export const alertScope = (principal: Principal): SQL | undefined => and(eq(alert.companyId, principal.companyId), inProjects(alert.projectId, principal))

/** The alerts linked to one ticket, oldest first: what "linked to ticket" reads as from the ticket's side. */
export async function alertsNamingTicket(tx: Tx, companyId: string, ticketId: string): Promise<AlertRow[]> {
  return await tx
    .select(alertColumns)
    .from(alert)
    .where(and(eq(alert.companyId, companyId), eq(alert.ticketId, ticketId)))
    .orderBy(asc(alert.id))
}
