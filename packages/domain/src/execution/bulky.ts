// Bulky-waste booking (O11 of #290): which days a Planning Area's Bulky
// Schedule collects on, how many slots each has left, and where a Bulky
// Booking stands. Pure, so the office's form, the API's availability read and
// the booking's own judgement are one rule.
//
// A schedule's days are `generateOccurrences` over its recurrence, the Route
// Scheme's own: a skipped occurrence is no day, and a shifted one is offered
// on the day it moved to, since that is the day the truck comes. The period
// is half-open (ADR-0005), so its last day in is one before `validTo`. A day
// is bookable after the project's today, while it has a slot left; every
// booking takes one slot, whatever its items.
//
// Once collected, a booking is charged at the product its schedule names: as
// one job for a product sold by the `job`, or at its items' count, the sum of
// its lines' quantities, for one sold by the `item` (#449), so a sofa and two
// mattresses are three. One product prices every item of the booking; a
// price per kind of item would make each line name a product, which is not
// built.
//
// A booking's status is read off its cancel stamp and the stop that names it:
// a planned stop routes it, a completed one collected it, and a stop skipped
// or failed leaves it booked again, the office's to move and route anew.
import { generateOccurrences, SHIFT_SEARCH_DAYS, type HolidayPolicy, type SchemeCalendar } from "../route-schemes/occurrences"
import { addDays, type ServiceDay, type WeekRotation } from "../route-schemes/recurrence"
import type { RecurrenceFrequency } from "../planning/vocabulary"
import type { ProductUnit } from "../registry/vocabulary"
import type { BulkyBookingStatus, PickupStatus } from "./vocabulary"

/** The most items one booking lists. */
export const BULKY_ITEMS_MAX = 20
/** The most of one item a booking lists. */
export const BULKY_ITEM_QUANTITY_MAX = 100
/** The most days one availability read spans, both ends included. */
export const BULKY_WINDOW_DAYS_MAX = 92

/** The units a bulky collection is charged by (#449): the booking as one job, or each of its items. */
export const BULKY_PRODUCT_UNITS = ["job", "item"] as const satisfies readonly ProductUnit[]

/** Whether a product of this unit may charge a bulky collection. */
export const isBulkyProductUnit = (unit: ProductUnit): boolean => (BULKY_PRODUCT_UNITS as readonly ProductUnit[]).includes(unit)

/** What a schedule naming a product of another unit is told. */
export const A_BULKY_PRODUCT_IS_SOLD_BY_THE_JOB_OR_ITEM = "A bulky collection is charged at a product sold by the job or by the item"

/** How many of the product a collected booking is charged: its items' count for a product sold by the item, one job otherwise. */
export function bulkyQuantity(unit: ProductUnit, items: readonly { quantity: number }[]): number {
  return unit === "item" ? items.reduce((total, item) => total + item.quantity, 0) : 1
}

/** A Bulky Schedule as its days are judged: the recurrence, the holiday policy, the half-open period and the slots per day. */
export type BulkySchedule = {
  frequency: RecurrenceFrequency
  serviceDays: readonly ServiceDay[]
  weekRotation: WeekRotation | null
  holidayPolicy: HolidayPolicy
  validFrom: string
  /** The first day out of force; null while open-ended. */
  validTo: string | null
  slotsPerDay: number
}

/** One day a schedule collects on, with its slots: how many it has, how many bookings hold one, and how many are left (never below none). */
export type BulkyDay = { day: string; slots: number; booked: number; left: number }

/**
 * The days a schedule collects on inside the window, both ends included,
 * in date order, each with its slots: `generateOccurrences` over the
 * schedule's recurrence clipped to its period, a skipped occurrence dropped,
 * a shifted one on the day it moved to — from a date outside the window too. `booked` counts the live bookings
 * by day.
 */
export function bulkyDays(schedule: BulkySchedule, calendar: SchemeCalendar, window: { from: string; to: string }, booked: ReadonlyMap<string, number>): BulkyDay[] {
  const lastIn = schedule.validTo === null ? null : addDays(schedule.validTo, -1)
  // A shift may carry an occurrence into the window from a date outside it, so the walk reaches as far either side as a shift may.
  const reachFrom = addDays(window.from, -SHIFT_SEARCH_DAYS)
  const reachTo = addDays(window.to, SHIFT_SEARCH_DAYS)
  const from = reachFrom > schedule.validFrom ? reachFrom : schedule.validFrom
  const to = lastIn !== null && lastIn < reachTo ? lastIn : reachTo
  if (to < from) return []
  const rows = generateOccurrences({
    recurrence: {
      frequency: schedule.frequency,
      serviceDays: [...schedule.serviceDays],
      ...(schedule.weekRotation === null ? {} : { weekRotation: schedule.weekRotation }),
      effectiveFrom: schedule.validFrom,
      effectiveTo: lastIn ?? "",
    },
    window: { from, to },
    holidayPolicy: schedule.holidayPolicy,
    calendar,
  })
  const days = new Set<string>()
  for (const row of rows) if (row.status !== "skipped" && row.date >= window.from && row.date <= window.to) days.add(row.date)
  return [...days].sort().map((day) => {
    const taken = booked.get(day) ?? 0
    return { day, slots: schedule.slotsPerDay, booked: taken, left: Math.max(0, schedule.slotsPerDay - taken) }
  })
}

/** What a day that is no collection day of the place's schedule is told. */
export const notABulkyDay = (day: string): string => `${day} is not a bulky collection day where this place is`
/** What a day with no slot left is told. */
export const dayFull = (day: string): string => `${day} is fully booked: every bulky collection slot that day is taken`
/** What a day on or before the project's today is told. */
export const notAfterToday = (today: string): string => `A bulky collection is booked for a day after today, ${today}`

/**
 * Whether a booking may take a slot on the day: after the project's today,
 * one of the schedule's days, and one with a slot left — the sentence that
 * refuses it otherwise, in that order.
 */
export function refuseBulkyDay(days: readonly BulkyDay[], day: string, today: string): string | undefined {
  if (day <= today) return notAfterToday(today)
  const found = days.find((candidate) => candidate.day === day)
  if (found === undefined) return notABulkyDay(day)
  if (found.left === 0) return dayFull(day)
  return undefined
}

/** Where a booking stands: cancelled by its stamp, else by the status of its live stop — planned routes it, completed collected it — and booked with none. */
export function bulkyBookingStatus(booking: { cancelledAt: unknown; stopStatus: PickupStatus | null }): BulkyBookingStatus {
  if (booking.cancelledAt !== null && booking.cancelledAt !== undefined) return "cancelled"
  if (booking.stopStatus === "planned") return "routed"
  if (booking.stopStatus === "completed") return "collected"
  return "booked"
}

/** The stop statuses that keep a booking's stop live: one planned or completed per booking, which the database holds too. */
export const LIVE_STOP_STATUSES = ["planned", "completed"] as const satisfies readonly PickupStatus[]

/** The commands a booking's status gates, as a sentence names each. */
export type BulkyCommand = "route" | "cancel" | "change"
const DONE: Readonly<Record<BulkyCommand, string>> = { route: "routed", cancel: "cancelled", change: "changed" }

/** What a command a booking's status refuses is told: only a booked one is moved, routed or cancelled. */
export const onlyABookedBooking = (status: BulkyBookingStatus, command: BulkyCommand): string =>
  status === "routed" ? `The booking is routed already; take its stop off the route before it can be ${DONE[command]}` : `The booking is ${status}; only a booked one can be ${DONE[command]}`

/** What a stop added for a booking on a route of another day is told. */
export const notTheBookingsDay = (day: string, operatingDate: string): string => `The booking is for ${day}, and the route runs on ${operatingDate}`

/** What a place outside every scheduled area is told. */
export const NO_BULKY_SCHEDULE = "No bulky collection is scheduled for the planning area this place lies in"
/** What a place with no location is told: its planning area cannot be found. */
export const NO_LOCATION = "The place has no location, so the planning area its bulky collection days come from cannot be found"
