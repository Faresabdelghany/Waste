// A ticket's assignment, written once for both doors that assign one: the
// office's `assign` (apps/api's routes/tickets.ts, and its create's
// assignee through `requireAccountInProject`) and a ticket type's
// `assign-person` action (commands/ticket-automation.ts). Each door judges
// the account through `assigneeOf` and answers it in its own words — a 400
// at the body's field, or the automation's line; the write is here: the
// assignee, one `assigned` row, and `ticket-assigned` to an account.
import { and, eq } from "drizzle-orm"

import type { Tx } from "../client"
import type { IdMinter } from "../ids"
import { projectAccess, userAccount } from "../schema/access"
import { ticket } from "../schema/resolution"
import { appendTicketEvent, ticketRefOf } from "./open-ticket"
import { emit } from "./outbox"
import { ticketColumns, ticketOf, type TicketRow } from "../shapes/tickets"

/** The ticket as it stands in this transaction. */
export async function currentTicket(tx: Tx, companyId: string, id: string): Promise<TicketRow> {
  const [row] = await tx
    .select(ticketColumns)
    .from(ticket)
    .where(and(eq(ticket.companyId, companyId), eq(ticket.id, id)))
    .limit(1)
  if (row === undefined) throw new Error(`ticket ${id} of company ${companyId} is not there`)
  return row
}

/** The account a ticket would be assigned to, as every door judges it: this company's and not deactivated, by name, whether it is a Service Provider's, and whether it works in the ticket's project — every project, or a Project Access row; undefined for no such account. */
export async function assigneeOf(tx: Tx, scope: { companyId: string; projectId: string }, userAccountId: string): Promise<{ name: string; serviceProvider: boolean; worksInProject: boolean } | undefined> {
  const [found] = await tx
    .select({ name: userAccount.fullName, allProjects: userAccount.allProjects, deactivatedAt: userAccount.deactivatedAt, serviceProviderId: userAccount.serviceProviderId })
    .from(userAccount)
    .where(and(eq(userAccount.companyId, scope.companyId), eq(userAccount.id, userAccountId)))
    .limit(1)
  if (found === undefined || found.deactivatedAt !== null) return undefined
  const serviceProvider = found.serviceProviderId !== null
  if (found.allProjects) return { name: found.name, serviceProvider, worksInProject: true }
  const [access] = await tx
    .select({ id: projectAccess.id })
    .from(projectAccess)
    .where(and(eq(projectAccess.companyId, scope.companyId), eq(projectAccess.userAccountId, userAccountId), eq(projectAccess.projectId, scope.projectId)))
    .limit(1)
  return { name: found.name, serviceProvider, worksInProject: access !== undefined }
}

/** Who assigns and why: the person, or null for the system's own; the note the `assigned` row carries; the instant `ticket-assigned` is dated; and the minter the row's id comes from, the process's where none is named. */
export type Assignment = { companyId: string; by: string | null; note: string | null; at: Date; newId?: IdMinter }

/** Assigns the open ticket the caller holds under its row lock to the account its door judged, or to nobody. Answers the ticket as assigned. */
export async function assignTicket(tx: Tx, current: TicketRow, assignee: string | null, assignment: Assignment): Promise<TicketRow> {
  const { companyId } = assignment
  const [row] = await tx
    .update(ticket)
    .set({ assigneeUserAccountId: assignee })
    .where(and(eq(ticket.companyId, companyId), eq(ticket.id, current.id)))
    .returning(ticketColumns)
  if (row === undefined) throw new Error(`ticket ${current.id} of company ${companyId} assigned and then not there`)
  await appendTicketEvent(
    tx,
    ticketRefOf(companyId, row),
    { kind: "assigned", status: row.status, assigneeUserAccountId: row.assigneeUserAccountId, resolution: null, body: assignment.note, visibility: "internal", objectKey: null, recordedBy: assignment.by, sourceEventId: null },
    assignment.newId,
  )
  if (row.assigneeUserAccountId !== null) await emit(tx, { companyId }, { aggregateId: row.id, kind: "ticket-assigned", payload: ticketOf(row), projectId: row.projectId, occurredAt: assignment.at })
  return row
}
