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
import { EVERY_MESSAGE_FILLS, MESSAGE_VARIABLES, placeholdersOf, type MessageVariable } from "../messaging/template"
import { addDays } from "../route-schemes/recurrence"
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

/** What an outbox event says that decides its notice: the stop's booking, where a stop's event; the rule that raised it, where an alert's. */
export type NoticeFacts = { bulkyBookingId?: string | null; alertRule?: string | null }

/**
 * The customer notice an outbox event is, or null: a booking booked or
 * cancelled, its stop's completion or failure where the stop is a Bulky
 * Booking's (O16 of #290, part b); a reply the customer may read and a ticket
 * completed, a route cancelled, and a route late — the alert rules' alert of
 * a route not started (C18 of #291).
 */
export function customerNoticeOf(kind: OutboxKind, facts: NoticeFacts = {}): CustomerNoticeEvent | null {
  switch (kind) {
    case "bulky-booking-booked":
    case "bulky-booking-cancelled":
    case "ticket-replied":
    case "ticket-completed":
    case "route-cancelled":
      return kind
    case "pickup-completed":
      return facts.bulkyBookingId == null ? null : "bulky-booking-collected"
    case "pickup-failed":
      return facts.bulkyBookingId == null ? null : "bulky-booking-not-collected"
    case "alert-raised":
      return facts.alertRule === "route-not-started" ? "route-late" : null
    default:
      return null
  }
}

/** The values each notice fills beyond the three every message does: a template naming another is refused for it, at the rule and at the send. */
export const NOTICE_VALUES: Readonly<Record<CustomerNoticeEvent, readonly MessageVariable[]>> = {
  "bulky-booking-booked": ["collectionDate"],
  "bulky-booking-cancelled": ["collectionDate"],
  "bulky-booking-collected": ["collectionDate"],
  "bulky-booking-not-collected": ["collectionDate"],
  "collection-reminder": ["collectionDate"],
  "ticket-replied": ["ticketNumber", "replyText"],
  "ticket-completed": ["ticketNumber"],
  "route-cancelled": ["collectionDate"],
  "route-late": ["collectionDate"],
}

/** The placeholders of a template's text a notice does not fill: what a rule mapping the notice to it is refused for. */
export function unfilledByNotice(notice: CustomerNoticeEvent, text: string): string[] {
  const filled = new Set<string>([...EVERY_MESSAGE_FILLS, ...NOTICE_VALUES[notice]])
  return placeholdersOf(text).filter((name) => (MESSAGE_VARIABLES as readonly string[]).includes(name) && !filled.has(name))
}

/** The hour on a project's clock from which the next day's collection reminders are sent (C18 of #291). */
export const REMINDER_HOUR = 14

/**
 * The bound on one run of the reminders, per project: at most this many
 * customers queued in one hourly pass, so a large project spreads its
 * reminders over the afternoon rather than flooding the delivery log and the
 * send queue at once (the coordinator's guard on #380).
 */
export const REMINDER_BATCH = 200

/**
 * The bound on a project's reminders of one day: the hourly runs from
 * `REMINDER_HOUR` to midnight take `REMINDER_BATCH` each, ten of them, so the
 * cap is what they can reach; a customer beyond it is counted and logged,
 * never reminded.
 */
export const REMINDER_DAILY_CAP = REMINDER_BATCH * (24 - REMINDER_HOUR)

/**
 * The day a project's reminders are for, at this instant on its clock: the
 * next day, once the clock has passed `REMINDER_HOUR`; null before it. Pure:
 * the wall clock is the caller's, `YYYY-MM-DD` and the hour.
 */
export function reminderDayAt(today: string, hour: number): string | null {
  return hour >= REMINDER_HOUR ? addDays(today, 1) : null
}
