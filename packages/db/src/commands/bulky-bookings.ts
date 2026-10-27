// The door of bulky-waste booking (O11 of #290): which days a place may be
// booked on, and the booking that takes a slot of one. The office's routes
// (apps/api/src/routes/bulky-bookings.ts) call both, and the citizen portal
// (#383) is to call the same two for a signed-in customer's own places and
// agreement, behind its own fence: the rules of a booking live here, never in
// a route alone.
//
// A place's days are the days of the Bulky Schedule of the planning area it
// lies in (`@waste/domain/execution/bulky`): its location inside the area's
// boundary in force on the day, under a schedule in force that day. Areas may
// overlap, so a day is governed by the lowest area code's schedule in force
// that day, and offered only where that schedule collects. A day's
// slots are counted over the bookings not cancelled that hold one of its
// schedule's slots that day, whatever their stop did; a booking takes its
// slot under the schedule's row lock, so two bookings of the last slot take
// turns and the second is told the day is full.
//
// The caller has proved the ids are the project's — the customer, the
// agreement, the place, the fraction — and answered a 400 for any that is
// not; what is judged here is what the rows say: the agreement signed, the
// customer's and in force on the day, the place one it serves that day, then
// the day itself. Each refusal is a 409 `Refused` in the domain's sentence.
import { bulkyDays, dayFull, NO_BULKY_SCHEDULE, NO_LOCATION, refuseBulkyDay, type BulkySchedule } from "@waste/domain/execution/bulky"
import type { RecurrenceFrequency } from "@waste/domain/planning/vocabulary"
import { holidayListOf } from "@waste/domain/planning/generation"
import { SHIFT_SEARCH_DAYS, type HolidayPolicy, type SchemeCalendar } from "@waste/domain/route-schemes/occurrences"
import { addDays, type ServiceDay, type WeekRotation } from "@waste/domain/route-schemes/recurrence"
import { and, asc, count, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm"

import type { Tx } from "../client"
import { validOn } from "../query/valid-on"
import { agreement, subscription } from "../schema/agreements"
import { bulkyBooking, bulkyBookingItem, bulkySchedule } from "../schema/bulky"
import { collectionCalendarHoliday } from "../schema/collection-calendars"
import { property, sharedCollectionPoint } from "../schema/customers"
import { project } from "../schema/organisation"
import { planningArea, planningAreaBoundary } from "../schema/planning-areas"
import type { Scope } from "./project-clock"
import { lockRow, refused, RefusedField } from "./shared"

/** A booking's place: a property or a shared collection point, one of the two. */
export type BulkyPlace = { propertyId: string | null; sharedCollectionPointId: string | null }

/** One day a place may be booked on, with the schedule and the area its slots are counted under. */
export type BulkyPlaceDay = { day: string; slots: number; booked: number; left: number; planningAreaId: string; scheduleId: string }

/** What an agreement that is not signed is told. */
export const agreementNotSigned = (number: string, status: string): string => `Agreement ${number} is ${status}; a bulky collection is charged to a signed one`
/** What an agreement out of force on the day is told. */
export const agreementNotInForce = (number: string, day: string): string => `Agreement ${number} is not in force on ${day}`
/** What an agreement of another customer is told. */
export const NOT_THE_CUSTOMERS = "The agreement is not this customer's"
/** What a place the agreement serves nothing at is told. */
export const notServedUnder = (number: string, day: string): string => `Agreement ${number} serves nothing at this place on ${day}`

/** The place's point, as the boundary is asked about it; null where the place has none. */
async function locationOf(tx: Tx, scope: Scope, place: BulkyPlace): Promise<SQL | null> {
  const [row] =
    place.propertyId !== null
      ? await tx
          .select({ located: sql<boolean>`${property.location} is not null` })
          .from(property)
          .where(and(eq(property.companyId, scope.companyId), eq(property.projectId, scope.projectId), eq(property.id, place.propertyId)))
          .limit(1)
      : await tx
          .select({ located: sql<boolean>`${sharedCollectionPoint.location} is not null` })
          .from(sharedCollectionPoint)
          .where(and(eq(sharedCollectionPoint.companyId, scope.companyId), eq(sharedCollectionPoint.projectId, scope.projectId), eq(sharedCollectionPoint.id, place.sharedCollectionPointId ?? "")))
          .limit(1)
  if (row === undefined || !row.located) return null
  return place.propertyId !== null
    ? sql`(select ${property.location} from ${property} where ${property.companyId} = ${scope.companyId} and ${property.id} = ${place.propertyId})`
    : sql`(select ${sharedCollectionPoint.location} from ${sharedCollectionPoint} where ${sharedCollectionPoint.companyId} = ${scope.companyId} and ${sharedCollectionPoint.id} = ${place.sharedCollectionPointId})`
}

/** The project's calendar near the window: its weekend, and its holidays, named as generation names them, as far either side as the walk of `bulkyDays` and a shift from its edge may reach. */
async function calendarNear(tx: Tx, scope: Scope, window: { from: string; to: string }): Promise<SchemeCalendar> {
  const [row] = await tx
    .select({ weekend: project.weekend, holidayList: project.holidayList })
    .from(project)
    .where(and(eq(project.companyId, scope.companyId), eq(project.id, scope.projectId)))
    .limit(1)
  if (row === undefined) throw new Error(`calendarNear: no project ${scope.projectId}`)
  const holidays =
    row.holidayList === null
      ? []
      : await tx
          .select({ day: collectionCalendarHoliday.day, name: collectionCalendarHoliday.name })
          .from(collectionCalendarHoliday)
          .where(
            and(
              eq(collectionCalendarHoliday.companyId, scope.companyId),
              eq(collectionCalendarHoliday.projectId, scope.projectId),
              gte(collectionCalendarHoliday.day, addDays(window.from, -2 * SHIFT_SEARCH_DAYS)),
              lte(collectionCalendarHoliday.day, addDays(window.to, 2 * SHIFT_SEARCH_DAYS)),
            ),
          )
  return { weekend: row.weekend as ServiceDay[], holidays: holidayListOf(holidays, row.holidayList) }
}

/** A day of the place with what a booking of it freezes: its schedule's product too. */
type PlaceDay = BulkyPlaceDay & { productId: string }

/**
 * The days a place may be booked on inside the window, both ends included,
 * after the project's today, in date order: each day of the schedule
 * governing the place that day, with its slots. A day is governed by the
 * schedule in force that day of the lowest area code among the areas holding
 * the place that day, and is offered only where that schedule collects. A
 * place with no location, or in no scheduled area over the whole window, is
 * refused (409).
 */
export async function bulkyDaysAt(tx: Tx, scope: Scope, place: BulkyPlace, window: { from: string; to: string }, today: string): Promise<BulkyPlaceDay[]> {
  return (await placeDays(tx, scope, place, window, today)).map(({ productId: _product, ...day }) => day)
}

async function placeDays(tx: Tx, scope: Scope, place: BulkyPlace, window: { from: string; to: string }, today: string): Promise<PlaceDay[]> {
  const location = await locationOf(tx, scope, place)
  if (location === null) throw refused(409, NO_LOCATION)
  // The schedules in force over the window, each with the periods its area's boundary held the place.
  const reaching = await tx
    .select({
      schedule: {
        id: bulkySchedule.id,
        planningAreaId: bulkySchedule.planningAreaId,
        frequency: bulkySchedule.frequency,
        serviceDays: bulkySchedule.serviceDays,
        weekRotation: bulkySchedule.weekRotation,
        holidayPolicy: bulkySchedule.holidayPolicy,
        validFrom: bulkySchedule.validFrom,
        validTo: bulkySchedule.validTo,
        slotsPerDay: bulkySchedule.slotsPerDay,
        productId: bulkySchedule.productId,
      },
      code: planningArea.code,
      boundaryFrom: planningAreaBoundary.validFrom,
      boundaryTo: planningAreaBoundary.validTo,
    })
    .from(bulkySchedule)
    .innerJoin(planningArea, and(eq(planningArea.companyId, bulkySchedule.companyId), eq(planningArea.id, bulkySchedule.planningAreaId)))
    .innerJoin(planningAreaBoundary, and(eq(planningAreaBoundary.companyId, bulkySchedule.companyId), eq(planningAreaBoundary.planningAreaId, bulkySchedule.planningAreaId)))
    .where(
      and(
        eq(bulkySchedule.companyId, scope.companyId),
        eq(bulkySchedule.projectId, scope.projectId),
        lte(bulkySchedule.validFrom, window.to),
        or(isNull(bulkySchedule.validTo), sql`${bulkySchedule.validTo} > ${window.from}`),
        lte(planningAreaBoundary.validFrom, window.to),
        or(isNull(planningAreaBoundary.validTo), sql`${planningAreaBoundary.validTo} > ${window.from}`),
        sql`extensions.st_contains(${planningAreaBoundary.boundary}, ${location})`,
      ),
    )
    .orderBy(asc(planningArea.code), asc(bulkySchedule.id))
  if (reaching.length === 0) throw refused(409, NO_BULKY_SCHEDULE)

  // In area-code order: the first schedule in force holding the place on a day governs it.
  const scheduleIds = [...new Set(reaching.map((row) => row.schedule.id))]
  const governs = (id: string, day: string): boolean =>
    reaching.some(
      (row) =>
        row.schedule.id === id &&
        row.schedule.validFrom <= day &&
        (row.schedule.validTo === null || row.schedule.validTo > day) &&
        row.boundaryFrom <= day &&
        (row.boundaryTo === null || row.boundaryTo > day),
    )
  const governing = (day: string): string | undefined => scheduleIds.find((id) => governs(id, day))

  const counted = await tx
    .select({ scheduleId: bulkyBooking.scheduleId, day: bulkyBooking.day, booked: count() })
    .from(bulkyBooking)
    .where(and(eq(bulkyBooking.companyId, scope.companyId), inArray(bulkyBooking.scheduleId, scheduleIds), gte(bulkyBooking.day, window.from), lte(bulkyBooking.day, window.to), isNull(bulkyBooking.cancelledAt)))
    .groupBy(bulkyBooking.scheduleId, bulkyBooking.day)
  const calendar = await calendarNear(tx, scope, window)

  const days: PlaceDay[] = []
  for (const id of scheduleIds) {
    const { schedule } = reaching.find((row) => row.schedule.id === id)!
    const booked = new Map(counted.filter((row) => row.scheduleId === id).map((row) => [row.day, row.booked]))
    const recurring: BulkySchedule = {
      frequency: schedule.frequency as RecurrenceFrequency,
      serviceDays: schedule.serviceDays as ServiceDay[],
      weekRotation: schedule.weekRotation as WeekRotation | null,
      holidayPolicy: schedule.holidayPolicy as HolidayPolicy,
      validFrom: schedule.validFrom,
      validTo: schedule.validTo,
      slotsPerDay: schedule.slotsPerDay,
    }
    for (const day of bulkyDays(recurring, calendar, window, booked)) {
      if (day.day > today && governing(day.day) === id) days.push({ ...day, planningAreaId: schedule.planningAreaId, scheduleId: id, productId: schedule.productId })
    }
  }
  return days.sort((a, b) => a.day.localeCompare(b.day))
}

/** What a booking is made of, the caller having proved each id the project's. */
export type BulkyBookingInput = {
  customerId: string
  agreementId: string
  place: BulkyPlace
  wasteFractionId: string
  day: string
  items: readonly { description: string; quantity: number }[]
  note: string | null
  /** The person booking it; null where no person of the company does. */
  bookedBy: string | null
}

/**
 * The agreement a booking is charged to, judged on the day: the customer's
 * (400 at `customerId`, the body's own field), signed, in force, and serving
 * the place that day (409 each, in that order); with `customerOnly`, the
 * first alone.
 */
export async function requireChargeableAgreement(tx: Tx, scope: Scope, input: Pick<BulkyBookingInput, "customerId" | "agreementId" | "place" | "day">, { customerOnly = false }: { customerOnly?: boolean } = {}): Promise<void> {
  const [row] = await tx
    .select({ number: agreement.number, customerId: agreement.customerId, status: agreement.status, inForce: sql<boolean>`${validOn(agreement, input.day)}` })
    .from(agreement)
    .where(and(eq(agreement.companyId, scope.companyId), eq(agreement.projectId, scope.projectId), eq(agreement.id, input.agreementId)))
    .limit(1)
  if (row === undefined) throw new Error(`requireChargeableAgreement: agreement ${input.agreementId} was proved the project's and then not there`)
  if (row.customerId !== input.customerId) throw new RefusedField("customerId", NOT_THE_CUSTOMERS)
  // The customer alone: a caller asking its 400s before the 409s of the rows.
  if (customerOnly) return
  if (row.status !== "active") throw refused(409, agreementNotSigned(row.number, row.status))
  if (!row.inForce) throw refused(409, agreementNotInForce(row.number, input.day))
  const [serving] = await tx
    .select({ id: subscription.id })
    .from(subscription)
    .where(
      and(
        eq(subscription.companyId, scope.companyId),
        eq(subscription.agreementId, input.agreementId),
        input.place.propertyId !== null ? eq(subscription.propertyId, input.place.propertyId) : eq(subscription.sharedCollectionPointId, input.place.sharedCollectionPointId ?? ""),
        validOn(subscription, input.day),
      ),
    )
    .limit(1)
  if (serving === undefined) throw refused(409, notServedUnder(row.number, input.day))
}

/**
 * The day a booking takes a slot of, judged under its schedule's row lock:
 * the place's day after today with a slot left (409 in the domain's
 * sentence otherwise). Answers the day with its schedule, area and product.
 */
export async function takeBulkySlot(tx: Tx, scope: Scope, place: BulkyPlace, day: string, today: string): Promise<{ scheduleId: string; planningAreaId: string; productId: string }> {
  const days = await placeDays(tx, scope, place, { from: day, to: day }, today)
  const before = refuseBulkyDay(days, day, today)
  if (before !== undefined) throw refused(409, before)
  const found = days.find((candidate) => candidate.day === day)!
  await lockRow(tx, bulkySchedule, { companyId: scope.companyId, id: found.scheduleId })
  // Counted again under the lock: a booking that took the last slot meanwhile is counted now.
  const [{ booked }] = await tx
    .select({ booked: count() })
    .from(bulkyBooking)
    .where(and(eq(bulkyBooking.companyId, scope.companyId), eq(bulkyBooking.scheduleId, found.scheduleId), eq(bulkyBooking.day, day), isNull(bulkyBooking.cancelledAt)))
  if (booked >= found.slots) throw refused(409, dayFull(day))
  return { scheduleId: found.scheduleId, planningAreaId: found.planningAreaId, productId: found.productId }
}

/** The booking made: the agreement judged, the slot taken, the row and its items written. Answers its id. */
export async function bookBulky(tx: Tx, scope: Scope, id: string, input: BulkyBookingInput, today: string): Promise<string> {
  await requireChargeableAgreement(tx, scope, input)
  const slot = await takeBulkySlot(tx, scope, input.place, input.day, today)
  await tx.insert(bulkyBooking).values({
    id,
    ...scope,
    customerId: input.customerId,
    agreementId: input.agreementId,
    propertyId: input.place.propertyId,
    sharedCollectionPointId: input.place.sharedCollectionPointId,
    wasteFractionId: input.wasteFractionId,
    day: input.day,
    ...slot,
    note: input.note,
    bookedBy: input.bookedBy,
  })
  await replaceBulkyItems(tx, scope, id, input.items)
  return id
}

/** A booking's items replaced whole, in the order listed. */
export async function replaceBulkyItems(tx: Tx, scope: Scope, bookingId: string, items: readonly { description: string; quantity: number }[]): Promise<void> {
  await tx.delete(bulkyBookingItem).where(and(eq(bulkyBookingItem.companyId, scope.companyId), eq(bulkyBookingItem.bookingId, bookingId)))
  if (items.length > 0) await tx.insert(bulkyBookingItem).values(items.map((item, index) => ({ ...scope, bookingId, position: index + 1, description: item.description, quantity: item.quantity })))
}

/** Each booking's items in the order listed. */
export async function bulkyItemsOf(tx: Tx, companyId: string, bookingIds: readonly string[]): Promise<Map<string, { description: string; quantity: number }[]>> {
  const items = new Map<string, { description: string; quantity: number }[]>()
  if (bookingIds.length === 0) return items
  const rows = await tx
    .select({ bookingId: bulkyBookingItem.bookingId, description: bulkyBookingItem.description, quantity: bulkyBookingItem.quantity })
    .from(bulkyBookingItem)
    .where(and(eq(bulkyBookingItem.companyId, companyId), inArray(bulkyBookingItem.bookingId, [...bookingIds])))
    .orderBy(asc(bulkyBookingItem.bookingId), asc(bulkyBookingItem.position))
  for (const row of rows) items.set(row.bookingId, [...(items.get(row.bookingId) ?? []), { description: row.description, quantity: row.quantity }])
  return items
}

