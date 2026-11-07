// A ticket and its history on the wire (Issue #109): the column sets a
// statement selects or returns, the row types those give, and the functions
// that put a row on the wire — `ticketOf` with `label` = `ticketLabel(number)`,
// `linksOf` (the nine link columns as the wire's one `links` object, the one
// place the two meet), `eventOf`. The office's routes answer a ticket through
// these, and the commands both processes run — `openTicket`, `moveTicket`,
// `assignTicket` — emit `ticket-opened`, `ticket-completed`,
// `ticket-rejected` and `ticket-assigned` with the `Ticket` as the route
// would answer it, through the same ones.
//
// Every status, kind and visibility column is text with a CHECK in the
// database and an enum on the wire, so the row's string is asserted to the
// vocabulary's type here and nowhere else.
import { ticketLabel } from "@waste/domain/numbering"
import type { TicketFieldValues } from "@waste/contracts/ticket-types"
import type { Ticket, TicketEvent, TicketLinks } from "@waste/contracts/tickets"

import { ticket, ticketEvent } from "../schema/resolution"
import { instantOf, stampsOf } from "./times"

export const ticketColumns = {
  id: ticket.id,
  projectId: ticket.projectId,
  number: ticket.number,
  kind: ticket.kind,
  ticketTypeId: ticket.ticketTypeId,
  fieldValues: ticket.fieldValues,
  status: ticket.status,
  priority: ticket.priority,
  source: ticket.source,
  subject: ticket.subject,
  description: ticket.description,
  occurredAt: ticket.occurredAt,
  dueAt: ticket.dueAt,
  assigneeUserAccountId: ticket.assigneeUserAccountId,
  teamId: ticket.teamId,
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
  recollectionPickupId: ticket.recollectionPickupId,
  chargeProductId: ticket.chargeProductId,
  closedAt: ticket.closedAt,
  bookedRouteId: ticket.bookedRouteId,
  bookedPickupId: ticket.bookedPickupId,
  countingRuleId: ticket.countingRuleId,
  countedFrom: ticket.countedFrom,
  countedTo: ticket.countedTo,
  counted: ticket.counted,
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

/** The nine links, none named: what a writer spreads its own links over. */
export const NO_TICKET_LINKS: TicketLinks = { routeId: null, pickupId: null, containerId: null, propertyId: null, sharedCollectionPointId: null, customerId: null, agreementId: null, driverId: null, parentTicketId: null }

/** The ticket on the wire. */
export function ticketOf(row: TicketRow): Ticket {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    label: labelOf(row),
    kind: row.kind,
    ticketTypeId: row.ticketTypeId,
    fieldValues: row.fieldValues as TicketFieldValues,
    status: row.status,
    priority: row.priority,
    source: row.source,
    subject: row.subject,
    description: row.description,
    occurredAt: row.occurredAt.toISOString(),
    dueAt: instantOf(row.dueAt),
    assigneeUserAccountId: row.assigneeUserAccountId,
    teamId: row.teamId,
    createdBy: row.createdBy,
    sourceEventId: row.sourceEventId,
    links: linksOf(row),
    resolution: row.resolution,
    recollectionRouteId: row.recollectionRouteId,
    recollectionPickupId: row.recollectionPickupId,
    chargeProductId: row.chargeProductId,
    closedAt: instantOf(row.closedAt),
    bookedRouteId: row.bookedRouteId,
    bookedPickupId: row.bookedPickupId,
    countedBy: row.countingRuleId === null || row.countedFrom === null || row.countedTo === null || row.counted === null ? null : { countingRuleId: row.countingRuleId, periodFrom: row.countedFrom, periodTo: row.countedTo, count: row.counted },
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
    kind: row.kind,
    status: row.status,
    assigneeUserAccountId: row.assigneeUserAccountId,
    resolution: row.resolution,
    body: row.body,
    visibility: row.visibility,
    objectKey: row.objectKey,
    sourceEventId: row.sourceEventId,
    recordedBy: row.recordedBy,
  }
}
