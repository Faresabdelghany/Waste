import assert from "node:assert/strict"
import { randomInt } from "node:crypto"
import { after, before, describe, test } from "node:test"

import { BulkyAvailability, BulkyBooking, BulkySchedule } from "@waste/contracts/bulky"
import type { Polygon } from "@waste/contracts/geojson"
import { Page } from "@waste/contracts/pagination"
import { PickupDetail, THE_BOOKING_ALONE } from "@waste/contracts/pickups"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { NOT_THE_CUSTOMERS, notServedUnder } from "@waste/db/commands/bulky-bookings"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { product, wasteFraction } from "@waste/db/schema/catalogue"
import { customer, property } from "@waste/db/schema/customers"
import { planningArea } from "@waste/db/schema/planning-areas"
import { outboxEvent, pickup, route as route_ } from "@waste/db/schema/execution"
import { and, asc, eq } from "drizzle-orm"
import { withCompany } from "@waste/db/tenant"
import { dayFull, NO_BULKY_SCHEDULE, NO_LOCATION, notABulkyDay, notAfterToday, notTheBookingsDay, onlyABookedBooking } from "@waste/domain/execution/bulky"

import { createApp } from "../app"
import { bookingsOutside, unofferedBulkyProduct } from "../routes/bulky-schedules"
import { INACTIVE_CUSTOMER } from "../routes/bulky-bookings"
import { BOOKING_CANCELLED, NOT_A_BULKY_BOOKING } from "../routes/pickups"
import { bulkyKeepsTheDay } from "../routes/routes"
import { A_JOB_IS_SOLD_BY_THE_JOB } from "../routes/work-order-charges"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { TOWN_HALL } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"

const database = databaseUnderTest()
/** The owner sweeps the audit trail the bookings write. */
const owner = ownerUnderTest()
const BookingPage = Page(BulkyBooking)
const SchedulePage = Page(BulkySchedule)

/** The request's clock, pinned: Monday 1 March 2027, mid-morning in Copenhagen. */
const NOW = new Date("2027-03-01T09:00:00Z")
const TODAY = "2027-03-01"
/** The schedule's Tuesdays. */
const TUESDAY = "2027-03-02"
const NEXT_TUESDAY = "2027-03-09"
const THIRD_TUESDAY = "2027-03-16"

/** A square over central Copenhagen, the town hall inside it. */
const CENTRUM: Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [12.5, 55.65],
      [12.65, 55.65],
      [12.65, 55.75],
      [12.5, 55.75],
      [12.5, 55.65],
    ],
  ],
}

describe("bulky-waste booking (O11 of #290)", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let olivia: Call
  let other: Call
  let ungranted: Call
  let fleet: FleetFixtures
  const ids = {
    area: testId(),
    bulky: testId(),
    collection: testId(),
    draft: testId(),
    fraction: testId(),
    customer: testId(),
    stranger: testId(),
    agreement: testId(),
    strangers: testId(),
    home: testId(),
    outside: testId(),
    nowhere: testId(),
  }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOW })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, a.users.viewer, a.companyId)
    const scoped = { companyId: a.companyId, projectId: a.projects.copenhagen.id }
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.insert(wasteFraction).values({ id: ids.fraction, companyId: a.companyId, key: "bulky", name: "Bulky waste" })
      await tx.insert(product).values([
        { id: ids.bulky, ...scoped, name: "Bulky collection", kind: "additional-service", unit: "job", status: "active" },
        { id: ids.collection, ...scoped, name: "Residual 240 L", kind: "container-collection", unit: "pickup", status: "active" },
        { id: ids.draft, ...scoped, name: "Bulky collection (draft)", kind: "additional-service", unit: "job", status: "draft" },
      ])
      const organisation = (id: string, name: string) => ({ id, companyId: a.companyId, kind: "organisation", name, registrationNumber: String(randomInt(10_000_000, 100_000_000)), status: "active" })
      await tx.insert(customer).values([organisation(ids.customer, "Parkvej Boligforening"), organisation(ids.stranger, "Another Housing")])
      const home = (id: string, name: string, location: typeof TOWN_HALL | null) => ({ id, ...scoped, name, address: `${name}, København`, kind: "residential", location, status: "active" })
      await tx.insert(property).values([home(ids.home, "Parkvej 18", TOWN_HALL), home(ids.outside, "Roskildevej 1", { type: "Point", coordinates: [12.1, 55.6] }), home(ids.nowhere, "Ukendt 1", null)])
      const contract = (id: string, number: string, customerId: string) => ({ id, ...scoped, validFrom: "2026-01-01", number, customerId, payerCustomerId: customerId, status: "active", billingCadence: "monthly", currency: "DKK" })
      await tx.insert(agreement).values([contract(ids.agreement, "AGR-501", ids.customer), contract(ids.strangers, "AGR-502", ids.stranger)])
      await tx.insert(subscription).values([
        { id: testId(), ...scoped, validFrom: "2026-01-01", agreementId: ids.agreement, productId: ids.collection, propertyId: ids.home },
        { id: testId(), ...scoped, validFrom: "2026-01-01", agreementId: ids.agreement, productId: ids.collection, propertyId: ids.outside },
        { id: testId(), ...scoped, validFrom: "2026-01-01", agreementId: ids.agreement, productId: ids.collection, propertyId: ids.nowhere },
      ])
      await tx.insert(planningArea).values({ id: ids.area, ...scoped, code: "BLK-CEN", name: "Centrum bulky", purpose: "service-operations" })
    })
    const boundary = await olivia(`/planning-areas/${ids.area}/boundaries`, { method: "POST", body: { boundary: CENTRUM, validFrom: "2026-01-01" } })
    assert.equal(boundary.status, 201, JSON.stringify(await boundary.clone().json()))
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const post = (call: Call, path: string, body: unknown) => call(path, { method: "POST", body })
  const patch = (call: Call, path: string, body: unknown) => call(path, { method: "PATCH", body })
  const booking = (values: Record<string, unknown> = {}) => ({ customerId: ids.customer, agreementId: ids.agreement, propertyId: ids.home, wasteFractionId: ids.fraction, day: NEXT_TUESDAY, items: [{ description: "Sofa", quantity: 1 }], ...values })
  const book = async (values: Record<string, unknown> = {}): Promise<BulkyBooking> => await created(olivia, "/bulky-bookings", await post(olivia, "/bulky-bookings", booking(values)), BulkyBooking)
  const days = async (query: string, call = olivia): Promise<BulkyAvailability> => {
    const response = await call(`/bulky-bookings/availability?${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return BulkyAvailability.parse(await response.json())
  }
  let schedule: BulkySchedule
  /** The outbox rows about one booking, oldest first, read as `wms_api` under the fence. */
  const eventsAbout = (aggregateId: string) =>
    withCompany(pool.db, a.companyId, (tx: Tx) =>
      tx
        .select({ kind: outboxEvent.kind, aggregateKind: outboxEvent.aggregateKind, projectId: outboxEvent.projectId, occurredAt: outboxEvent.occurredAt, payload: outboxEvent.payload })
        .from(outboxEvent)
        .where(and(eq(outboxEvent.companyId, a.companyId), eq(outboxEvent.aggregateId, aggregateId)))
        .orderBy(asc(outboxEvent.id)),
    )

  test("a schedule is an area's Tuesdays with two slots each, charged at a product sold by the job; one of an area is in force at a time", async () => {
    const body = { projectId: a.projects.copenhagen.id, planningAreaId: ids.area, frequency: "weekly", serviceDays: ["tuesday"], slotsPerDay: 2, productId: ids.bulky, validFrom: "2027-01-01" }
    assert.deepEqual((await refused(await post(olivia, "/bulky-schedules", { ...body, productId: ids.collection }), 400)).errors, [{ path: "productId", message: A_JOB_IS_SOLD_BY_THE_JOB }])
    assert.equal((await refused(await post(olivia, "/bulky-schedules", { ...body, productId: ids.draft }), 409)).detail, unofferedBulkyProduct("draft"))
    schedule = await created(olivia, "/bulky-schedules", await post(olivia, "/bulky-schedules", body), BulkySchedule)
    assert.deepEqual([schedule.holidayPolicy, schedule.weekRotation, schedule.validTo], ["skip", null, null])
    assert.match((await refused(await post(olivia, "/bulky-schedules", { ...body, validFrom: "2027-06-01" }), 409)).detail ?? "", /in force over part of that period already/)
    const listed = SchedulePage.parse(await (await olivia(`/bulky-schedules?planningAreaId=${ids.area}&validOn=${TODAY}`)).json())
    assert.deepEqual(
      listed.items.map((row) => row.id),
      [schedule.id],
    )
    await refused(await other(`/bulky-schedules/${schedule.id}`), 404)
    assert.match((await refused(await ungranted("/bulky-schedules"), 403)).detail ?? "", /view on route-studio\.schemes/)
  })

  test("a place's days are its area's Tuesdays after today, each with its slots left; a place outside every scheduled area or with no location is refused", async () => {
    const answer = await days(`propertyId=${ids.home}&from=${TODAY}&to=${THIRD_TUESDAY}`)
    assert.deepEqual(answer.days, [TUESDAY, NEXT_TUESDAY, THIRD_TUESDAY].map((day) => ({ day, slots: 2, booked: 0, left: 2, planningAreaId: ids.area, scheduleId: schedule.id })))
    assert.equal((await refused(await olivia(`/bulky-bookings/availability?propertyId=${ids.outside}&from=${TODAY}&to=${THIRD_TUESDAY}`), 409)).detail, NO_BULKY_SCHEDULE)
    assert.equal((await refused(await olivia(`/bulky-bookings/availability?propertyId=${ids.nowhere}&from=${TODAY}&to=${THIRD_TUESDAY}`), 409)).detail, NO_LOCATION)
    assert.deepEqual((await refused(await other(`/bulky-bookings/availability?propertyId=${ids.home}&from=${TODAY}&to=${THIRD_TUESDAY}`), 400)).errors?.map((error) => error.path), ["propertyId"])
  })

  test("a booking takes a slot of its day, freezing the area, the schedule and the product, and stands booked with its items", async () => {
    const made = await book({ items: [{ description: "Sofa", quantity: 1 }, { description: "Armchair", quantity: 2 }], note: "Behind the gate" })
    assert.deepEqual([made.status, made.stop, made.day, made.planningAreaId, made.scheduleId, made.productId, made.bookedBy], ["booked", null, NEXT_TUESDAY, ids.area, schedule.id, ids.bulky, a.users.olivia.id])
    assert.deepEqual(made.items, [{ description: "Sofa", quantity: 1 }, { description: "Armchair", quantity: 2 }])
    const answer = await days(`propertyId=${ids.home}&from=${NEXT_TUESDAY}&to=${NEXT_TUESDAY}`)
    assert.deepEqual(answer.days.map((day) => [day.booked, day.left]), [[1, 1]])
    assert.deepEqual(BulkyBooking.parse(await (await olivia(`/bulky-bookings/${made.id}`)).json()), made)
    await refused(await other(`/bulky-bookings/${made.id}`), 404)
    // The customer notices' news (O16 of #290, part b): the booking as answered, at the request's clock.
    const [news, ...more] = await eventsAbout(made.id)
    assert.equal(more.length, 0)
    assert.deepEqual([news.kind, news.aggregateKind, news.projectId, news.occurredAt.toISOString()], ["bulky-booking-booked", "bulky-booking", a.projects.copenhagen.id, NOW.toISOString()])
    assert.deepEqual(BulkyBooking.parse(news.payload), made)
  })

  test("a booking is refused another customer's agreement, today, a day that is no collection day, a place the agreement serves nothing at, and a full day", async () => {
    assert.deepEqual((await refused(await post(olivia, "/bulky-bookings", booking({ agreementId: ids.strangers })), 400)).errors, [{ path: "customerId", message: NOT_THE_CUSTOMERS }])
    assert.equal((await refused(await post(olivia, "/bulky-bookings", booking({ day: TODAY })), 409)).detail, notAfterToday(TODAY))
    assert.equal((await refused(await post(olivia, "/bulky-bookings", booking({ day: "2027-03-10" })), 409)).detail, notABulkyDay("2027-03-10"))
    assert.equal((await refused(await post(olivia, "/bulky-bookings", booking({ customerId: ids.stranger, agreementId: ids.strangers })), 409)).detail, notServedUnder("AGR-502", NEXT_TUESDAY))
    await book({ day: THIRD_TUESDAY })
    await book({ day: THIRD_TUESDAY })
    assert.equal((await refused(await post(olivia, "/bulky-bookings", booking({ day: THIRD_TUESDAY })), 409)).detail, dayFull(THIRD_TUESDAY))
    const full = await days(`propertyId=${ids.home}&from=${THIRD_TUESDAY}&to=${THIRD_TUESDAY}`)
    assert.deepEqual(full.days.map((day) => day.left), [0], "a full day is listed with none left")
  })

  test("a booked booking moves to another day judged again, its items replaced whole; a schedule ended under bookings is refused", async () => {
    const made = await book({ day: TUESDAY })
    const moved = BulkyBooking.parse(await (await patch(olivia, `/bulky-bookings/${made.id}`, { day: NEXT_TUESDAY, items: [{ description: "Fridge", quantity: 1 }] })).json())
    assert.deepEqual([moved.day, moved.items], [NEXT_TUESDAY, [{ description: "Fridge", quantity: 1 }]])
    assert.equal((await refused(await patch(olivia, `/bulky-bookings/${made.id}`, { day: THIRD_TUESDAY }), 409)).detail, dayFull(THIRD_TUESDAY))
    assert.equal((await refused(await patch(olivia, `/bulky-schedules/${schedule.id}`, { validTo: NEXT_TUESDAY }), 409)).detail, bookingsOutside(4))
    const more = BulkySchedule.parse(await (await patch(olivia, `/bulky-schedules/${schedule.id}`, { slotsPerDay: 10 })).json())
    assert.equal(more.slotsPerDay, 10)
  })

  test("the office routes a booking as a stop on a route of its day, at its place with no container; a routed booking is neither routed again nor cancelled, and its stop taken off books it again", async () => {
    const made = await book({ day: NEXT_TUESDAY })
    const route = (await (await post(olivia, "/routes", { projectId: a.projects.copenhagen.id, operatingDate: NEXT_TUESDAY })).json()) as { id: string; label: string }
    const elsewhere = (await (await post(olivia, "/routes", { projectId: a.projects.copenhagen.id, operatingDate: THIRD_TUESDAY })).json()) as { id: string }

    assert.deepEqual((await refused(await post(olivia, `/routes/${route.id}/pickups`, { service: "bulky", bulkyBookingId: made.id, propertyId: ids.home }), 400)).errors, [{ path: "propertyId", message: THE_BOOKING_ALONE }])
    assert.deepEqual((await refused(await post(olivia, `/routes/${route.id}/pickups`, { service: "bulky", bulkyBookingId: testId() }), 400)).errors, [{ path: "bulkyBookingId", message: NOT_A_BULKY_BOOKING }])
    assert.equal((await refused(await post(olivia, `/routes/${elsewhere.id}/pickups`, { service: "bulky", bulkyBookingId: made.id }), 409)).detail, notTheBookingsDay(NEXT_TUESDAY, THIRD_TUESDAY))

    const stop = await created(olivia, `/routes/${route.id}/pickups`, await post(olivia, `/routes/${route.id}/pickups`, { service: "bulky", bulkyBookingId: made.id }), PickupDetail, "/pickups")
    assert.deepEqual([stop.service, stop.origin, stop.containerId, stop.propertyId, stop.wasteFractionId, stop.bulkyBookingId], ["bulky", "office", null, ids.home, ids.fraction, made.id])
    const routed = BulkyBooking.parse(await (await olivia(`/bulky-bookings/${made.id}`)).json())
    assert.deepEqual([routed.status, routed.stop], ["routed", { pickupId: stop.id, routeId: route.id, status: "planned" }])

    assert.match((await refused(await post(olivia, `/routes/${route.id}/pickups`, { service: "bulky", bulkyBookingId: made.id }), 409)).detail ?? "", /routed already/)
    assert.equal((await refused(await post(olivia, `/bulky-bookings/${made.id}/cancel`, { reason: "Customer called" }), 409)).detail, onlyABookedBooking("routed", "cancel"))
    const routedOnly = BookingPage.parse(await (await olivia(`/bulky-bookings?status=routed&projectId=${a.projects.copenhagen.id}`)).json())
    assert.deepEqual(
      routedOnly.items.map((row) => row.id),
      [made.id],
    )

    assert.equal((await post(olivia, `/pickups/${stop.id}/remove`, { reason: "Truck full" })).status, 200)
    const again = BulkyBooking.parse(await (await olivia(`/bulky-bookings/${made.id}`)).json())
    assert.deepEqual([again.status, again.stop], ["booked", null])
    const cancelled = BulkyBooking.parse(await (await post(olivia, `/bulky-bookings/${made.id}/cancel`, { reason: "Customer called" })).json())
    assert.deepEqual([cancelled.status, cancelled.cancelReason, cancelled.cancelledBy], ["cancelled", "Customer called", a.users.olivia.id])
    const news = await eventsAbout(made.id)
    assert.deepEqual(news.map((event) => event.kind), ["bulky-booking-booked", "bulky-booking-cancelled"], "a move, a routing and a removal are nobody's news; the cancel is the customer's")
    assert.deepEqual(BulkyBooking.parse(news[1].payload), cancelled)
    assert.equal((await refused(await post(olivia, `/routes/${route.id}/pickups`, { service: "bulky", bulkyBookingId: made.id }), 409)).detail, onlyABookedBooking("cancelled", "route"))
  })

  test("a route carrying a booking's stop does not move off the booking's day; the stop tells the driver the booking's note", async () => {
    const made = await book({ day: NEXT_TUESDAY, note: "Ring twice" })
    const route = (await (await post(olivia, "/routes", { projectId: a.projects.copenhagen.id, operatingDate: NEXT_TUESDAY })).json()) as { id: string; label: string }
    const stop = await created(olivia, `/routes/${route.id}/pickups`, await post(olivia, `/routes/${route.id}/pickups`, { service: "bulky", bulkyBookingId: made.id }), PickupDetail, "/pickups")
    assert.equal(stop.note, "Ring twice")
    assert.equal((await refused(await post(olivia, `/routes/${route.id}/reschedule`, { operatingDate: THIRD_TUESDAY }), 409)).detail, bulkyKeepsTheDay(route.label, 1))
    assert.equal((await post(olivia, `/routes/${route.id}/reschedule`, { plannedStartTime: "07:00" })).status, 200, "a time on the same day moves nothing the customer booked")
  })

  test("a cancelled booking's missed stop is never corrected to completed, which would charge it", async () => {
    const made = await book({ day: NEXT_TUESDAY })
    const route = (await (await post(olivia, "/routes", { projectId: a.projects.copenhagen.id, operatingDate: NEXT_TUESDAY })).json()) as { id: string }
    const stop = await created(olivia, `/routes/${route.id}/pickups`, await post(olivia, `/routes/${route.id}/pickups`, { service: "bulky", bulkyBookingId: made.id }), PickupDetail, "/pickups")
    // The route ran and the stop was missed, as the driver door leaves it; the booking is booked again, then cancelled.
    const ran = new Date("2027-03-09T07:00:00Z")
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.update(route_).set({ status: "completed", dispatchedAt: ran, startedAt: ran, completedAt: ran, actualDriverId: fleet.drivers.mads.id, actualVehicleId: fleet.vehicles.wh24.id }).where(eq(route_.id, route.id))
      await tx.update(pickup).set({ status: "failed", reason: "not-presented", outcomeAt: ran }).where(eq(pickup.id, stop.id))
    })
    assert.equal((await post(olivia, `/bulky-bookings/${made.id}/cancel`, { reason: "Customer took it to the recycling centre" })).status, 200)
    assert.equal((await refused(await post(olivia, `/pickups/${stop.id}/correct-outcome`, { outcome: "completed", note: "The driver collected it after all" }), 409)).detail, BOOKING_CANCELLED)
  })

  test("the availability names its project where asked, and a booking is refused a customer who is not active", async () => {
    const answer = await days(`projectId=${a.projects.copenhagen.id}&propertyId=${ids.home}&from=${NEXT_TUESDAY}&to=${NEXT_TUESDAY}`)
    assert.deepEqual(answer.days.map((day) => day.day), [NEXT_TUESDAY])
    assert.deepEqual((await refused(await olivia(`/bulky-bookings/availability?projectId=${a.projects.harbor.id}&propertyId=${ids.home}&from=${NEXT_TUESDAY}&to=${NEXT_TUESDAY}`), 400)).errors?.map((error) => error.path), ["propertyId"])
    assert.deepEqual((await refused(await olivia(`/bulky-bookings/availability?projectId=${testId()}&propertyId=${ids.home}&from=${NEXT_TUESDAY}&to=${NEXT_TUESDAY}`), 400)).errors?.map((error) => error.path), ["projectId"])
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.update(customer).set({ status: "inactive" }).where(eq(customer.id, ids.stranger))
    })
    assert.equal((await refused(await post(olivia, "/bulky-bookings", booking({ customerId: ids.stranger, agreementId: ids.strangers })), 409)).detail, INACTIVE_CUSTOMER)
  })

  test("where two scheduled areas hold the place, a day is the lower area code's schedule's while it is in force, and the other's days are not offered", async () => {
    const first = testId()
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.insert(planningArea).values({ id: first, companyId: a.companyId, projectId: a.projects.copenhagen.id, code: "BLK-AAA", name: "Inner bulky", purpose: "service-operations" })
    })
    assert.equal((await olivia(`/planning-areas/${first}/boundaries`, { method: "POST", body: { boundary: CENTRUM, validFrom: "2026-01-01" } })).status, 201)
    const wednesdays = await created(
      olivia,
      "/bulky-schedules",
      await post(olivia, "/bulky-schedules", { projectId: a.projects.copenhagen.id, planningAreaId: first, frequency: "weekly", serviceDays: ["wednesday"], slotsPerDay: 3, productId: ids.bulky, validFrom: "2027-03-20" }),
      BulkySchedule,
    )
    const answer = await days(`propertyId=${ids.home}&from=2027-03-15&to=2027-03-31`)
    assert.deepEqual(
      answer.days.map((day) => [day.day, day.scheduleId]),
      [
        [THIRD_TUESDAY, schedule.id],
        ["2027-03-24", wednesdays.id],
        ["2027-03-31", wednesdays.id],
      ],
    )
  })
})
