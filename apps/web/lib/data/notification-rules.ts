// Settings › Message templates' customer notices on the Pilot (O16 of #290,
// part b): which notices a project sends a Bulky Booking's customer, and from
// which of its templates, read from and replaced whole at the API's
// `/projects/:id/notification-rules` under `configure.templates`. A notice
// with no template is not sent — there is no default text — and a template
// is offered only where the API would take it: the project's, for service,
// active. The worker sends each through the log-only sender, honouring the
// customer's consent.
import type { MessageTemplate } from "@waste/contracts/messaging"
import type { CustomerNoticeEvent, NotificationRules, NotificationRulesPut } from "@waste/contracts/notifications"

/** The picker's value for a notice the project does not send. */
export const NOT_SENT = "not-sent"

/** Each notice as the section names it, in the vocabulary's order. */
export const CUSTOMER_NOTICES: ReadonlyArray<{ event: CustomerNoticeEvent; label: string; hint: string }> = [
  { event: "bulky-booking-booked", label: "Bulky collection booked", hint: "When the office books a bulky collection." },
  { event: "bulky-booking-cancelled", label: "Bulky collection cancelled", hint: "When a booked collection is cancelled." },
  { event: "bulky-booking-collected", label: "Bulky collection collected", hint: "When the driver completes its stop." },
  { event: "bulky-booking-not-collected", label: "Bulky collection not collected", hint: "When the driver records its stop as failed." },
]

/** The templates a notice may be sent from: the project's, for service, active. */
export const noticeTemplateOptions = (templates: readonly MessageTemplate[]): MessageTemplate[] => templates.filter((template) => template.purpose === "service" && template.status === "active")

/** Each notice's pick, read off the project's rules. */
export const noticePicksOf = (rules: NotificationRules): Record<CustomerNoticeEvent, string> =>
  Object.fromEntries(CUSTOMER_NOTICES.map(({ event }) => [event, rules.rules.find((rule) => rule.event === event)?.templateId ?? NOT_SENT])) as Record<CustomerNoticeEvent, string>

/** The body the picks send: each notice with a template, in the vocabulary's order. */
export const noticeRulesBody = (picks: Readonly<Record<CustomerNoticeEvent, string>>): NotificationRulesPut => ({
  rules: CUSTOMER_NOTICES.flatMap(({ event }) => (picks[event] === NOT_SENT ? [] : [{ event, templateId: picks[event] }])),
})
