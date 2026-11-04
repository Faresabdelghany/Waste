// A staff member's own notices (O16 of #290): which e-mails they asked for,
// and the ones they were sent. `GET /me/notification-preferences` reads the
// caller's choice — nothing until they choose, the default — and `PUT`
// replaces it whole: an alert raised at or above a severity, and a ticket
// assigned to them, one `notification_preference` row each while asked for
// and none otherwise. The worker's notifications consumer reads the rows when
// an event comes (apps/worker/src/jobs/staff-notifications.ts) and queues each
// notice as a `staff` message, which `GET /me/notices` reads back newest
// first: the delivery log's rows to the caller, in the projects they work in.
//
// A person's own settings need no grant beyond being signed in: the guard's
// active account is the whole of it. Whether an alert reaches them is the
// worker's to judge at the event, against the grant on `operate.exceptions`
// and the alert's project as they then stand.
import { Message } from "@waste/contracts/messaging"
import { NO_NOTIFICATIONS, NotificationPreferences, NotificationPreferencesPut } from "@waste/contracts/notifications"
import { Page, PageRequest } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { message } from "@waste/db/schema/messaging"
import { notificationPreference } from "@waste/db/schema/notifications"
import type { NotificationEvent } from "@waste/domain/notifications/vocabulary"
import type { AlertSeverity } from "@waste/domain/resolution/vocabulary"
import { and, desc, eq, lt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects } from "../auth/projects"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, validate } from "../problem"
import { messageColumns, messageOf } from "./messages"
import { describeJson } from "./shared"

const NoticePage = Page(Message)

const signedIn = {
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem("No active account here."),
}

/** The caller's preferences as their rows stand. */
async function preferencesOf(tx: Tx, principal: Principal): Promise<NotificationPreferences> {
  const rows = await tx
    .select({ event: notificationPreference.event, minSeverity: notificationPreference.minSeverity })
    .from(notificationPreference)
    .where(and(eq(notificationPreference.companyId, principal.companyId), eq(notificationPreference.userAccountId, principal.user.id)))
  const answered: NotificationPreferences = { ...NO_NOTIFICATIONS }
  for (const row of rows) {
    if (row.event === "alert-raised") answered.alertRaisedMinSeverity = row.minSeverity as AlertSeverity
    else if (row.event === "ticket-assigned") answered.ticketAssigned = true
  }
  return answered
}

/** One event asked for with its severity, or not asked for: the row written over, or removed. */
async function putPreference(tx: Tx, principal: Principal, event: NotificationEvent, asked: { minSeverity: AlertSeverity | null } | null): Promise<void> {
  const mine = and(eq(notificationPreference.companyId, principal.companyId), eq(notificationPreference.userAccountId, principal.user.id), eq(notificationPreference.event, event))
  if (asked === null) {
    await tx.delete(notificationPreference).where(mine)
    return
  }
  await tx
    .insert(notificationPreference)
    .values({ id: newId(), companyId: principal.companyId, userAccountId: principal.user.id, event, minSeverity: asked.minSeverity })
    .onConflictDoUpdate({ target: [notificationPreference.companyId, notificationPreference.userAccountId, notificationPreference.event], set: { minSeverity: asked.minSeverity } })
}

export function notificationRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/me/notification-preferences",
      describeRoute({
        operationId: "getNotificationPreferences",
        summary: "Which e-mails I asked for",
        description:
          "The caller's own choice of staff e-mails (O16 of #290): the least severe alert they are told of when one is raised in a project they read alerts in (`alertRaisedMinSeverity`, null for none), and whether they are told when a ticket is assigned to them. An account that never chose asks for nothing.",
        security: BEARER_SECURITY,
        responses: { 200: describeJson("The caller's preferences.", NotificationPreferences), ...signedIn },
      }),
      guard,
      async (c) => c.json(await preferencesOf(c.get("tx"), c.get("principal"))),
    )
    .put(
      "/me/notification-preferences",
      describeRoute({
        operationId: "putNotificationPreferences",
        summary: "Choose which e-mails I get",
        description:
          "Replaces the caller's choice whole and answers it as it now stands. An alert e-mail goes to an account whose role reads alerts (`view` on `operate.exceptions`) in the alert's project, judged when the alert is raised, so a choice made without that grant waits for it. The e-mails are sent through the deployment's messaging provider, a log-only sender until a provider is chosen; `GET /me/notices` lists what was sent.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The caller's preferences as they now stand.", NotificationPreferences),
          400: describeProblem("The body is missing a field, names a severity that is not one, or names a member the body does not take."),
          ...signedIn,
        },
      }),
      guard,
      validate("json", NotificationPreferencesPut),
      async (c) => {
        const tx = c.get("tx")
        const principal = c.get("principal")
        const body = c.req.valid("json")
        await putPreference(tx, principal, "alert-raised", body.alertRaisedMinSeverity === null ? null : { minSeverity: body.alertRaisedMinSeverity })
        await putPreference(tx, principal, "ticket-assigned", body.ticketAssigned ? { minSeverity: null } : null)
        return c.json(await preferencesOf(tx, principal))
      },
    )
    .get(
      "/me/notices",
      describeRoute({
        operationId: "listMyNotices",
        summary: "The e-mails I was sent",
        description:
          "One page of the staff notices sent to the caller, newest first, in the projects they work in: each the `staff` message the worker queued for an alert raised or a ticket assigned, with what was rendered, the address it went to and how its sending stands. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of the caller's notices.", NoticePage),
          400: describeProblem("The page size is outside 1..200, or the cursor is not one this API wrote."),
          ...signedIn,
        },
      }),
      guard,
      validate("query", PageRequest),
      async (c) => {
        const { limit, cursor } = c.req.valid("query")
        const principal = c.get("principal")
        const after = afterCursor(cursor)
        const rows = await c
          .get("tx")
          .select(messageColumns)
          .from(message)
          .where(
            and(
              eq(message.companyId, principal.companyId),
              inProjects(message.projectId, principal),
              eq(message.userAccountId, principal.user.id),
              after === undefined ? undefined : lt(message.id, after),
            ),
          )
          .orderBy(desc(message.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(messageOf), limit))
      },
    )
}
