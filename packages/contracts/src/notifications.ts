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
// cancelled, collected or not collected, and since C18 of #291 a collection
// reminder, a ticket replied to and completed, and a route cancelled or late,
// the last two narrowed, where the rule says, to `notification` planning
// areas. A rule is the opt-in; there is no
// default text. The API reads and replaces a project's set whole at
// `/projects/:id/notification-rules`, holding each template to the project,
// active and for service; the worker sends each notice through the provider
// door, honouring the customer's consent.
import { BROADCAST_NOTICES, CUSTOMER_NOTICE_EVENTS } from "@waste/domain/notifications/vocabulary"
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

/** One notice a project sends, the template it is sent from, and, for a broadcast, the `notification` areas it is narrowed to (C18 of #291). */
export const NotificationRule = z.object({ event: CustomerNoticeEvent, templateId: Id, planningAreaIds: z.array(Id).default([]) })
export type NotificationRule = z.infer<typeof NotificationRule>

/** A project's rules, in the vocabulary's order. */
export const NotificationRules = z.object({ projectId: Id, rules: z.array(NotificationRule) })
export type NotificationRules = z.infer<typeof NotificationRules>

/** The sentence a set naming one notice twice earns. */
export const ONE_RULE_PER_NOTICE = "A notice is sent from one template; name each notice once"

/** The sentence a rule naming areas for a notice that is not a broadcast earns. */
export const AREAS_ARE_A_BROADCASTS = "Only a route cancelled or late is narrowed to areas; this notice goes to its own customer"

/** The most areas a broadcast names: a project's notification zones, a handful. */
export const NOTICE_AREAS_MAX = 50

/** The whole set, replaced: an empty list sends no notice. */
export const NotificationRulesPut = z
  .strictObject({
    rules: z
      .array(
        z.strictObject({
          event: CustomerNoticeEvent,
          templateId: Id,
          planningAreaIds: z.array(Id).max(NOTICE_AREAS_MAX).optional().describe("For a route cancelled or late: the `notification` planning areas its customers are narrowed to; none or absent reaches every stop of the route."),
        }),
      )
      .max(CUSTOMER_NOTICE_EVENTS.length)
      .describe("Each notice the project sends and its template; a notice left out is not sent."),
  })
  .superRefine((body, context) => {
    const seen = new Set<string>()
    body.rules.forEach((rule, index) => {
      if (seen.has(rule.event)) context.addIssue({ code: "custom", path: ["rules", index, "event"], message: ONE_RULE_PER_NOTICE })
      seen.add(rule.event)
      const areas = rule.planningAreaIds ?? []
      if (areas.length > 0 && !(BROADCAST_NOTICES as readonly string[]).includes(rule.event)) context.addIssue({ code: "custom", path: ["rules", index, "planningAreaIds"], message: AREAS_ARE_A_BROADCASTS })
      if (new Set(areas).size !== areas.length) context.addIssue({ code: "custom", path: ["rules", index, "planningAreaIds"], message: "Name each area once" })
    })
  })
export type NotificationRulesPut = z.infer<typeof NotificationRulesPut>
