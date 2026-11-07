// A ticket's status moves and assignments, written once for every door that
// makes one: the office's commands (apps/api's routes/tickets.ts), the
// type's automation (commands/ticket-automation.ts), a stop servicing the
// ticket booked for it (commands/ticket-stops.ts) and the consumer completing
// a problem a missed collection supersedes (apps/worker's open-tickets.ts).
// Each door judges a move by the machine (`ticketTransition`) and answers a
// refusal in its own words, and judges an assignee through `assigneeOf`;
// what the move or the assignment writes is here, so a new side effect of
// closing a ticket reaches every door at once.
//
// A move writes the status with the columns a close carries — `closedAt` on
// completed and rejected, every closing column cleared on a reopen — and what
// the door sets beside them, one `status-changed` row, `ticket-completed` or
// `ticket-rejected` on a close, then the type's actions on the status reached
// (#546 of #544), and answers the ticket as they leave it. An assignment
// writes the assignee, one `assigned` row and, to an account,
// `ticket-assigned`.
import type { TicketActionTrigger, TicketResolution, TicketStatus } from "@waste/domain/resolution/vocabulary"
import { triggerOf } from "@waste/domain/resolution/automation"
import { and, eq } from "drizzle-orm"

import type { Tx } from "../client"
import { projectAccess, userAccount } from "../schema/access"
import { ticket } from "../schema/resolution"
import { appendTicketEvent, ticketRefOf } from "./open-ticket"
import { emit } from "./outbox"
import { ticketColumns, ticketOf, type TicketRow } from "./resolution-rows"
import { runTicketAutomation, type AutomationRun } from "./ticket-automation"

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

/** What a door sets beside the status: a completion's resolution and what it arranged, a duplicate's parent, the stop that serviced it. */
export type TicketMoveColumns = {
  resolution?: TicketResolution
  recollectionRouteId?: string | null
  recollectionPickupId?: string | null
  chargeProductId?: string | null
  parentTicketId?: string
  bookedRouteId?: string
  bookedPickupId?: string
}

/** A move the machine allowed: the status it reaches, what the door sets beside it, the history row's note and who recorded it — a person, or null for the system's own — and the instant a close carries. */
export type TicketMove = { to: TicketStatus; set?: TicketMoveColumns; note: string | null; recordedBy: string | null; at: Date }

/** A reopened ticket is open: what a close set is cleared, the close standing in the history. */
const REOPENED = { resolution: null, recollectionRouteId: null, recollectionPickupId: null, chargeProductId: null, closedAt: null }

const closingOf = (to: TicketStatus, at: Date) => (to === "completed" || to === "rejected" ? { closedAt: at } : to === "open" ? REOPENED : {})

const closes = (to: TicketStatus): to is "completed" | "rejected" => to === "completed" || to === "rejected"

/**
 * Moves the ticket the caller holds under its row lock to the status the
 * machine allowed, and runs its type's actions on the status reached with
 * the run, `depth` deep. Answers the ticket as the actions leave it.
 */
export async function moveTicket(tx: Tx, run: AutomationRun, current: TicketRow, move: TicketMove): Promise<TicketRow> {
  const [row] = await tx
    .update(ticket)
    .set({ status: move.to, ...closingOf(move.to, move.at), ...move.set })
    .where(and(eq(ticket.companyId, run.companyId), eq(ticket.id, current.id)))
    .returning(ticketColumns)
  if (row === undefined) throw new Error(`ticket ${current.id} of company ${run.companyId} moved and then not there`)
  await appendTicketEvent(
    tx,
    ticketRefOf(run.companyId, row),
    {
      kind: "status-changed",
      status: move.to,
      assigneeUserAccountId: row.assigneeUserAccountId,
      resolution: move.to === "completed" ? (row.resolution as TicketResolution) : null,
      body: move.note,
      visibility: "internal",
      objectKey: null,
      recordedBy: move.recordedBy,
      sourceEventId: null,
    },
    run.newId,
  )
  if (closes(move.to)) await emit(tx, run, { aggregateId: row.id, kind: move.to === "completed" ? "ticket-completed" : "ticket-rejected", payload: ticketOf(row), projectId: row.projectId, occurredAt: move.at })
  const reached: TicketActionTrigger | undefined = triggerOf(move.to)
  if (reached === undefined) return row
  await runTicketAutomation(tx, run, row.id, reached)
  return await currentTicket(tx, run.companyId, row.id)
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

/** Assigns the open ticket the caller holds under its row lock to the account its door judged, or to nobody: the `assigned` row with the note, recorded by the person or by nobody, and `ticket-assigned` to an account. Answers the ticket as assigned. */
export async function assignTicket(tx: Tx, run: Pick<AutomationRun, "companyId" | "newId" | "now">, current: TicketRow, assignee: string | null, line: { note: string | null; recordedBy: string | null }): Promise<TicketRow> {
  const [row] = await tx
    .update(ticket)
    .set({ assigneeUserAccountId: assignee })
    .where(and(eq(ticket.companyId, run.companyId), eq(ticket.id, current.id)))
    .returning(ticketColumns)
  if (row === undefined) throw new Error(`ticket ${current.id} of company ${run.companyId} assigned and then not there`)
  await appendTicketEvent(
    tx,
    ticketRefOf(run.companyId, row),
    { kind: "assigned", status: row.status as TicketStatus, assigneeUserAccountId: row.assigneeUserAccountId, resolution: null, body: line.note, visibility: "internal", objectKey: null, recordedBy: line.recordedBy, sourceEventId: null },
    run.newId,
  )
  if (row.assigneeUserAccountId !== null) await emit(tx, run, { aggregateId: row.id, kind: "ticket-assigned", payload: ticketOf(row), projectId: row.projectId, occurredAt: run.now() })
  return row
}
