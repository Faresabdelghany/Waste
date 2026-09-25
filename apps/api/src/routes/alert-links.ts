// An alert links to one ticket (Issue #109 §7.17), spelled once for the two
// doors that link one: `POST /tickets` with an `alertId` in its body
// (routes/ticket-writes.ts, inside `openTicket`) and
// `POST /alerts/:id/link-ticket` (routes/alerts.ts). The glossary's "may
// create or link to a ticket" is one column, `alert.ticket_id`, read from
// either side, and the rules over it are the same whichever door: the alert
// is a row of the project (400 at `alertId`, `requireAlert`'s sentence); a
// resolved alert does not change (409, the domain's one sentence for every
// command on a resolved alert); an alert already linked to another ticket
// stays linked — 409 naming that ticket, "This alert is linked to ticket
// T-8831; an alert links to one ticket", so the person reads which case to
// look at — and an alert already linked to this very ticket is nothing to do,
// no write.
//
// Under the alert's row lock, taken before the read: the status and the link
// are rules the API holds and not the database, so two links of one alert
// take turns and the second sees what the first wrote (routes/shared.ts).
import { ticketLabel } from "@waste/contracts/resolution"
import type { Tx } from "@waste/db/client"
import { alert, ticket } from "@waste/db/schema/resolution"
import { ALERT_DOES_NOT_CHANGE } from "@waste/domain/resolution/transitions"
import { and, eq } from "drizzle-orm"

import { problem } from "../problem"
import { requireAlert, type Scope } from "./references"
import { lockRow } from "./shared"

/** What linking an alert that is already another ticket's is told, naming that ticket. */
export const linkedToAnother = (label: string): string => `This alert is linked to ticket ${label}; an alert links to one ticket`

/**
 * Sets `alert.ticket_id` to the ticket, under the alert's row lock, or
 * refuses: 400 at `alertId` for an alert that is not the project's, 409 for
 * a resolved alert or one linked to another ticket. The same ticket again is
 * no write. `scope` is the ticket's project, which the alert must share.
 */
export async function linkAlert(tx: Tx, scope: Scope, alertId: string, ticketId: string): Promise<void> {
  await lockRow(tx, alert, { companyId: scope.companyId, id: alertId })
  const found = await requireAlert(tx, scope, alertId)
  // `requireAlert` answers undefined for a null id alone, and the id here is a string.
  if (found === undefined) throw new Error(`requireAlert answered nothing for alert ${alertId}`)
  if (found.status === "resolved") throw problem(409, { detail: ALERT_DOES_NOT_CHANGE })
  if (found.ticketId === ticketId) return
  if (found.ticketId !== null) {
    const [linked] = await tx
      .select({ number: ticket.number })
      .from(ticket)
      .where(and(eq(ticket.companyId, scope.companyId), eq(ticket.id, found.ticketId)))
      .limit(1)
    // The key holds every link to a ticket of the company, so the row is there.
    if (linked === undefined) throw new Error(`alert ${alertId} names ticket ${found.ticketId}, which is not there`)
    throw problem(409, { detail: linkedToAnother(ticketLabel(linked.number)) })
  }
  await tx
    .update(alert)
    .set({ ticketId })
    .where(and(eq(alert.companyId, scope.companyId), eq(alert.id, alertId)))
}
