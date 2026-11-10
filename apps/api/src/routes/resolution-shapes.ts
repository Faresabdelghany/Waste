// What the Resolution route modules share (Issue #109) beside the rows on the
// wire, which are `@waste/db/shapes/tickets` and `@waste/db/shapes/alerts`,
// since the commands both processes run answer and emit them too: what only
// a request has — the office's scope every statement is bounded by, the
// tenant and `inProjects`, a Service Provider's reach, the family's 404s, and
// the two reads a ticket's detail carries (its history in recording order,
// the alerts naming it) — so routes/tickets.ts and routes/alerts.ts each say
// only which route does what.
import type { Tx } from "@waste/db/client"
import { alert, ticket, ticketEvent } from "@waste/db/schema/resolution"
import type { TicketVisibility } from "@waste/domain/resolution/vocabulary"
import { and, asc, eq, type SQL } from "drizzle-orm"
import { alertColumns, type AlertRow } from "@waste/db/shapes/alerts"
import { eventColumns, ticketColumns, type TicketEventRow } from "@waste/db/shapes/tickets"

import type { Principal } from "../auth/principal"
import { providerIdOf, reachesThroughRoute } from "../auth/provider"
import { scoped } from "../scoped"

/**
 * The tickets of this company the caller reads (#291 slice 23b): its
 * projects' for an office account, and for a Service Provider's account the
 * tickets about a route its provider runs (`reachesThroughRoute` over the
 * ticket's route — a ticket about a stop names the stop's route too,
 * `ticket_pickup_shape`). A ticket about no route is the office's alone.
 */
export const ticketReach = (tx: Tx, principal: Principal): SQL | undefined =>
  and(eq(ticket.companyId, principal.companyId), reachesThroughRoute(tx, principal, { companyId: ticket.companyId, projectId: ticket.projectId, routeId: ticket.routeId }))

/**
 * The tickets: a read and a comment read what `ticketReach` reaches
 * (`findReachedTicket`, `getReachedTicket`, the page), a command what the
 * office's projects hold — `findTicket`, and `lockedTicket`, the ticket the
 * path names locked and read, since every command and the patch hold a rule
 * the API holds and so take the row lock first and read afterwards
 * (`@waste/db/commands/shared`).
 */
export const {
  scope: ticketScope,
  noSuch: noSuchTicket,
  find: findReachedTicket,
  get: getReachedTicket,
  commanded: findTicket,
  locked: lockedTicket,
  list: listTickets,
} = scoped(ticket, { noun: "ticket", reach: "projects", columns: ticketColumns, reads: ticketReach })

/** One ticket's history in recording order: a cursor over time-ordered ids is a cursor over recording order. `readable` narrows it to what the caller may read (`historyReadable`). */
export async function eventsOfTicket(tx: Tx, companyId: string, ticketId: string, readable?: SQL): Promise<TicketEventRow[]> {
  return await tx
    .select(eventColumns)
    .from(ticketEvent)
    .where(and(eq(ticketEvent.companyId, companyId), eq(ticketEvent.ticketId, ticketId), readable))
    .orderBy(asc(ticketEvent.id))
}

/** The thread a Service Provider reads and writes on a ticket about its route (#291 slice 23b): the history's `service-provider` comments. */
export const PROVIDER_THREAD = "service-provider" satisfies TicketVisibility

/**
 * The rows of a ticket's history the caller reads: every one for the office,
 * and for a Service Provider's account the comments of its thread alone
 * (`PROVIDER_THREAD`) — the office's internal notes, the customer's thread
 * and the notes a command carried are the office's, and the ticket's own row
 * says where the case stands. Undefined, and so no condition, for the office.
 */
export const historyReadable = (principal: Principal): SQL | undefined =>
  providerIdOf(principal) === null ? undefined : and(eq(ticketEvent.kind, "comment"), eq(ticketEvent.visibility, PROVIDER_THREAD))

/** The alerts of this company, in the projects the caller works in: what every alert statement is bounded by; a command (`lockedAlert`) takes the row lock first and reads afterwards, and two commands on one alert take turns. */
export const { scope: alertScope, noSuch: noSuchAlert, get: getAlert, locked: lockedAlert, list: listAlerts } = scoped(alert, { noun: "alert", reach: "projects", columns: alertColumns })

/** The alerts linked to one ticket, oldest first: what "linked to ticket" reads as from the ticket's side. */
export async function alertsNamingTicket(tx: Tx, companyId: string, ticketId: string): Promise<AlertRow[]> {
  return await tx
    .select(alertColumns)
    .from(alert)
    .where(and(eq(alert.companyId, companyId), eq(alert.ticketId, ticketId)))
    .orderBy(asc(alert.id))
}
