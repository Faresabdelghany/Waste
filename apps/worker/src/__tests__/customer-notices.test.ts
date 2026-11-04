// The customer notices (O16 of #290, part b), on the shared local database
// with a tenant of this file's own: a project's rule sends its template to
// the booking's customer when the booking is booked, cancelled, collected or
// not collected, with the booking's day as {{collectionDate}}; a notice no
// rule names, and a stop that collects no booking, send nothing; a redelivery
// queues nothing twice; and a notice that cannot be sent is logged, not
// retried.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import type { Database } from "@waste/db/client"
import { createDb } from "@waste/db/client"
import { SEND_MESSAGE_QUEUE } from "@waste/db/commands/messaging"
import type { Send } from "@waste/db/jobs"
import { customer } from "@waste/db/schema/customers"
import { message, messageTemplate } from "@waste/db/schema/messaging"
import { notificationRule } from "@waste/db/schema/notifications"
import { withCompany } from "@waste/db/tenant"
import type { OutboxKind } from "@waste/domain/execution/vocabulary"
import type { CustomerNoticeEvent } from "@waste/domain/notifications/vocabulary"
import { and, eq } from "drizzle-orm"

import { CUSTOMER_NOTICE_KINDS, noticeCustomerFor } from "../jobs/customer-notices"
import type { JobContext } from "../jobs/definition"
import type { RelayedEvent } from "../outbox/subscribe"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { at, dropFinanceTenant, FIXTURE_DAY, seedBulkyBooking, seedFinanceTenant, testId, type FinanceTenant } from "./finance-tenant"

const api = databaseUnderTest()
const owner = ownerUnderTest()
const NOON = at(FIXTURE_DAY, "12:00")

describe("the customer notices", { skip: api.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let tenant: FinanceTenant
  const lines: string[] = []
  const sent: Array<{ name: string; data: unknown }> = []
  const send: Send = async (name, data) => {
    sent.push({ name, data })
    return testId()
  }
  const context = () => ({ api: pool, send, now: () => NOON, log: (line: string) => void lines.push(line) }) as unknown as JobContext
  const templates = { booked: testId(), collected: testId() }
  let booking: { id: string }

  before(async () => {
    pool = createDb(api.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    tenant = await seedFinanceTenant(pool)
    booking = await seedBulkyBooking(pool, tenant, { agreementId: tenant.agreements.housing.id, customerId: tenant.customers.housing.id, propertyId: tenant.properties.havnegade.id })
    const projectId = tenant.projects.copenhagen.id
    const { companyId } = tenant
    await withCompany(pool.db, companyId, async (tx) => {
      await tx.update(customer).set({ email: "kontor@housing.example", phone: "+45 20 30 40 50", serviceMessagesAllowed: true }).where(eq(customer.id, tenant.customers.housing.id))
      await tx.insert(messageTemplate).values([
        { id: templates.booked, companyId, projectId, name: "Bulky booked", purpose: "service", channel: "email", subject: "Booked for {{collectionDate}}", body: "Dear {{recipientName}}, we come on {{collectionDate}}.", status: "active" },
        { id: templates.collected, companyId, projectId, name: "Bulky collected", purpose: "service", channel: "sms", subject: null, body: "{{recipientName}}: collected on {{collectionDate}}.", status: "active" },
      ])
      await tx.insert(notificationRule).values([
        { companyId, projectId, event: "bulky-booking-booked", templateId: templates.booked },
        { companyId, projectId, event: "bulky-booking-cancelled", templateId: templates.booked },
        { companyId, projectId, event: "bulky-booking-collected", templateId: templates.collected },
      ])
    })
  })
  after(async () => {
    if (tenant !== undefined) await dropFinanceTenant(pool, ownerPool, tenant.companyId)
    await pool?.close()
    await ownerPool?.close()
  })

  const event = <Kind extends (typeof CUSTOMER_NOTICE_KINDS)[number]>(kind: Kind, payload: unknown): RelayedEvent<Kind> => ({
    id: testId(),
    companyId: tenant.companyId,
    projectId: tenant.projects.copenhagen.id,
    kind,
    aggregateKind: kind.startsWith("pickup") ? "pickup" : "bulky-booking",
    aggregateId: testId(),
    occurredAt: NOON.toISOString(),
    payload: payload as RelayedEvent["payload"],
    publishedAt: null,
    createdAt: NOON.toISOString(),
    updatedAt: NOON.toISOString(),
  })
  /** The booking's payload, enough of `BulkyBooking` for the consumer, which reads its id and the rest from the table. */
  const bookingPayload = () => ({
    id: booking.id,
    createdAt: NOON.toISOString(),
    updatedAt: NOON.toISOString(),
    projectId: tenant.projects.copenhagen.id,
    customerId: tenant.customers.housing.id,
    agreementId: tenant.agreements.housing.id,
    propertyId: tenant.properties.havnegade.id,
    sharedCollectionPointId: null,
    wasteFractionId: tenant.fractions.residual.id,
    day: FIXTURE_DAY,
    items: [{ description: "Sofa", quantity: 1 }],
    note: null,
    status: "booked",
    planningAreaId: tenant.planningAreas.centrum.id,
    scheduleId: testId(),
    productId: tenant.products.bulky.id,
    stop: null,
    bookedBy: null,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
  })
  /** A stop's payload, enough of `Pickup` for the consumer, which reads the booking it names. */
  const stopPayload = (status: "completed" | "failed", bulkyBookingId: string | null) => ({
    id: testId(),
    createdAt: NOON.toISOString(),
    updatedAt: NOON.toISOString(),
    projectId: tenant.projects.copenhagen.id,
    routeId: testId(),
    containerId: null,
    position: 1,
    status,
    reason: status === "completed" ? null : "not-presented",
    note: null,
    propertyId: tenant.properties.havnegade.id,
    sharedCollectionPointId: null,
    wasteFractionId: tenant.fractions.residual.id,
    arrivedAt: NOON.toISOString(),
    outcomeAt: NOON.toISOString(),
    origin: "office",
    service: "bulky",
    bulkyBookingId,
  })
  const read = async (id: string | null) => {
    assert.ok(id !== null, "a message was queued")
    const [row] = await withCompany(pool.db, tenant.companyId, (tx) => tx.select().from(message).where(eq(message.id, id)))
    return row
  }

  test("a booking booked is sent the project's template, its day filled in, with the send's job beside it", async () => {
    const before = sent.length
    const booked = event("bulky-booking-booked", bookingPayload())
    const outcome = await noticeCustomerFor(booked, context())
    assert.equal(outcome.notice, "bulky-booking-booked")
    const row = await read(outcome.messageId)
    assert.deepEqual([row.templateId, row.customerId, row.sourceEventId, row.recipient, row.subject, row.purpose, row.status], [templates.booked, tenant.customers.housing.id, booked.id, "kontor@housing.example", `Booked for ${FIXTURE_DAY}`, "service", "queued"])
    assert.match(row.body, new RegExp(`^Dear .+, we come on ${FIXTURE_DAY}\\.$`))
    assert.deepEqual(sent.slice(before), [{ name: SEND_MESSAGE_QUEUE, data: { companyId: tenant.companyId, messageId: row.id } }])

    const again = await noticeCustomerFor(booked, context())
    assert.equal(again.messageId, row.id, "a redelivery answers the message queued the first time")
    assert.equal(sent.length, before + 1, "and sends nothing")
    const rows = await withCompany(pool.db, tenant.companyId, (tx) => tx.select({ id: message.id }).from(message).where(and(eq(message.companyId, tenant.companyId), eq(message.sourceEventId, booked.id))))
    assert.equal(rows.length, 1)
  })

  test("its stop completed is its collection, and a stop that collects no booking is no notice", async () => {
    const collected = await noticeCustomerFor(event("pickup-completed", stopPayload("completed", booking.id)), context())
    assert.equal(collected.notice, "bulky-booking-collected")
    assert.equal((await read(collected.messageId)).body.endsWith(`collected on ${FIXTURE_DAY}.`), true)
    const emptying = await noticeCustomerFor(event("pickup-completed", stopPayload("completed", null)), context())
    assert.deepEqual([emptying.notice, emptying.messageId], [null, null])
  })

  test("a notice no rule names sends nothing: the project did not opt in", async () => {
    const missed = await noticeCustomerFor(event("pickup-failed", stopPayload("failed", booking.id)), context())
    assert.deepEqual([missed.notice, missed.messageId, missed.why], ["bulky-booking-not-collected" satisfies CustomerNoticeEvent, null, null])
  })

  test("a notice that cannot be sent is logged and the job completes: the template made inactive since", async () => {
    await withCompany(pool.db, tenant.companyId, (tx) => tx.update(messageTemplate).set({ status: "inactive" }).where(eq(messageTemplate.id, templates.booked)))
    try {
      lines.length = 0
      const cancelled = await noticeCustomerFor(event("bulky-booking-cancelled", { ...bookingPayload(), status: "cancelled" }), context())
      assert.deepEqual([cancelled.notice, cancelled.messageId], ["bulky-booking-cancelled", null])
      assert.match(cancelled.why ?? "", /The template Bulky booked is inactive/)
      assert.match(lines.join("\n"), /bulky-booking-cancelled not sent: The template Bulky booked is inactive/)
    } finally {
      await withCompany(pool.db, tenant.companyId, (tx) => tx.update(messageTemplate).set({ status: "active" }).where(eq(messageTemplate.id, templates.booked)))
    }
  })

  test("takes the four kinds, one queue each", () => {
    assert.deepEqual([...CUSTOMER_NOTICE_KINDS] satisfies OutboxKind[], ["bulky-booking-booked", "bulky-booking-cancelled", "pickup-completed", "pickup-failed"])
  })
})
