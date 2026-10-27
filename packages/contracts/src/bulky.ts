// The wire of bulky-waste booking (O11 of #290,
// @waste/domain/execution/bulky): an area's Bulky Schedules, the Bulky
// Bookings that take a slot of one of its days, and the days a place may be
// booked on. The routes are apps/api/src/routes/bulky-schedules.ts and
// bulky-bookings.ts.
//
// A schedule is effective-dated per planning area (ADR-0005): its area and
// its recurrence are its key, so a patch moves the slots, the product and the
// end alone — end it and add another, as a price row. A booking names its
// customer, the place (one of two), the agreement it is charged to, the day,
// the fraction and the items; the area, the schedule and the product are the
// server's, read from the place and the day. Its status is a reading, and its
// stop the office's Add stop (`PickupAdd.bulkyBookingId`).
import { BULKY_ITEM_QUANTITY_MAX, BULKY_ITEMS_MAX, BULKY_WINDOW_DAYS_MAX } from "@waste/domain/execution/bulky"
import { BULKY_BOOKING_STATUSES } from "@waste/domain/execution/vocabulary"
import * as z from "zod"

import { IsoDate, IsoDateTime } from "./dates"
import { PickupStatus } from "./execution"
import { Id } from "./ids"
import { HolidayPolicy, RecurrenceFrequency, ServiceDays, WeekRotation } from "./planning"
import { ProjectScopedListQuery, dayWindowIsOrdered, dayWindowOrdered } from "./queries"
import { changesSomething, NonNegativeInt, PositiveInt, somethingToChange, stamped } from "./resource"
import { weekRotationShape, WEEK_ROTATION_WITH_FORTNIGHTLY } from "./route-schemes"
import { Label, Paragraph } from "./text"
import { endsAfterItStarts, Validity, ValidityCreate, validityOrdered } from "./validity"

export { BULKY_ITEM_QUANTITY_MAX, BULKY_ITEMS_MAX, BULKY_WINDOW_DAYS_MAX }

/** Where a booking stands: booked, routed by a planned stop, collected by a completed one, or cancelled. */
export const BulkyBookingStatus = z.enum(BULKY_BOOKING_STATUSES)
export type BulkyBookingStatus = z.infer<typeof BulkyBookingStatus>

const weekRotationWithFortnightly = { message: WEEK_ROTATION_WITH_FORTNIGHTLY, path: ["weekRotation"] }

/** How many bookings one day takes, at most. */
const SlotsPerDay = PositiveInt.max(1000)

export const BulkySchedule = z
  .object({
    ...stamped,
    projectId: Id,
    planningAreaId: Id,
    frequency: RecurrenceFrequency,
    serviceDays: ServiceDays,
    /** Which ISO-week parity an every-2-weeks schedule serves; null for every other frequency. */
    weekRotation: WeekRotation.nullable(),
    holidayPolicy: HolidayPolicy,
    slotsPerDay: SlotsPerDay,
    /** What a booking is charged at once collected: a product of the project sold by the job. */
    productId: Id,
    ...Validity.shape,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type BulkySchedule = z.infer<typeof BulkySchedule>

export const BulkyScheduleCreate = z
  .strictObject({
    projectId: Id,
    planningAreaId: Id,
    frequency: RecurrenceFrequency,
    serviceDays: ServiceDays.min(1),
    weekRotation: WeekRotation.nullable().optional(),
    holidayPolicy: HolidayPolicy.default("skip"),
    slotsPerDay: SlotsPerDay,
    productId: Id,
    ...ValidityCreate,
  })
  .refine(validityOrdered, endsAfterItStarts)
  .refine(weekRotationShape, weekRotationWithFortnightly)
export type BulkyScheduleCreate = z.infer<typeof BulkyScheduleCreate>

/** The slots, the product and the end; the area and the recurrence are the schedule's key and its start its period's — end it and add another. */
export const BulkySchedulePatch = z
  .strictObject({
    slotsPerDay: SlotsPerDay.optional(),
    productId: Id.optional(),
    /** Null reopens the schedule; a day ends it. */
    validTo: IsoDate.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type BulkySchedulePatch = z.infer<typeof BulkySchedulePatch>

/** A page of schedules: one project's or one area's, in force on a day where `validOn` says. */
export const BulkyScheduleListQuery = ProjectScopedListQuery.extend({ planningAreaId: Id.optional(), validOn: IsoDate.optional() })
export type BulkyScheduleListQuery = z.infer<typeof BulkyScheduleListQuery>

/** One item a booking lists: what it is, and how many. */
export const BulkyItem = z.strictObject({
  description: Label,
  quantity: PositiveInt.max(BULKY_ITEM_QUANTITY_MAX),
})
export type BulkyItem = z.infer<typeof BulkyItem>

const Items = z.array(BulkyItem).min(1).max(BULKY_ITEMS_MAX)

/** The stop that names a booking now: its planned one, or the one that collected it. */
export const BulkyStop = z.object({ pickupId: Id, routeId: Id, status: PickupStatus })
export type BulkyStop = z.infer<typeof BulkyStop>

export const BulkyBooking = z.object({
  ...stamped,
  projectId: Id,
  customerId: Id,
  agreementId: Id,
  propertyId: Id.nullable(),
  sharedCollectionPointId: Id.nullable(),
  wasteFractionId: Id,
  day: IsoDate,
  items: z.array(BulkyItem),
  note: Paragraph.nullable(),
  status: BulkyBookingStatus,
  /** The planning area the place lay in, the schedule whose slot it takes, and the product it is charged at, as on the day it was booked. */
  planningAreaId: Id,
  scheduleId: Id,
  productId: Id,
  /** Its live stop; null while booked or cancelled. */
  stop: BulkyStop.nullable(),
  bookedBy: Id.nullable(),
  cancelledAt: IsoDateTime.nullable(),
  cancelledBy: Id.nullable(),
  cancelReason: Paragraph.nullable(),
})
export type BulkyBooking = z.infer<typeof BulkyBooking>

/** What a booking naming no place, or two, is told. */
export const ONE_PLACE = "Name a property or a shared collection point, one of the two"
const onePlace = (body: { propertyId?: string | null; sharedCollectionPointId?: string | null }): boolean => (body.propertyId != null) !== (body.sharedCollectionPointId != null)

/** `POST /bulky-bookings`: the customer, the place, the agreement charged, the day, the fraction and the items. */
export const BulkyBookingCreate = z
  .strictObject({
    customerId: Id,
    agreementId: Id,
    propertyId: Id.nullable().optional(),
    sharedCollectionPointId: Id.nullable().optional(),
    wasteFractionId: Id,
    day: IsoDate,
    items: Items,
    note: Paragraph.nullable().optional(),
  })
  .refine(onePlace, { message: ONE_PLACE, path: ["propertyId"] })
export type BulkyBookingCreate = z.infer<typeof BulkyBookingCreate>

/** A booked booking's day, judged again, its items replaced whole, and its note. */
export const BulkyBookingPatch = z
  .strictObject({
    day: IsoDate.optional(),
    items: Items.optional(),
    note: Paragraph.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type BulkyBookingPatch = z.infer<typeof BulkyBookingPatch>

/** `POST /bulky-bookings/:id/cancel`: why. */
export const BulkyBookingCancel = z.strictObject({ reason: Paragraph })
export type BulkyBookingCancel = z.infer<typeof BulkyBookingCancel>

/** A page of bookings: one project's, of one status, customer, place or area, over a window of their days. */
export const BulkyBookingListQuery = ProjectScopedListQuery.extend({
  status: BulkyBookingStatus.optional(),
  customerId: Id.optional(),
  propertyId: Id.optional(),
  sharedCollectionPointId: Id.optional(),
  planningAreaId: Id.optional(),
  /** The first day of the window over the booking's day, inclusive. */
  from: IsoDate.optional(),
  /** The last day, inclusive. */
  to: IsoDate.optional(),
}).refine(dayWindowOrdered, dayWindowIsOrdered)
export type BulkyBookingListQuery = z.infer<typeof BulkyBookingListQuery>

/** What a window wider than an availability read takes is told. */
export const WINDOW_TOO_WIDE = `Ask for ${BULKY_WINDOW_DAYS_MAX} days at most`
const spanDays = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1

/** `GET /bulky-bookings/availability`: the place, optionally under the project it is of, and the window of days, both ends included. */
export const BulkyAvailabilityQuery = z
  .strictObject({
    projectId: Id.optional(),
    propertyId: Id.optional(),
    sharedCollectionPointId: Id.optional(),
    from: IsoDate,
    to: IsoDate,
  })
  .refine(onePlace, { message: ONE_PLACE, path: ["propertyId"] })
  .refine(dayWindowOrdered, dayWindowIsOrdered)
  .refine((query) => query.to < query.from || spanDays(query.from, query.to) <= BULKY_WINDOW_DAYS_MAX, { message: WINDOW_TOO_WIDE, path: ["to"] })
export type BulkyAvailabilityQuery = z.infer<typeof BulkyAvailabilityQuery>

/** One day the place may be booked on, with its slots, and the schedule and area they are counted under. */
export const BulkyAvailableDay = z.object({
  day: IsoDate,
  slots: PositiveInt,
  booked: NonNegativeInt,
  left: NonNegativeInt,
  planningAreaId: Id,
  scheduleId: Id,
})
export type BulkyAvailableDay = z.infer<typeof BulkyAvailableDay>

/** The place's days in the window, in date order: each one after the project's today, full ones included with none left. */
export const BulkyAvailability = z.object({ days: z.array(BulkyAvailableDay) })
export type BulkyAvailability = z.infer<typeof BulkyAvailability>
