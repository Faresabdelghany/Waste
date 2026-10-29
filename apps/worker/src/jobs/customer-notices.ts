// The customer notices (O16 of #290, part b; C18 of #291): the outbox's
// fourth consumer. On a Bulky Booking's own two kinds —
// `bulky-booking-booked` and `bulky-booking-cancelled`, which the API writes
// as it books and cancels — and on a stop's `pickup-completed` and
// `pickup-failed`, which are the booking's collection and its miss where the
// stop collects one; on a ticket's `ticket-replied`, the office's reply to the
// customer, and `ticket-completed`; and on the two broadcasts, a route's
// `route-cancelled` and the `alert-raised` of the `route-not-started` rule,
// which is the route running late (`customerNoticeOf`,
// @waste/domain/notifications/notices). A project sends a notice only where
// one of its notification rules maps it to a template (`PUT
// /projects/:id/notification-rules`): the rule is the opt-in and there is no
// default text.
//
// The recipients are the booking's customer, the ticket's customer (a ticket
// naming none tells nobody), or for a broadcast the customers the route's
// owed stops serve (`customersOfRoute`, @waste/db/query/stop-customers), in
// the notification areas the rule names or the whole project where it names
// none. A route generation cancelled is no news: its collections moved to the
// scheme's new routes. The template is queued to each through `queueMessage`
// (@waste/db/commands/messaging), with the values its notice fills
// (`NOTICE_VALUES`): the booking's day or the route's operating date as
// `{{collectionDate}}`, the ticket's label as `{{ticketNumber}}` and the
// reply's words as `{{replyText}}`; the send judges the customer's consent.
//
// A notice that cannot be sent to a customer — the template made inactive
// since the rule was written, a customer with no address on its channel — is
// a `Refused`, which no retry would change: it is logged, the other customers
// are still told, and the job completes. Anything else fails the job for
// pg-boss's retries.
//
// pg-boss delivers at least once; the event's id and the customer key each
// notice once (`message_source_event_id_customer_id_idx`), so a redelivery
// answers the messages queued the first time and writes nothing. Every read
// and write is `wms_api`'s under `withCompany` on the event's company.
import { Alert } from "@waste/contracts/alerts"
import { BulkyBooking } from "@waste/contracts/bulky"
import { Pickup } from "@waste/contracts/pickups"
import { ticketLabel } from "@waste/contracts/resolution"
import { routeFields } from "@waste/contracts/routes"
import { Ticket, TicketEvent } from "@waste/contracts/tickets"
import type { Tx } from "@waste/db/client"
import { queueMessage } from "@waste/db/commands/messaging"
import { Refused } from "@waste/db/commands/shared"
import { newId } from "@waste/db/ids"
import { customersOfRoute } from "@waste/db/query/stop-customers"
import { bulkyBooking } from "@waste/db/schema/bulky"
import { route } from "@waste/db/schema/execution"
import { notificationRule, notificationRuleArea } from "@waste/db/schema/notifications"
import { ticket } from "@waste/db/schema/resolution"
import { withCompany } from "@waste/db/tenant"
import type { OutboxKind } from "@waste/domain/execution/vocabulary"
import type { MessageVariable } from "@waste/domain/messaging/template"
import { customerNoticeOf } from "@waste/domain/notifications/notices"
import type { CustomerNoticeEvent } from "@waste/domain/notifications/vocabulary"
import { and, eq } from "drizzle-orm"
import * as z from "zod"

import { defineOutboxConsumer, type RelayedEvent } from "../outbox/subscribe"
import type { JobContext } from "./definition"

/** The kinds this consumer takes, one queue each: the booking's two, its stop's completion and failure, the ticket's reply and completion, and the route's cancel and a rule's alert. */
export const CUSTOMER_NOTICE_KINDS = [
  "bulky-booking-booked",
  "bulky-booking-cancelled",
  "pickup-completed",
  "pickup-failed",
  "ticket-replied",
  "ticket-completed",
  "route-cancelled",
  "alert-raised",
] as const satisfies readonly OutboxKind[]

type NoticeKind = (typeof CUSTOMER_NOTICE_KINDS)[number]

/** What a broadcast reads of a cancelled route: its id, its day and why; a payload from before the reason codes reads as none. */
const CancelledRoute = z.object({ id: routeFields.id, operatingDate: routeFields.operatingDate, cancelReasonCode: routeFields.cancelReasonCode.default(null) })

/** What one event came to: the notice it is, the messages queued for it, and why any customer was not told. */
export type Noticed = { event: string; kind: OutboxKind; notice: CustomerNoticeEvent | null; messageIds: string[]; why: string[] }

/** Who a notice goes to and what it fills in. */
type Recipients = { customerIds: readonly string[]; values: Partial<Record<MessageVariable, string>> }

/** The facts `customerNoticeOf` reads off the payload: the booking a stop collects, the rule an alert is of. */
function factsOf(event: RelayedEvent<NoticeKind>): { bulkyBookingId?: string | null; alertRule?: string | null } {
  switch (event.kind) {
    case "pickup-completed":
    case "pickup-failed":
      return { bulkyBookingId: Pickup.parse(event.payload).bulkyBookingId }
    case "alert-raised":
      return { alertRule: Alert.parse(event.payload).rule }
    default:
      return {}
  }
}

/** The customers a broadcast about a route reaches, with its day: within the rule's areas, or the whole project. */
async function routeRecipients(tx: Tx, event: RelayedEvent<NoticeKind>, ruleId: string, routeId: string, operatingDate: string): Promise<Recipients> {
  const areas = await tx
    .select({ id: notificationRuleArea.planningAreaId })
    .from(notificationRuleArea)
    .where(and(eq(notificationRuleArea.companyId, event.companyId), eq(notificationRuleArea.ruleId, ruleId)))
  const customerIds = await customersOfRoute(tx, { companyId: event.companyId, projectId: event.projectId }, routeId, areas.map((area) => area.id))
  return { customerIds, values: { collectionDate: operatingDate } }
}

/** Who the event's notice goes to, read in the event's transaction. */
async function recipientsOf(tx: Tx, event: RelayedEvent<NoticeKind>, ruleId: string): Promise<Recipients> {
  switch (event.kind) {
    case "bulky-booking-booked":
    case "bulky-booking-cancelled":
    case "pickup-completed":
    case "pickup-failed": {
      const bookingId = event.kind === "bulky-booking-booked" || event.kind === "bulky-booking-cancelled" ? BulkyBooking.parse(event.payload).id : Pickup.parse(event.payload).bulkyBookingId
      if (bookingId === null) return { customerIds: [], values: {} }
      const [booking] = await tx
        .select({ customerId: bulkyBooking.customerId, day: bulkyBooking.day })
        .from(bulkyBooking)
        .where(and(eq(bulkyBooking.companyId, event.companyId), eq(bulkyBooking.id, bookingId)))
        .limit(1)
      if (booking === undefined) throw new Error(`${event.kind} ${event.id} names bulky booking ${bookingId}, which is not in company ${event.companyId}`)
      return { customerIds: [booking.customerId], values: { collectionDate: booking.day } }
    }
    case "ticket-replied": {
      const reply = TicketEvent.parse(event.payload)
      const [row] = await tx
        .select({ customerId: ticket.customerId, number: ticket.number })
        .from(ticket)
        .where(and(eq(ticket.companyId, event.companyId), eq(ticket.id, reply.ticketId)))
        .limit(1)
      if (row === undefined) throw new Error(`${event.kind} ${event.id} names ticket ${reply.ticketId}, which is not in company ${event.companyId}`)
      return { customerIds: row.customerId === null ? [] : [row.customerId], values: { ticketNumber: ticketLabel(row.number), replyText: reply.body ?? "" } }
    }
    case "ticket-completed": {
      const done = Ticket.parse(event.payload)
      return { customerIds: done.links.customerId === null ? [] : [done.links.customerId], values: { ticketNumber: done.label } }
    }
    case "route-cancelled": {
      const cancelled = CancelledRoute.parse(event.payload)
      if (cancelled.cancelReasonCode === "regeneration") return { customerIds: [], values: {} }
      return await routeRecipients(tx, event, ruleId, cancelled.id, cancelled.operatingDate)
    }
    case "alert-raised": {
      const routeId = Alert.parse(event.payload).routeId
      if (routeId === null) return { customerIds: [], values: {} }
      const [late] = await tx
        .select({ operatingDate: route.operatingDate })
        .from(route)
        .where(and(eq(route.companyId, event.companyId), eq(route.id, routeId)))
        .limit(1)
      if (late === undefined) throw new Error(`${event.kind} ${event.id} names route ${routeId}, which is not in company ${event.companyId}`)
      return await routeRecipients(tx, event, ruleId, routeId, late.operatingDate)
    }
  }
}

/** One event to the notices it owes, queued in one fenced transaction as the tenant, each customer in a savepoint of its own. */
export async function noticeCustomerFor(event: RelayedEvent<NoticeKind>, { api, send, log }: Pick<JobContext, "api" | "send" | "log">): Promise<Noticed> {
  const notice = customerNoticeOf(event.kind, factsOf(event))
  const outcome: Noticed = { event: event.id, kind: event.kind, notice, messageIds: [], why: [] }
  if (notice === null) return outcome
  await withCompany(api.db, event.companyId, async (tx) => {
    const [rule] = await tx
      .select({ id: notificationRule.id, templateId: notificationRule.templateId })
      .from(notificationRule)
      .where(and(eq(notificationRule.companyId, event.companyId), eq(notificationRule.projectId, event.projectId), eq(notificationRule.event, notice)))
      .limit(1)
    if (rule === undefined) return
    const { customerIds, values } = await recipientsOf(tx, event, rule.id)
    for (const customerId of customerIds) {
      try {
        // In a savepoint, so a refusal leaves the transaction whole.
        const queued = await tx.transaction((savepoint) =>
          queueMessage(savepoint, send, { id: newId(), companyId: event.companyId, templateId: rule.templateId, customerId, contactId: null, sourceEventId: event.id, values }),
        )
        outcome.messageIds.push(queued.id)
      } catch (error) {
        if (!(error instanceof Refused)) throw error
        outcome.why.push(error.message)
      }
    }
  })
  if (outcome.messageIds.length > 0) log(`customer-notices: ${event.kind} ${event.id} → ${notice} queued as ${outcome.messageIds.length === 1 ? `message ${outcome.messageIds[0]}` : `${outcome.messageIds.length} messages`}`)
  for (const why of outcome.why) log(`customer-notices: ${event.kind} ${event.id} → ${notice} not sent: ${why}`)
  return outcome
}

/** The registry entries, one per kind; spread into `OUTBOX_CONSUMERS`. */
export const noticeCustomers = defineOutboxConsumer({
  name: "customer-notices",
  kinds: CUSTOMER_NOTICE_KINDS,
  description:
    "Sends the project's customer notice where a notification rule names one: a Bulky Booking's customer its booking booked or cancelled and its stop completed or failed; a ticket's customer the office's reply and its completion; the customers a route's stops serve, within the rule's areas, its cancel and its running late; once per event and customer however often it is delivered.",
  handler: (event, context) => noticeCustomerFor(event, context),
})
