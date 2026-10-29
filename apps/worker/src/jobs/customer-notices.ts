// The customer notices (O16 of #290, part b): the outbox's fourth consumer,
// on a Bulky Booking's own two kinds — `bulky-booking-booked` and
// `bulky-booking-cancelled`, which the API writes as it books and cancels —
// and on a stop's `pickup-completed` and `pickup-failed`, which are the
// booking's collection and its miss where the stop collects one
// (`customerNoticeOf`, @waste/domain/notifications/notices). A project sends
// a notice only where one of its notification rules maps it to a template
// (`PUT /projects/:id/notification-rules`): the rule is the opt-in and there
// is no default text. The template is queued to the booking's customer
// through `queueMessage` (@waste/db/commands/messaging), with the booking's
// day as `{{collectionDate}}`, and the send judges the customer's consent.
//
// A notice that cannot be sent — the template made inactive since the rule
// was written, a customer with no address on its channel — is a `Refused`,
// which no retry would change: it is logged and the job completes, the event
// told to nobody. Anything else fails the job for pg-boss's retries.
//
// pg-boss delivers at least once; the event's id and the customer key each
// notice once (`message_source_event_id_customer_id_idx`), so a redelivery
// answers the message queued the first time and writes nothing. Every read and
// write is `wms_api`'s under `withCompany` on the event's company.
import { BulkyBooking } from "@waste/contracts/bulky"
import { Pickup } from "@waste/contracts/pickups"
import { queueMessage } from "@waste/db/commands/messaging"
import { Refused } from "@waste/db/commands/shared"
import { newId } from "@waste/db/ids"
import { bulkyBooking } from "@waste/db/schema/bulky"
import { notificationRule } from "@waste/db/schema/notifications"
import { withCompany } from "@waste/db/tenant"
import type { OutboxKind } from "@waste/domain/execution/vocabulary"
import { customerNoticeOf } from "@waste/domain/notifications/notices"
import type { CustomerNoticeEvent } from "@waste/domain/notifications/vocabulary"
import { and, eq } from "drizzle-orm"

import { defineOutboxConsumer, type RelayedEvent } from "../outbox/subscribe"
import type { JobContext } from "./definition"

/** The kinds this consumer takes, one queue each: the booking's two, then its stop's completion and failure. */
export const CUSTOMER_NOTICE_KINDS = ["bulky-booking-booked", "bulky-booking-cancelled", "pickup-completed", "pickup-failed"] as const satisfies readonly OutboxKind[]

/** What one event came to: the notice it is, and the message queued for it, or why none was. */
export type Noticed = { event: string; kind: OutboxKind; notice: CustomerNoticeEvent | null; messageId: string | null; why: string | null }

/** The booking an event is about: the booking's own events name it, a stop's names it where the stop collects one. */
const bookingIdOf = (event: RelayedEvent<(typeof CUSTOMER_NOTICE_KINDS)[number]>): string | null =>
  event.kind === "bulky-booking-booked" || event.kind === "bulky-booking-cancelled" ? BulkyBooking.parse(event.payload).id : Pickup.parse(event.payload).bulkyBookingId

/** One event to the notice it owes, queued in one fenced transaction as the tenant. */
export async function noticeCustomerFor(event: RelayedEvent<(typeof CUSTOMER_NOTICE_KINDS)[number]>, { api, send, log }: Pick<JobContext, "api" | "send" | "log">): Promise<Noticed> {
  const bookingId = bookingIdOf(event)
  const notice = customerNoticeOf(event.kind, { bulkyBookingId: bookingId })
  const nothing = (why: string | null): Noticed => ({ event: event.id, kind: event.kind, notice, messageId: null, why })
  if (notice === null || bookingId === null) return nothing(null)
  const outcome = await withCompany(api.db, event.companyId, async (tx): Promise<Noticed> => {
    const [rule] = await tx
      .select({ templateId: notificationRule.templateId })
      .from(notificationRule)
      .where(and(eq(notificationRule.companyId, event.companyId), eq(notificationRule.projectId, event.projectId), eq(notificationRule.event, notice)))
      .limit(1)
    if (rule === undefined) return nothing(null)
    const [booking] = await tx
      .select({ customerId: bulkyBooking.customerId, day: bulkyBooking.day })
      .from(bulkyBooking)
      .where(and(eq(bulkyBooking.companyId, event.companyId), eq(bulkyBooking.id, bookingId)))
      .limit(1)
    if (booking === undefined) throw new Error(`${event.kind} ${event.id} names bulky booking ${bookingId}, which is not in company ${event.companyId}`)
    try {
      // In a savepoint, so a refusal leaves the transaction whole.
      const queued = await tx.transaction((savepoint) =>
        queueMessage(savepoint, send, { id: newId(), companyId: event.companyId, templateId: rule.templateId, customerId: booking.customerId, contactId: null, sourceEventId: event.id, values: { collectionDate: booking.day } }),
      )
      return { event: event.id, kind: event.kind, notice, messageId: queued.id, why: null }
    } catch (error) {
      if (error instanceof Refused) return nothing(error.message)
      throw error
    }
  })
  if (outcome.messageId !== null) log(`customer-notices: ${event.kind} ${event.id} → ${notice} queued as message ${outcome.messageId}`)
  else if (outcome.why !== null) log(`customer-notices: ${event.kind} ${event.id} → ${notice} not sent: ${outcome.why}`)
  return outcome
}

/** The four registry entries, one per kind; spread into `OUTBOX_CONSUMERS`. */
export const noticeCustomers = defineOutboxConsumer({
  name: "customer-notices",
  kinds: CUSTOMER_NOTICE_KINDS,
  description: "Sends a Bulky Booking's customer the project's notice where a notification rule names one: the booking booked or cancelled, and its stop completed or failed; once per event however often it is delivered.",
  handler: (event, context) => noticeCustomerFor(event, context),
})
