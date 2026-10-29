// Settings › Message templates' customer notices on the Pilot (O16 of #290,
// part b; C18 of #291): which notices a project sends its customers, and from
// which of its templates, read from and replaced whole at the API's
// `/projects/:id/notification-rules` under `configure.templates`. A notice
// with no template is not sent — there is no default text — and a template
// is offered only where the API would take it: the project's, for service,
// active, and naming no value its notice does not fill (`unfilledByNotice`).
// A broadcast — a route cancelled or running late — names the notification
// areas it reaches, none being the whole project. The worker sends each
// through the log-only sender, honouring the customer's consent.
import type { MessageTemplate } from "@waste/contracts/messaging"
import type { CustomerNoticeEvent, NotificationRules, NotificationRulesPut } from "@waste/contracts/notifications"
import { unfilledByNotice } from "@waste/domain/notifications/notices"
import { BROADCAST_NOTICES } from "@waste/domain/notifications/vocabulary"

/** The picker's value for a notice the project does not send. */
export const NOT_SENT = "not-sent"

/** Each notice as the section names it, in the vocabulary's order. */
export const CUSTOMER_NOTICES: ReadonlyArray<{ event: CustomerNoticeEvent; label: string; hint: string }> = [
  { event: "bulky-booking-booked", label: "Bulky collection booked", hint: "When the office books a bulky collection." },
  { event: "bulky-booking-cancelled", label: "Bulky collection cancelled", hint: "When a booked collection is cancelled." },
  { event: "bulky-booking-collected", label: "Bulky collection collected", hint: "When the driver completes its stop." },
  { event: "bulky-booking-not-collected", label: "Bulky collection not collected", hint: "When the driver records its stop as failed." },
  { event: "collection-reminder", label: "Collection reminder", hint: "From 14:00 the day before a scheduled collection; {{collectionDate}} is the day." },
  { event: "ticket-replied", label: "Ticket reply", hint: "When the office replies to the customer on a ticket; {{ticketNumber}} and {{replyText}}." },
  { event: "ticket-completed", label: "Ticket completed", hint: "When a ticket naming the customer is completed; {{ticketNumber}}." },
  { event: "route-cancelled", label: "Route cancelled", hint: "To the customers of a route the office cancels; {{collectionDate}} is its day." },
  { event: "route-late", label: "Route running late", hint: "To the customers of a route not started by its planned start; {{collectionDate}} is its day." },
]

/** Whether a notice is a broadcast, which may name the areas it reaches. */
export const isBroadcast = (event: CustomerNoticeEvent): boolean => (BROADCAST_NOTICES as readonly CustomerNoticeEvent[]).includes(event)

/** The templates a notice may be sent from: the project's, for service, active, naming no value the notice does not fill. */
export const noticeTemplateOptions = (templates: readonly MessageTemplate[], event: CustomerNoticeEvent): MessageTemplate[] =>
  templates.filter((template) => template.purpose === "service" && template.status === "active" && unfilledByNotice(event, `${template.subject ?? ""} ${template.body}`).length === 0)

/** A notice's pick: its template, or `NOT_SENT`, and a broadcast's areas. */
export type NoticePick = { templateId: string; planningAreaIds: string[] }

/** Each notice's pick, read off the project's rules. */
export const noticePicksOf = (rules: NotificationRules): Record<CustomerNoticeEvent, NoticePick> =>
  Object.fromEntries(
    CUSTOMER_NOTICES.map(({ event }) => {
      const rule = rules.rules.find((candidate) => candidate.event === event)
      return [event, { templateId: rule?.templateId ?? NOT_SENT, planningAreaIds: rule?.planningAreaIds ?? [] }]
    }),
  ) as Record<CustomerNoticeEvent, NoticePick>

/** The body the picks send: each notice with a template, in the vocabulary's order, a broadcast with its areas. */
export const noticeRulesBody = (picks: Readonly<Record<CustomerNoticeEvent, NoticePick>>): NotificationRulesPut => ({
  rules: CUSTOMER_NOTICES.flatMap(({ event }) => {
    const { templateId, planningAreaIds } = picks[event]
    if (templateId === NOT_SENT) return []
    return [isBroadcast(event) ? { event, templateId, planningAreaIds } : { event, templateId }]
  }),
})
