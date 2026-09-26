// The one link between an Alert and a Ticket (Issue #109 §7.17): the column
// `alert.ticket_id`, read from either side — an alert "may create or link to a
// ticket" (CONTEXT.md), and "linked to ticket" is that column not null and no
// status. Two doors set it, `POST /tickets` with `alertId` (the ticket the
// alert created, inside `openTicket` beside this file) and
// `POST /alerts/:id/link-ticket` (the ticket it was linked to afterwards,
// the API's routes/alerts.ts), and this is the one function both run, so an
// alert is held to the same three rules whichever door it came through:
//
//   it is an alert of the project     — refused as a 400 at the field the
//                                       body carried it in (`NOT_AN_ALERT`,
//                                       `alertId` on the ticket create); the
//                                       link command's own 404 has answered
//                                       before it gets here, so the check
//                                       passes there;
//   it is not resolved                — a 409, the domain's sentence: a
//                                       resolved alert does not change through
//                                       any door (@waste/domain/resolution/
//                                       transitions); the link command has
//                                       judged this before it read its body,
//                                       so here it is already true there and
//                                       holds for the ticket create, whose
//                                       alert is a body field;
//   it names no other ticket          — a 409 naming the one it names by its
//                                       label, "This alert is linked to ticket
//                                       T-8831; an alert links to one ticket":
//                                       the column is one, and re-linking is
//                                       refused rather than overwritten, since
//                                       the first link is a decision the second
//                                       does not silently undo.
//
// The refusals are `Refused` (commands/shared.ts) and not the API's problem:
// the statement runs in the API's request and in the worker's job alike, and
// the API's middleware maps a `Refused` to the problem of its status, the
// 400 carrying its field. The same ticket again is nothing to do and writes
// nothing, so a repeated link answers as it stands (the `confirm` precedent),
// and the row comes back either way — as found, or as the update returned it
// — so a caller answers it without a read of its own. The write runs under
// the alert's row lock, taken here before the read, so two links of one
// alert take turns and the second sees what the first wrote; a caller that
// already holds the lock holds it twice, which is once. The ticket itself is
// not held here — the ticket create has just written it, and the link
// command holds it to the project before it calls.
import { ticketLabel } from "@waste/contracts/resolution"
import { ALERT_DOES_NOT_CHANGE } from "@waste/domain/resolution/transitions"
import { and, eq } from "drizzle-orm"

import type { Tx } from "../client"
import { alert, ticket } from "../schema/resolution"
import { alertColumns, type AlertRow } from "./resolution-rows"
import { lockRow, refused, RefusedField } from "./shared"

/** The tenant and the project a statement is bounded by: what `openTicket` and the link command both know. */
export type Scope = { companyId: string; projectId: string }

/** What a body naming an alert that is not the project's is told. */
export const NOT_AN_ALERT = "Not an alert of this project"

/** What linking an alert that already names another ticket is told: the ticket it names, by its label. */
export const linkedToAnother = (label: string): string => `This alert is linked to ticket ${label}; an alert links to one ticket`

/** One alert of the project by id, whole — its status and the one ticket it names — or undefined. */
export async function findAlert(tx: Tx, scope: Scope, alertId: string): Promise<AlertRow | undefined> {
  const [found] = await tx
    .select(alertColumns)
    .from(alert)
    .where(and(eq(alert.companyId, scope.companyId), eq(alert.projectId, scope.projectId), eq(alert.id, alertId)))
    .limit(1)
  return found
}

/**
 * Sets `alert.ticket_id` to the ticket, under the three rules above, or
 * writes nothing when the alert already names it, and answers the alert as
 * it now stands — the row the update returned, or the one found. `path` is
 * where the body carried the alert's id, for the 400 when it is not the
 * project's.
 */
export async function linkAlert(tx: Tx, scope: Scope, alertId: string, ticketId: string, path = "alertId"): Promise<AlertRow> {
  await lockRow(tx, alert, { companyId: scope.companyId, id: alertId })
  const found = await findAlert(tx, scope, alertId)
  if (found === undefined) throw new RefusedField(path, NOT_AN_ALERT)
  if (found.status === "resolved") throw refused(409, ALERT_DOES_NOT_CHANGE)
  if (found.ticketId === ticketId) return found
  if (found.ticketId !== null) throw refused(409, linkedToAnother(await labelOf(tx, scope.companyId, found.ticketId)))
  const [linked] = await tx
    .update(alert)
    .set({ ticketId })
    .where(and(eq(alert.companyId, scope.companyId), eq(alert.id, alertId)))
    .returning(alertColumns)
  if (linked === undefined) throw new Error(`alert ${alertId} was read under its lock and the update did not find it`)
  return linked
}

/** The label of the ticket an alert already names: the key holds the row there, so a miss is a bug and not a client's. */
async function labelOf(tx: Tx, companyId: string, ticketId: string): Promise<string> {
  const [found] = await tx
    .select({ number: ticket.number })
    .from(ticket)
    .where(and(eq(ticket.companyId, companyId), eq(ticket.id, ticketId)))
    .limit(1)
  if (found === undefined) throw new Error(`alert names ticket ${ticketId}, which the key says is there and the read does not find`)
  return ticketLabel(found.number)
}
