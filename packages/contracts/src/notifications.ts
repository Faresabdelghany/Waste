// A staff member's notices on the wire (O16 of #290): which e-mails they
// asked for in Settings › Account › Notifications, each person their own.
// Nothing is sent unless asked for: an alert raised at or above the severity
// picked (`alertRaisedMinSeverity`, null for none), and a ticket assigned to
// them (`ticketAssigned`). The API reads and replaces the whole set at
// `/me/notification-preferences`; the worker's notifications consumer sends
// each as a `staff` Message through the provider door, which is log-only
// until a provider is chosen, and `GET /me/notices` reads back the ones the
// caller was sent.
import * as z from "zod"

import { AlertSeverity } from "./resolution"

export const NotificationPreferences = z.object({
  /** The least severe alert the caller is e-mailed about; null for no alert e-mails. */
  alertRaisedMinSeverity: AlertSeverity.nullable(),
  /** Whether the caller is e-mailed when a ticket is assigned to them. */
  ticketAssigned: z.boolean(),
})
export type NotificationPreferences = z.infer<typeof NotificationPreferences>

/** The whole set, replaced: what the caller now wants to be e-mailed about. */
export const NotificationPreferencesPut = z.strictObject({
  alertRaisedMinSeverity: AlertSeverity.nullable().describe("The least severe alert to be e-mailed about (`critical` for critical alone, `low` for every alert); null for none."),
  ticketAssigned: z.boolean().describe("E-mail me when a ticket is assigned to me."),
})
export type NotificationPreferencesPut = z.infer<typeof NotificationPreferencesPut>

/** None asked for: what an account that never chose reads. */
export const NO_NOTIFICATIONS: NotificationPreferences = { alertRaisedMinSeverity: null, ticketAssigned: false }
