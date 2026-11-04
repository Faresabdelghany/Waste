// What a staff member is told (O16 of #290), pure: whether an alert reaches
// the severity a person picked, and the e-mail an alert raised or a ticket
// assigned becomes. A staff notice is rendered here, from the event, never
// from a customer's message template; the worker's notifications consumer
// queues it through @waste/db's `queueStaffMessage` to each person who opted
// in. A ticket's number reads as the API spells it, `T-<number>`.
//
// A customer's notice (part b) is the project's own template, never a text of
// the platform's: here is only which notice an outbox event is, the booking's
// own two kinds, and its stop's completion or failure where the stop
// collects a Bulky Booking.
import type { OutboxKind } from "../execution/vocabulary"
import type { AlertSeverity, TicketPriority } from "../resolution/vocabulary"
import type { CustomerNoticeEvent } from "./vocabulary"
import { ALERT_SEVERITIES } from "../resolution/vocabulary"

/** Whether an alert of `severity` reaches a person's `threshold`: the tuple runs from critical down to low. */
export const severityReaches = (severity: AlertSeverity, threshold: AlertSeverity): boolean => ALERT_SEVERITIES.indexOf(severity) <= ALERT_SEVERITIES.indexOf(threshold)

/** One e-mail to one person: its subject and its plain-text body. */
export type Notice = { subject: string; body: string }

const capitalised = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)
const signed = (companyName: string) => `— ${companyName}`

/** An alert raised, as its e-mail reads. */
export function alertNotice(alert: { severity: AlertSeverity; title: string; details: string; detectedAt: string }, where: { projectName: string; companyName: string }): Notice {
  return {
    subject: `${capitalised(alert.severity)} alert · ${alert.title}`,
    body: [`A ${alert.severity} alert was raised in ${where.projectName}.`, "", alert.title, alert.details, "", `Detected ${alert.detectedAt}.`, "", signed(where.companyName)].join("\n"),
  }
}

/** A ticket assigned to its new assignee, as its e-mail reads. */
export function ticketAssignedNotice(ticket: { number: number; subject: string; priority: TicketPriority; dueAt: string | null }, where: { projectName: string; companyName: string; recipientName: string }): Notice {
  const label = `T-${ticket.number}`
  return {
    subject: `Ticket ${label} assigned to you · ${ticket.subject}`,
    body: [
      `${where.recipientName}, ticket ${label} in ${where.projectName} is now yours.`,
      "",
      ticket.subject,
      `Priority: ${ticket.priority}.`,
      ...(ticket.dueAt === null ? [] : [`Due ${ticket.dueAt}.`]),
      "",
      signed(where.companyName),
    ].join("\n"),
  }
}

/** The customer notice an outbox event is, or null: a booking booked or cancelled, and its stop's completion or failure where the stop is a Bulky Booking's. */
export function customerNoticeOf(kind: OutboxKind, stop: { bulkyBookingId: string | null } | null): CustomerNoticeEvent | null {
  if (kind === "bulky-booking-booked" || kind === "bulky-booking-cancelled") return kind
  if (stop === null || stop.bulkyBookingId === null) return null
  if (kind === "pickup-completed") return "bulky-booking-collected"
  if (kind === "pickup-failed") return "bulky-booking-not-collected"
  return null
}
