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
import { BULKY_ITEM_QUANTITY_MAX, BULKY_ITEMS_MAX, BULKY_SLOTS_PER_DAY_MAX, BULKY_WINDOW_DAYS_MAX, ONE_PLACE, WINDOW_TOO_WIDE } from "@waste/domain/execution/bulky"
import { BULKY_BOOKING_STATUSES } from "@waste/domain/execution/vocabulary"
import { weekRotationShape, WEEK_ROTATION_WITH_FORTNIGHTLY } from "@waste/domain/planning/schemes"
import { placesNamed } from "@waste/domain/registry/served-places"
import * as z from "zod"

import { IsoDate, IsoDateTime } from "./dates"
import { PickupStatus } from "./execution"
import { Id } from "./ids"
import { HolidayPolicy, RecurrenceFrequency, ServiceDays, WeekRotation } from "./planning"
import { dayWindow, ProjectScopedListQuery, requiredDayWindow } from "./queries"
import { NonNegativeInt, PositiveInt, resourceBodies, stamped } from "./resource"
import { Label, Paragraph } from "./text"
import { effectiveDated, effectiveDatedBodies } from "./validity"

/** Where a booking stands: booked, routed by a planned stop, collected by a completed one, or cancelled. */
export const BulkyBookingStatus = z.enum(BULKY_BOOKING_STATUSES)
export type BulkyBookingStatus = z.infer<typeof BulkyBookingStatus>

const weekRotationWithFortnightly = { message: WEEK_ROTATION_WITH_FORTNIGHTLY, path: ["weekRotation"] }

const SlotsPerDay = PositiveInt.max(BULKY_SLOTS_PER_DAY_MAX)

export const BulkySchedule = effectiveDated(
  z.object({
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
  }),
)
export type BulkySchedule = z.infer<typeof BulkySchedule>

/** A patch moves the slots, the product and the end, a null end reopening the schedule; the area and the recurrence are the schedule's key and its start its period's — end it and add another. */
const bulkyScheduleBodies = effectiveDatedBodies(
  {
    projectId: Id,
    planningAreaId: Id,
    frequency: RecurrenceFrequency,
    serviceDays: ServiceDays.min(1),
    weekRotation: WeekRotation.nullable().optional(),
    holidayPolicy: HolidayPolicy.default("skip"),
    slotsPerDay: SlotsPerDay,
    productId: Id,
  },
  { createOnly: { projectId: true, planningAreaId: true, frequency: true, serviceDays: true, weekRotation: true, holidayPolicy: true, validFrom: true } },
)

export const BulkyScheduleCreate = bulkyScheduleBodies.create.refine(weekRotationShape, weekRotationWithFortnightly)
export type BulkyScheduleCreate = z.infer<typeof BulkyScheduleCreate>

export const BulkySchedulePatch = bulkyScheduleBodies.patch
export type BulkySchedulePatch = z.infer<typeof BulkySchedulePatch>

export const BulkyScheduleListQuery = ProjectScopedListQuery.extend({ planningAreaId: Id.optional(), validOn: IsoDate.optional() })
export type BulkyScheduleListQuery = z.infer<typeof BulkyScheduleListQuery>

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

const onePlace = (body: { propertyId?: string | null; sharedCollectionPointId?: string | null }): boolean => placesNamed(body) === 1

/** `POST /bulky-bookings`: the customer, the place, the agreement charged, the day, the fraction and the items. A patch moves a booked booking's day, judged again, replaces its items whole, or changes its note. */
const bulkyBookingBodies = resourceBodies(
  {
    customerId: Id,
    agreementId: Id,
    propertyId: Id.nullable().optional(),
    sharedCollectionPointId: Id.nullable().optional(),
    wasteFractionId: Id,
    day: IsoDate,
    items: Items,
    note: Paragraph.nullable().optional(),
  },
  { createOnly: { customerId: true, agreementId: true, propertyId: true, sharedCollectionPointId: true, wasteFractionId: true } },
)

export const BulkyBookingCreate = bulkyBookingBodies.create.refine(onePlace, { message: ONE_PLACE, path: ["propertyId"] })
export type BulkyBookingCreate = z.infer<typeof BulkyBookingCreate>

export const BulkyBookingPatch = bulkyBookingBodies.patch
export type BulkyBookingPatch = z.infer<typeof BulkyBookingPatch>

/** `POST /bulky-bookings/:id/cancel`: why. */
export const BulkyBookingCancel = z.strictObject({ reason: Paragraph })
export type BulkyBookingCancel = z.infer<typeof BulkyBookingCancel>

/** A page of bookings: one project's, of one status, customer, place or area, over a window of their days. */
export const BulkyBookingListQuery = dayWindow(
  ProjectScopedListQuery.extend({
    status: BulkyBookingStatus.optional(),
    customerId: Id.optional(),
    propertyId: Id.optional(),
    sharedCollectionPointId: Id.optional(),
    planningAreaId: Id.optional(),
  }),
)
export type BulkyBookingListQuery = z.infer<typeof BulkyBookingListQuery>

/** `GET /bulky-bookings/availability`: the place, optionally under the project it is of, and the window of days, both ends included. */
export const BulkyAvailabilityQuery = requiredDayWindow(
  z
    .strictObject({
      projectId: Id.optional(),
      propertyId: Id.optional(),
      sharedCollectionPointId: Id.optional(),
    })
    .refine(onePlace, { message: ONE_PLACE, path: ["propertyId"] }),
  { maxDays: { days: BULKY_WINDOW_DAYS_MAX, tooLong: WINDOW_TOO_WIDE } },
)
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
