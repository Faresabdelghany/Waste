// What the Resolution route modules share (Issue #109): the rows of `ticket`,
// `ticket_event` and `alert` on the wire, the office's scope every statement
// is bounded by — the tenant and `inProjects` — the two reads a ticket's
// detail carries (its history in recording order, the alerts naming it), and
// the family's 404s, so routes/tickets.ts, routes/ticket-writes.ts and
// routes/alerts.ts each say only which route does what, the way
// routes/execution-shapes.ts holds Execution's shapes for its modules.
//
// The rows themselves — the column sets, the row types, `ticketOf`,
// `linksOf`, `eventOf`, `alertOf`, `labelOf` — live in
// `@waste/db/commands/resolution-rows` since part B, because `openTicket`
// moved to where both processes run it and the worker emits `ticket-opened`
// with the `Ticket` as the route would answer it; they are re-exported here
// under the names every route always used. What stays is what only a request
// has: the principal's scope, the 404s, the detail's two reads. A ticket's
// `label` is `ticketLabel(number)`, the contracts' one spelling of `T-8831`,
// and every sentence of the family names a ticket by it; the nine links
// travel as one object on the wire (`links`) and as nine columns in the row,
// and `linksOf` is the one place the two meet.
import type { Tx } from "@waste/db/client"
import { alertColumns, alertOf, eventColumns, eventOf, labelOf, linksOf, ticketColumns, ticketOf, type AlertRow, type TicketEventRow, type TicketRow } from "@waste/db/commands/resolution-rows"
import { alert, ticket, ticketEvent } from "@waste/db/schema/resolution"
import type { TicketVisibility } from "@waste/domain/resolution/vocabulary"
import { and, asc, eq, type SQL } from "drizzle-orm"

import type { Principal } from "../auth/principal"
import { inProjects } from "../auth/projects"
import { providerIdOf, reachesThroughRoute } from "../auth/provider"
import { problem } from "../problem"

export { alertColumns, alertOf, eventColumns, eventOf, labelOf, linksOf, ticketColumns, ticketOf, type AlertRow, type TicketEventRow, type TicketRow }

export const noSuchTicket = (id: string) => problem(404, { detail: `No ticket ${id} in the projects this account works in` })
export const noSuchAlert = (id: string) => problem(404, { detail: `No alert ${id} in the projects this account works in` })

/** The tickets of this company, in the projects the caller works in: what every ticket statement is bounded by. */
export const ticketScope = (principal: Principal): SQL | undefined => and(eq(ticket.companyId, principal.companyId), inProjects(ticket.projectId, principal))

/** One ticket of this company by id, inside the caller's projects; undefined when it is neither. What a command reads. */
export async function findTicket(tx: Tx, principal: Principal, id: string): Promise<TicketRow | undefined> {
  const [row] = await tx
    .select(ticketColumns)
    .from(ticket)
    .where(and(ticketScope(principal), eq(ticket.id, id)))
    .limit(1)
  return row
}

/**
 * The tickets of this company the caller reads (#291 slice 23b): its
 * projects' for an office account, and for a Service Provider's account the
 * tickets about a route its provider runs (`reachesThroughRoute` over the
 * ticket's route — a ticket about a stop names the stop's route too,
 * `ticket_pickup_shape`). A ticket about no route is the office's alone.
 */
export const ticketReach = (tx: Tx, principal: Principal): SQL | undefined =>
  and(eq(ticket.companyId, principal.companyId), reachesThroughRoute(tx, principal, { companyId: ticket.companyId, projectId: ticket.projectId, routeId: ticket.routeId }))

/** One ticket of this company by id that the caller reads (`ticketReach`); undefined when it is not one. What a read and a comment read. */
export async function findReachedTicket(tx: Tx, principal: Principal, id: string): Promise<TicketRow | undefined> {
  const [row] = await tx
    .select(ticketColumns)
    .from(ticket)
    .where(and(ticketReach(tx, principal), eq(ticket.id, id)))
    .limit(1)
  return row
}

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
