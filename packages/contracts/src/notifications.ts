// A staff member's notices on the wire (O16 of #290): which e-mails they
// asked for in Settings › Account › Notifications, each person their own.
// Nothing is sent unless asked for: an alert raised at or above the severity
// picked (`alertRaisedMinSeverity`, null for none), and a ticket assigned to
// them (`ticketAssigned`). The API reads and replaces the whole set at
// `/me/notification-preferences`; the worker's notifications consumer sends
// each as a `staff` Message through the provider door, which is log-only
// until a provider is chosen, and `GET /me/notices` reads back the ones the
// caller was sent.
//
// A project's notification rules (part b): which customer notices it sends
// and from which of its message templates — a Bulky Booking booked,
// cancelled, collected or not collected. A rule is the opt-in; there is no
// default text. The API reads and replaces a project's set whole at
// `/projects/:id/notification-rules`, holding each template to the project,
// active and for service; the worker sends each notice through the provider
// door, honouring the customer's consent.
import { CUSTOMER_NOTICE_EVENTS } from "@waste/domain/notifications/vocabulary"
import * as z from "zod"

import { Id } from "./ids"
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

export const CustomerNoticeEvent = z.enum(CUSTOMER_NOTICE_EVENTS)
export type CustomerNoticeEvent = z.infer<typeof CustomerNoticeEvent>

/** One notice a project sends, and the template it is sent from. */
export const NotificationRule = z.object({ event: CustomerNoticeEvent, templateId: Id })
export type NotificationRule = z.infer<typeof NotificationRule>

/** A project's rules, in the vocabulary's order. */
export const NotificationRules = z.object({ projectId: Id, rules: z.array(NotificationRule) })
export type NotificationRules = z.infer<typeof NotificationRules>

/** The sentence a set naming one notice twice earns. */
export const ONE_RULE_PER_NOTICE = "A notice is sent from one template; name each notice once"

/** The whole set, replaced: an empty list sends no notice. */
export const NotificationRulesPut = z
  .strictObject({
    rules: z.array(z.strictObject({ event: CustomerNoticeEvent, templateId: Id })).max(CUSTOMER_NOTICE_EVENTS.length).describe("Each notice the project sends and its template; a notice left out is not sent."),
  })
  .superRefine((body, context) => {
    const seen = new Set<string>()
    body.rules.forEach((rule, index) => {
      if (seen.has(rule.event)) context.addIssue({ code: "custom", path: ["rules", index, "event"], message: ONE_RULE_PER_NOTICE })
      seen.add(rule.event)
    })
  })
export type NotificationRulesPut = z.infer<typeof NotificationRulesPut>
