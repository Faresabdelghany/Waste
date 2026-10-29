// The staff notices (O16 of #290): the outbox's third consumer, on the two
// kinds a staff member may ask to hear of by e-mail — `alert-raised`, an alert
// raised by the office or by a rule, and `ticket-assigned`, a ticket given to
// someone. Each person's choice is their `notification_preference` rows
// (Settings › Account › Notifications, `PUT /me/notification-preferences`):
// none, the default, is no e-mail at all.
//
// An alert reaches every active account of its company that asked for alerts
// at or above its severity (`severityReaches`) and can read it — a grant on
// `operate.exceptions`, the alerts' module, and the alert's project among
// theirs (every project, or a Project Access row) — so nobody is e-mailed what
// the board would not show them. A ticket assigned reaches its assignee, if
// active and asking. The text is the domain's (`alertNotice`,
// `ticketAssignedNotice`), from the payload as the write answered it and the
// project's and the company's names, and each is queued through
// `queueStaffMessage` (@waste/db/commands/messaging): a `staff` message on the
// delivery log, sent by `messaging.send` through the provider door like every
// other message. A staff notice is the company's word to its own people, so
// no consent governs it.
//
// pg-boss delivers at least once; the event's id and the recipient key each
// notice once (`message_source_event_id_user_account_id_idx`), so a
// redelivery writes nothing. Every read and write is `wms_api`'s under
// `withCompany` on the event's company, in one transaction.
import { Alert } from "@waste/contracts/alerts"
import { Ticket } from "@waste/contracts/tickets"
import type { Tx } from "@waste/db/client"
import { queueStaffMessage } from "@waste/db/commands/messaging"
import { newId } from "@waste/db/ids"
import { projectAccess, roleGrant, userAccount } from "@waste/db/schema/access"
import { notificationPreference } from "@waste/db/schema/notifications"
import { company, project } from "@waste/db/schema/organisation"
import { withCompany } from "@waste/db/tenant"
import type { OutboxKind } from "@waste/domain/execution/vocabulary"
import { alertNotice, severityReaches, ticketAssignedNotice, type Notice } from "@waste/domain/notifications/notices"
import { NOTIFICATION_EVENTS } from "@waste/domain/notifications/vocabulary"
import type { AlertSeverity } from "@waste/domain/resolution/vocabulary"
import { and, eq, exists, isNull, or, sql } from "drizzle-orm"

import { defineOutboxConsumer, type RelayedEvent } from "../outbox/subscribe"
import type { JobContext } from "./definition"

/** The module whose view grant reads an alert: the board's. */
export const ALERTS_MODULE = "operate.exceptions"

/** One notice to one account. */
type Addressed = { userAccountId: string; notice: Notice }

/** The project's and the company's names, which every notice is signed and placed with. */
async function namesOf(tx: Tx, companyId: string, projectId: string): Promise<{ projectName: string; companyName: string }> {
  const [row] = await tx
    .select({ projectName: project.name, companyName: company.name })
    .from(project)
    .innerJoin(company, eq(company.id, project.companyId))
    .where(and(eq(project.companyId, companyId), eq(project.id, projectId)))
    .limit(1)
  if (row === undefined) throw new Error(`project ${projectId} is not in company ${companyId}`)
  return row
}

/** The active accounts asking for alerts at or above this one's severity who can read it on the board. */
async function alertRecipients(tx: Tx, companyId: string, raised: Alert): Promise<Addressed[]> {
  const asking = await tx
    .select({ userAccountId: userAccount.id, minSeverity: notificationPreference.minSeverity })
    .from(notificationPreference)
    .innerJoin(userAccount, and(eq(userAccount.companyId, notificationPreference.companyId), eq(userAccount.id, notificationPreference.userAccountId)))
    .where(
      and(
        eq(notificationPreference.companyId, companyId),
        eq(notificationPreference.event, "alert-raised"),
        isNull(userAccount.deactivatedAt),
        exists(tx.select({ one: sql`1` }).from(roleGrant).where(and(eq(roleGrant.companyId, companyId), eq(roleGrant.roleId, userAccount.roleId), eq(roleGrant.moduleKey, ALERTS_MODULE)))),
        or(
          eq(userAccount.allProjects, true),
          exists(tx.select({ one: sql`1` }).from(projectAccess).where(and(eq(projectAccess.companyId, companyId), eq(projectAccess.userAccountId, userAccount.id), eq(projectAccess.projectId, raised.projectId)))),
        ),
      ),
    )
    .orderBy(userAccount.id)
  const reached = asking.filter((row) => row.minSeverity !== null && severityReaches(raised.severity, row.minSeverity as AlertSeverity))
  if (reached.length === 0) return []
  const notice = alertNotice(raised, await namesOf(tx, companyId, raised.projectId))
  return reached.map(({ userAccountId }) => ({ userAccountId, notice }))
}

/** The assignee, where active and asking to hear of a ticket given to them. */
async function ticketRecipients(tx: Tx, companyId: string, assigned: Ticket): Promise<Addressed[]> {
  if (assigned.assigneeUserAccountId === null) return []
  const [assignee] = await tx
    .select({ fullName: userAccount.fullName })
    .from(notificationPreference)
    .innerJoin(userAccount, and(eq(userAccount.companyId, notificationPreference.companyId), eq(userAccount.id, notificationPreference.userAccountId)))
    .where(
      and(
        eq(notificationPreference.companyId, companyId),
        eq(notificationPreference.event, "ticket-assigned"),
        eq(notificationPreference.userAccountId, assigned.assigneeUserAccountId),
        isNull(userAccount.deactivatedAt),
      ),
    )
    .limit(1)
  if (assignee === undefined) return []
  const notice = ticketAssignedNotice(assigned, { ...(await namesOf(tx, companyId, assigned.projectId)), recipientName: assignee.fullName })
  return [{ userAccountId: assigned.assigneeUserAccountId, notice }]
}

/** What one event came to: how many notices were queued, the rest having been queued before or reaching nobody. */
export type Notified = { event: string; kind: OutboxKind; queued: number }

/** One event to the notices it owes, queued in one fenced transaction as the tenant. */
export async function notifyStaffFor(event: RelayedEvent<(typeof NOTIFICATION_EVENTS)[number]>, { api, send, log }: Pick<JobContext, "api" | "send" | "log">): Promise<Notified> {
  const queued = await withCompany(api.db, event.companyId, async (tx) => {
    const addressed = event.kind === "alert-raised" ? await alertRecipients(tx, event.companyId, Alert.parse(event.payload)) : await ticketRecipients(tx, event.companyId, Ticket.parse(event.payload))
    let count = 0
    for (const { userAccountId, notice } of addressed) {
      const written = await queueStaffMessage(tx, send, { id: newId(), companyId: event.companyId, projectId: event.projectId, userAccountId, sourceEventId: event.id, ...notice })
      if (written !== null) count += 1
    }
    return count
  })
  if (queued > 0) log(`notifications: ${event.kind} ${event.id} → ${queued} staff notice${queued === 1 ? "" : "s"} queued`)
  return { event: event.id, kind: event.kind, queued }
}

/** The two registry entries, one per kind; spread into `OUTBOX_CONSUMERS`. */
export const notifyStaff = defineOutboxConsumer({
  name: "notifications",
  kinds: NOTIFICATION_EVENTS,
  description: "E-mails the staff who asked to hear of it: an alert raised at or above the severity each chose, to those who can read it, and a ticket assigned, to its assignee; once per event and person however often it is delivered.",
  handler: (event, context) => notifyStaffFor(event, context),
})
