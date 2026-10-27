// Bulky-waste booking (O11 of #290, @waste/domain/execution/bulky): the days
// a Planning Area collects bulky waste on, and the bookings that take a slot
// of one.
//
// `bulky_schedule` is a Planning Area's effective-dated recurrence (ADR-0005)
// — the Route Scheme's frequency, service days, week rotation and holiday
// policy, spelled with the scheme's checks — with the slots each day has and
// the Product a booking is charged at. One schedule of an area is in force at
// a time, under the hand-written exclusion constraint over the area.
//
// `bulky_booking` is current state: the customer, the place (one of two), the
// agreement charged, the fraction and the day, with the area, the schedule and
// the product it was booked under frozen beside them, so a schedule changed
// later moves no booking already made. It is cancelled by its stamps, never
// deleted; whether it is booked, routed or collected is a reading of the stop
// that names it (`pickup.bulky_booking_id`), never a column. Its items are
// `bulky_booking_item`, by position, replaced whole when the office changes
// them.
import { HOLIDAY_POLICIES, RECURRENCE_FREQUENCIES, SERVICE_DAYS, WEEK_ROTATIONS } from "@waste/domain/planning/vocabulary"
import { sql } from "drizzle-orm"
import { check, date, index, integer, text, timestamp, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "./access"
import { agreement } from "./agreements"
import { product, wasteFraction } from "./catalogue"
import { exactlyOne, nonEmpty, oneOf, positive, subsetOf } from "./checks"
import { id, projectScoped, timestamps, validity, validPeriod } from "./columns"
import { customer, property, sharedCollectionPoint } from "./customers"
import { company, project } from "./organisation"
import { planningArea } from "./planning-areas"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

const instant = () => timestamp({ withTimezone: true })

export const bulkySchedule = wms.table(
  "bulky_schedule",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    planningAreaId: uuid().notNull(),
    frequency: text().notNull(),
    serviceDays: text().array().notNull(),
    /** Which ISO-week parity an `every-2-weeks` schedule serves; given with that frequency and with nothing else. */
    weekRotation: text(),
    holidayPolicy: text().notNull(),
    /** How many bookings one day takes. */
    slotsPerDay: integer().notNull(),
    /** What a booking is charged at once collected: a product sold by the job. */
    productId: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.planningAreaId], planningArea),
    projectReference(t, [t.productId], product),
    projectKey(t),
    validPeriod(t),
    oneOf(t.frequency, RECURRENCE_FREQUENCIES),
    subsetOf(t.serviceDays, SERVICE_DAYS),
    nonEmpty(t.serviceDays),
    oneOf(t.weekRotation, WEEK_ROTATIONS),
    oneOf(t.holidayPolicy, HOLIDAY_POLICIES),
    check(tableObjectName(t.id.table, "week_rotation_shape", "bulkySchedule"), sql`(${t.frequency} = 'every-2-weeks') = (${t.weekRotation} is not null)`),
    positive(t.slotsPerDay),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.planningAreaId),
    tenantIndex(t, t.productId),
  ],
)

export const bulkyBooking = wms.table(
  "bulky_booking",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    customerId: uuid().notNull(),
    /** The agreement the collection is charged to: the customer's. */
    agreementId: uuid().notNull(),
    propertyId: uuid(),
    sharedCollectionPointId: uuid(),
    wasteFractionId: uuid().notNull(),
    /** The day the truck comes: one of the schedule's days. */
    day: date().notNull(),
    /** The area the place lay in, the schedule whose slot it takes, and the product it is charged at, each as on the day it was booked. */
    planningAreaId: uuid().notNull(),
    scheduleId: uuid().notNull(),
    productId: uuid().notNull(),
    /** What the driver is told at the stop. */
    note: text(),
    /** The person who booked it; null where no person of the company did. */
    bookedBy: uuid(),
    cancelledAt: instant(),
    cancelledBy: uuid(),
    cancelReason: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.customerId], customer),
    projectReference(t, [t.agreementId], agreement),
    projectReference(t, [t.propertyId], property),
    projectReference(t, [t.sharedCollectionPointId], sharedCollectionPoint),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    projectReference(t, [t.planningAreaId], planningArea),
    projectReference(t, [t.scheduleId], bulkySchedule),
    projectReference(t, [t.productId], product),
    tenantReference(t, [t.bookedBy], userAccount),
    tenantReference(t, [t.cancelledBy], userAccount),
    projectKey(t),
    exactlyOne(t, "place", [t.propertyId, t.sharedCollectionPointId]),
    // A cancellation is its instant and its reason together; the person only with them.
    check(tableObjectName(t.id.table, "cancel_shape", "bulkyBooking"), sql`(${t.cancelledAt} is null) = (${t.cancelReason} is null) and (${t.cancelledBy} is null or ${t.cancelledAt} is not null)`),
    // A day's bookings, which its slots are counted over.
    index(tableObjectName(t.companyId.table, "schedule_id_day_idx", "bulkyBooking")).on(t.companyId, t.scheduleId, t.day),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.customerId),
    tenantIndex(t, t.agreementId),
    tenantIndex(t, t.propertyId),
    tenantIndex(t, t.sharedCollectionPointId),
    tenantIndex(t, t.wasteFractionId),
    tenantIndex(t, t.planningAreaId),
    tenantIndex(t, t.productId),
    tenantIndex(t, t.bookedBy),
    tenantIndex(t, t.cancelledBy),
  ],
)

export const bulkyBookingItem = wms.table(
  "bulky_booking_item",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    bookingId: uuid().notNull(),
    /** Its place in the booking's list, from 1. */
    position: integer().notNull(),
    /** What the item is, in the customer's words: "sofa", "fridge". */
    description: text().notNull(),
    quantity: integer().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.bookingId], bulkyBooking),
    check(tableObjectName(t.id.table, "description_given", "bulkyBookingItem"), sql`length(btrim(${t.description})) > 0`),
    positive(t.quantity),
    positive(t.position),
    tenantIndex(t, t.projectId),
    // A booking's items in the order they were listed, each place once.
    tenantUnique(t, t.bookingId, t.position),
  ],
)
