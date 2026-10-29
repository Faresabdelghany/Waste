// Settings › Notifications on the Pilot (O16 of #290): the staff e-mails a
// person asked for, read and replaced whole at `/me/notification-preferences`,
// and the ones they were sent, `GET /me/notices`. The pane reads and writes
// the API directly (components/settings/notifications-settings-on-api.tsx),
// as the Ticket SLA's does: a person's own settings, not a workspace
// module's records. Nothing is sent until asked for, and an alert e-mail
// reaches only a role that reads alerts on the board (`operate.exceptions`),
// judged by the worker when the alert is raised. The e-mails go through the
// deployment's messaging provider — a log-only sender until a provider is
// chosen — so a notice reads `Sent` there without reaching an inbox.
import type { Message } from "@waste/contracts/messaging"
import type { NotificationPreferences } from "@waste/contracts/notifications"
import type { AlertSeverity } from "@waste/contracts/resolution"

import { allows, type Grants } from "../api/grants"

/** The module whose `view` an alert e-mail needs: the alerts' board. */
export const ALERTS_MODULE_KEY = "operate.exceptions"

/** The alert picker's value for no alert e-mails. */
export const NO_ALERTS = "none"

/** The alert picker, the most severe first: each option is that severity and every one more severe. */
export const ALERT_THRESHOLD_OPTIONS: ReadonlyArray<{ value: AlertSeverity | typeof NO_ALERTS; label: string }> = [
  { value: NO_ALERTS, label: "No alert e-mails" },
  { value: "critical", label: "Critical alerts" },
  { value: "high", label: "High and critical alerts" },
  { value: "medium", label: "Medium and above" },
  { value: "low", label: "Every alert" },
]

/** The picker's value for a set of preferences. */
export const alertThresholdOf = (preferences: NotificationPreferences): AlertSeverity | typeof NO_ALERTS => preferences.alertRaisedMinSeverity ?? NO_ALERTS

/** The body a pick of the alert threshold and the assignment's switch sends. */
export const preferencesBodyOf = (threshold: AlertSeverity | typeof NO_ALERTS, ticketAssigned: boolean): NotificationPreferences => ({
  alertRaisedMinSeverity: threshold === NO_ALERTS ? null : threshold,
  ticketAssigned,
})

/** Why an alert e-mail will not reach this role, or null where it will. */
export const alertsWithheldBecause = (grants: Grants | undefined): string | null =>
  allows(grants, ALERTS_MODULE_KEY, "view") ? null : "Your role does not read alerts, so no alert e-mail reaches you whatever you choose here."

/** One notice as the list shows it: what it said, where it went, and how its sending stands. */
export type NoticeRow = { id: string; subject: string; to: string; status: string; sentAt: string | null; reason: string | null }

const STATUS_WORDS: Readonly<Record<Message["status"], string>> = { queued: "Queued", sent: "Sent", failed: "Failed", withheld: "Withheld" }

export const noticeRowOf = (notice: Message): NoticeRow => ({
  id: notice.id,
  subject: notice.subject ?? notice.body.split("\n")[0] ?? "",
  to: notice.recipient,
  status: STATUS_WORDS[notice.status],
  sentAt: notice.sentAt,
  reason: notice.reason,
})
