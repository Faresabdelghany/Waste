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
import { and, asc, eq, type SQL } from "drizzle-orm"

import type { Principal } from "../auth/principal"
import { inProjects } from "../auth/projects"
import { problem } from "../problem"

export { alertColumns, alertOf, eventColumns, eventOf, labelOf, linksOf, ticketColumns, ticketOf, type AlertRow, type TicketEventRow, type TicketRow }

export const noSuchTicket = (id: string) => problem(404, { detail: `No ticket ${id} in the projects this account works in` })
export const noSuchAlert = (id: string) => problem(404, { detail: `No alert ${id} in the projects this account works in` })

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

/** One ticket's history in recording order: a cursor over time-ordered ids is a cursor over recording order. */
export async function eventsOfTicket(tx: Tx, companyId: string, ticketId: string): Promise<TicketEventRow[]> {
  return await tx
    .select(eventColumns)
    .from(ticketEvent)
    .where(and(eq(ticketEvent.companyId, companyId), eq(ticketEvent.ticketId, ticketId)))
    .orderBy(asc(ticketEvent.id))
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
