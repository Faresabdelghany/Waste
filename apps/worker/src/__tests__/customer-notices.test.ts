// The customer notices (O16 of #290, part b; C18 of #291), on the shared
// local database with a tenant of this file's own: a project's rule sends its
// template to the booking's customer when the booking is booked, cancelled,
// collected or not collected, with the booking's day as {{collectionDate}}; a
// notice no rule names, and a stop that collects no booking, send nothing; a
// redelivery queues nothing twice; and a notice that cannot be sent is
// logged, not retried. A ticket's reply and completion go to its customer
// with its label and the reply's words; a route cancelled or running late
// goes to the customers its owed stops serve, within the rule's areas.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import type { Database } from "@waste/db/client"
import { createDb } from "@waste/db/client"
import { SEND_MESSAGE_QUEUE } from "@waste/db/commands/messaging"
import type { Send } from "@waste/db/jobs"
import { alertColumns, alertOf, eventColumns, eventOf, ticketColumns, ticketOf } from "@waste/db/commands/resolution-rows"
import { customer, property } from "@waste/db/schema/customers"
import { route } from "@waste/db/schema/execution"
import { message, messageTemplate } from "@waste/db/schema/messaging"
import { notificationRule, notificationRuleArea } from "@waste/db/schema/notifications"
import { planningArea, planningAreaBoundary } from "@waste/db/schema/planning-areas"
import { alert, ticket, ticketEvent } from "@waste/db/schema/resolution"
import { withCompany } from "@waste/db/tenant"
import type { OutboxKind } from "@waste/domain/execution/vocabulary"
import type { CustomerNoticeEvent } from "@waste/domain/notifications/vocabulary"
import { alertOfRule } from "@waste/domain/resolution/alert-rules"
import { and, eq, sql } from "drizzle-orm"

import { CUSTOMER_NOTICE_KINDS, noticeCustomerFor } from "../jobs/customer-notices"
import type { JobContext } from "../jobs/definition"
import type { RelayedEvent } from "../outbox/subscribe"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { at, dropFinanceTenant, FIXTURE_DAY, placeBin, seedBulkyBooking, seedCompletedRoute, seedFinanceTenant, testId, type FinanceTenant, type PlacedBin, type SeededRoute } from "./finance-tenant"

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
  const templates = { booked: testId(), collected: testId(), replied: testId(), completed: testId(), broadcast: testId() }
  const rules = { replied: testId(), completed: testId(), cancelled: testId(), late: testId() }
  const north = testId()
  let booking: { id: string }
  let housingBin: PlacedBin
  let annaBin: PlacedBin
  let planned: SeededRoute

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

    // C18: two bins on one planned route, the housing association's inside the notification area north and Anna's outside it.
    housingBin = await placeBin(pool, tenant, "N-1", { agreementId: tenant.agreements.housing.id, productId: tenant.products.residual.id })
    annaBin = await placeBin(pool, tenant, "S-1", { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id })
    planned = await seedCompletedRoute(pool, tenant, [
      { containerId: housingBin.containerId, propertyId: housingBin.propertyId, status: "planned" },
      { containerId: annaBin.containerId, propertyId: annaBin.propertyId, status: "planned" },
    ])
    await withCompany(pool.db, companyId, async (tx) => {
      await tx
        .update(route)
        .set({ status: "planned", plannedStartTime: "06:00", dispatchedAt: null, startedAt: null, completedAt: null, actualVehicleId: null, actualDriverId: null })
        .where(eq(route.id, planned.id))
      const point = (lng: number, lat: number) => sql`extensions.st_setsrid(extensions.st_makepoint(${lng}::float8, ${lat}::float8), 4326)`
      await tx.update(property).set({ location: point(12.57, 55.7) } as never).where(eq(property.id, housingBin.propertyId))
      await tx.update(property).set({ location: point(12.57, 55.6) } as never).where(eq(property.id, annaBin.propertyId))
      await tx.update(customer).set({ email: "anna@anna.example", serviceMessagesAllowed: true }).where(eq(customer.id, tenant.customers.anna.id))
      await tx.insert(planningArea).values({ id: north, companyId, projectId, code: "NOTE-N", name: "North", purpose: "notification" })
      await tx.execute(sql`
        insert into ${planningAreaBoundary} (id, company_id, project_id, planning_area_id, valid_from, boundary)
        values (${testId()}, ${companyId}, ${projectId}, ${north}, '2026-01-01', extensions.st_geomfromtext('POLYGON((12.5 55.65, 12.65 55.65, 12.65 55.75, 12.5 55.75, 12.5 55.65))', 4326))
      `)
      await tx.insert(messageTemplate).values([
        { id: templates.replied, companyId, projectId, name: "Ticket reply", purpose: "service", channel: "email", subject: "About {{ticketNumber}}", body: "{{replyText}}", status: "active" },
        { id: templates.completed, companyId, projectId, name: "Ticket done", purpose: "service", channel: "email", subject: "Closed", body: "{{ticketNumber}} is closed.", status: "active" },
        { id: templates.broadcast, companyId, projectId, name: "Collection news", purpose: "service", channel: "email", subject: "Your collection", body: "About your collection on {{collectionDate}}.", status: "active" },
      ])
      await tx.insert(notificationRule).values([
        { id: rules.replied, companyId, projectId, event: "ticket-replied", templateId: templates.replied },
        { id: rules.completed, companyId, projectId, event: "ticket-completed", templateId: templates.completed },
        { id: rules.cancelled, companyId, projectId, event: "route-cancelled", templateId: templates.broadcast },
        { id: rules.late, companyId, projectId, event: "route-late", templateId: templates.broadcast },
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
    const row = await read(outcome.messageIds[0])
    assert.deepEqual([row.templateId, row.customerId, row.sourceEventId, row.recipient, row.subject, row.purpose, row.status], [templates.booked, tenant.customers.housing.id, booked.id, "kontor@housing.example", `Booked for ${FIXTURE_DAY}`, "service", "queued"])
    assert.match(row.body, new RegExp(`^Dear .+, we come on ${FIXTURE_DAY}\\.$`))
    assert.deepEqual(sent.slice(before), [{ name: SEND_MESSAGE_QUEUE, data: { companyId: tenant.companyId, messageId: row.id } }])

    const again = await noticeCustomerFor(booked, context())
    assert.deepEqual(again.messageIds, [row.id], "a redelivery answers the message queued the first time")
    assert.equal(sent.length, before + 1, "and sends nothing")
    const rows = await withCompany(pool.db, tenant.companyId, (tx) => tx.select({ id: message.id }).from(message).where(and(eq(message.companyId, tenant.companyId), eq(message.sourceEventId, booked.id))))
    assert.equal(rows.length, 1)
  })

  test("its stop completed is its collection, and a stop that collects no booking is no notice", async () => {
    const collected = await noticeCustomerFor(event("pickup-completed", stopPayload("completed", booking.id)), context())
    assert.equal(collected.notice, "bulky-booking-collected")
    assert.equal((await read(collected.messageIds[0])).body.endsWith(`collected on ${FIXTURE_DAY}.`), true)
    const emptying = await noticeCustomerFor(event("pickup-completed", stopPayload("completed", null)), context())
    assert.deepEqual([emptying.notice, emptying.messageIds], [null, []])
  })

  test("a notice no rule names sends nothing: the project did not opt in", async () => {
    const missed = await noticeCustomerFor(event("pickup-failed", stopPayload("failed", booking.id)), context())
    assert.deepEqual([missed.notice, missed.messageIds, missed.why], ["bulky-booking-not-collected" satisfies CustomerNoticeEvent, [], []])
  })

  test("a notice that cannot be sent is logged and the job completes: the template made inactive since", async () => {
    await withCompany(pool.db, tenant.companyId, (tx) => tx.update(messageTemplate).set({ status: "inactive" }).where(eq(messageTemplate.id, templates.booked)))
    try {
      lines.length = 0
      const cancelled = await noticeCustomerFor(event("bulky-booking-cancelled", { ...bookingPayload(), status: "cancelled" }), context())
      assert.deepEqual([cancelled.notice, cancelled.messageIds], ["bulky-booking-cancelled", []])
      assert.match(cancelled.why.join(" "), /The template Bulky booked is inactive/)
      assert.match(lines.join("\n"), /bulky-booking-cancelled not sent: The template Bulky booked is inactive/)
    } finally {
      await withCompany(pool.db, tenant.companyId, (tx) => tx.update(messageTemplate).set({ status: "active" }).where(eq(messageTemplate.id, templates.booked)))
    }
  })

  let ticketNumber = 900
  const openTicket = async (customerId: string | null) => {
    ticketNumber += 1
    const [row] = await withCompany(pool.db, tenant.companyId, (tx) =>
      tx
        .insert(ticket)
        .values({ companyId: tenant.companyId, projectId: tenant.projects.copenhagen.id, number: ticketNumber, kind: "missed-collection", source: "phone", subject: "Bin not emptied", description: "Not emptied on Monday.", occurredAt: NOON, createdBy: tenant.users.olivia.id, customerId })
        .returning(ticketColumns),
    )
    return ticketOf(row)
  }
  const replyTo = async (ticketId: string, body: string) => {
    const [row] = await withCompany(pool.db, tenant.companyId, (tx) =>
      tx
        .insert(ticketEvent)
        .values({ companyId: tenant.companyId, projectId: tenant.projects.copenhagen.id, ticketId, kind: "comment", status: "open", body, visibility: "customer", recordedBy: tenant.users.olivia.id })
        .returning(eventColumns),
    )
    return eventOf(row)
  }
  const recipientsOf = async (messageIds: readonly string[]) => (await Promise.all(messageIds.map(read))).map((row) => row.customerId).sort()

  test("a ticket's reply goes to its customer with its label and the reply's words, and its completion with its label", async () => {
    const open = await openTicket(tenant.customers.housing.id)
    const replied = await noticeCustomerFor(event("ticket-replied", await replyTo(open.id, "We come back on Wednesday.")), context())
    assert.equal(replied.notice, "ticket-replied")
    const row = await read(replied.messageIds[0])
    assert.deepEqual([row.customerId, row.subject, row.body], [tenant.customers.housing.id, `About ${open.label}`, "We come back on Wednesday."])

    const completed = await noticeCustomerFor(event("ticket-completed", { ...open, status: "completed", resolution: "answered", closedAt: NOON.toISOString() }), context())
    assert.equal((await read(completed.messageIds[0])).body, `${open.label} is closed.`)

    const nobodys = await openTicket(null)
    assert.deepEqual((await noticeCustomerFor(event("ticket-replied", await replyTo(nobodys.id, "Thanks")), context())).messageIds, [], "a ticket naming no customer tells nobody")
  })

  const cancelledPayload = (cancelReasonCode: string) => ({ id: planned.id, operatingDate: FIXTURE_DAY, cancelReasonCode, status: "cancelled" })

  test("a route cancelled goes to every customer its owed stops serve, or those in the rule's areas, and a regeneration's to nobody", async () => {
    const everyone = await noticeCustomerFor(event("route-cancelled", cancelledPayload("weather")), context())
    assert.equal(everyone.notice, "route-cancelled")
    assert.deepEqual(await recipientsOf(everyone.messageIds), [tenant.customers.housing.id, tenant.customers.anna.id].sort(), "no area is the whole project")
    assert.equal((await read(everyone.messageIds[0])).body, `About your collection on ${FIXTURE_DAY}.`)
    assert.deepEqual((await noticeCustomerFor(event("route-cancelled", cancelledPayload("regeneration")), context())).messageIds, [], "generation's cancel moved the collections, it did not miss them")

    await withCompany(pool.db, tenant.companyId, (tx) => tx.insert(notificationRuleArea).values({ companyId: tenant.companyId, projectId: tenant.projects.copenhagen.id, ruleId: rules.cancelled, planningAreaId: north }))
    try {
      const northOnly = await noticeCustomerFor(event("route-cancelled", cancelledPayload("weather")), context())
      assert.deepEqual(await recipientsOf(northOnly.messageIds), [tenant.customers.housing.id], "Anna's place lies outside north")
    } finally {
      await withCompany(pool.db, tenant.companyId, (tx) => tx.delete(notificationRuleArea).where(eq(notificationRuleArea.ruleId, rules.cancelled)))
    }
  })

  test("a route not started is running late; another rule's alert is no notice", async () => {
    const raise = async (occurrence: Parameters<typeof alertOfRule>[0]) => {
      const values = alertOfRule(occurrence)
      const [row] = await withCompany(pool.db, tenant.companyId, (tx) =>
        tx
          .insert(alert)
          .values({ companyId: tenant.companyId, projectId: tenant.projects.copenhagen.id, ...values, ruleKey: testId(), detectedAt: NOON, raisedBy: null })
          .returning(alertColumns),
      )
      return alertOf(row)
    }
    const late = await noticeCustomerFor(event("alert-raised", await raise({ rule: "route-not-started", routeId: planned.id, routeLabel: `R-${planned.number}`, operatingDate: FIXTURE_DAY, plannedStart: "06:00", driverId: null, vehicleId: null })), context())
    assert.equal(late.notice, "route-late")
    assert.deepEqual(await recipientsOf(late.messageIds), [tenant.customers.housing.id, tenant.customers.anna.id].sort())
    const silent = await noticeCustomerFor(event("alert-raised", await raise({ rule: "session-silent", routeId: planned.id, routeLabel: `R-${planned.number}`, driverId: tenant.fleet.driverId, driverName: "Driver", vehicleId: null, lastSeen: NOON.toISOString() })), context())
    assert.deepEqual([silent.notice, silent.messageIds], [null, []])
  })

  test("takes the eight kinds, one queue each", () => {
    assert.deepEqual([...CUSTOMER_NOTICE_KINDS] satisfies OutboxKind[], ["bulky-booking-booked", "bulky-booking-cancelled", "pickup-completed", "pickup-failed", "ticket-replied", "ticket-completed", "route-cancelled", "alert-raised"])
  })
})
