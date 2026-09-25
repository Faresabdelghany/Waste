// The one link between an Alert and a Ticket (Issue #109 §7.17): the column
// `alert.ticket_id`, read from either side — an alert "may create or link to a
// ticket" (CONTEXT.md), and "linked to ticket" is that column not null and no
// status. Two doors set it, `POST /tickets` with `alertId` (the ticket the
// alert created, inside routes/ticket-writes.ts's `openTicket`) and
// `POST /alerts/:id/link-ticket` (the ticket it was linked to afterwards,
// routes/alerts.ts), and this is the one function both run, so an alert is
// held to the same three rules whichever door it came through:
//
//   it is an alert of the project     — 400 at the field (`requireAlert`,
//                                       routes/references.ts), `alertId` on
//                                       the ticket create; the link command's
//                                       own 404 has answered before it gets
//                                       here, so the check passes there;
//   it is not resolved                — 409, the domain's sentence: a resolved
//                                       alert does not change through any door
//                                       (@waste/domain/resolution/transitions);
//                                       the link command has judged this before
//                                       it read its body, so here it is already
//                                       true there and holds for the ticket
//                                       create, whose alert is a body field;
//   it names no other ticket          — 409 naming the one it names by its
//                                       label, "This alert is linked to ticket
//                                       T-8831; an alert links to one ticket":
//                                       the column is one, and re-linking is
//                                       refused rather than overwritten, since
//                                       the first link is a decision the second
//                                       does not silently undo.
//
// The same ticket again is nothing to do and writes nothing, so a repeated
// link answers as it stands (the `confirm` precedent), and the row comes
// back either way — as found, or as the update returned it — so a caller
// answers it without a read of its own. The write runs under the alert's row
// lock, taken here before the read (routes/shared.ts), so two links of one
// alert take turns and the second sees what the first wrote; a caller that
// already holds the lock holds it twice, which is once. The ticket itself is
// not held here — the ticket create has just written it, and the link command
// holds it to the project before it calls. Both doors keep the one order every
// command keeps (routes/tickets.ts): the path's own row first — its 404, then
// its own state as a 409 — then the body's 400s in body order, then the 409s
// that need the body. The create's alert is a body field, so its three rules
// all sit in the second and third tiers and this function is where they run;
// the command's alert is the path's row, so its resolved state is answered
// before its body is read, and this function meets it already judged.
import { ticketLabel } from "@waste/contracts/resolution"
import type { Tx } from "@waste/db/client"
import { alert, ticket } from "@waste/db/schema/resolution"
import { ALERT_DOES_NOT_CHANGE } from "@waste/domain/resolution/transitions"
import { and, eq } from "drizzle-orm"

import { problem } from "../problem"
import { requireAlert, type Scope } from "./references"
import { alertColumns, type AlertRow } from "./resolution-shapes"
import { lockRow } from "./shared"

/** What linking an alert that already names another ticket is told: the ticket it names, by its label. */
export const linkedToAnother = (label: string): string => `This alert is linked to ticket ${label}; an alert links to one ticket`

/**
 * Sets `alert.ticket_id` to the ticket, under the three rules above, or
 * writes nothing when the alert already names it, and answers the alert as
 * it now stands — the row the update returned, or the one found. `path` is
 * where the body carried the alert's id, for the 400 when it is not the
 * project's.
 */
export async function linkAlert(tx: Tx, scope: Scope, alertId: string, ticketId: string, path = "alertId"): Promise<AlertRow> {
  await lockRow(tx, alert, { companyId: scope.companyId, id: alertId })
  const found = await requireAlert(tx, scope, alertId, { path })
  if (found.status === "resolved") throw problem(409, { detail: ALERT_DOES_NOT_CHANGE })
  if (found.ticketId === ticketId) return found
  if (found.ticketId !== null) throw problem(409, { detail: linkedToAnother(await labelOf(tx, scope.companyId, found.ticketId)) })
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
