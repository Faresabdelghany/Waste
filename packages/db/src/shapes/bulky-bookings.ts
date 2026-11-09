// A bulky booking on the wire (O11 of #290): the columns with its live stop
// joined (`selectBookings`), the row type, its items, and `bookingOf`, which
// the office's reads answer and `bulky-booking-booked` and
// `bulky-booking-cancelled` carry.
import type { BulkyBooking, BulkyStop } from "@waste/contracts/bulky"
import { bulkyBookingStatus } from "@waste/domain/execution/bulky"
import { LIVE_STOP_STATUSES, type BulkyBookingStatus } from "@waste/domain/execution/vocabulary"
import { and, asc, eq, inArray, isNotNull, isNull, type SQL, type SQLWrapper } from "drizzle-orm"

import type { Tx } from "../client"
import { bulkyBooking, bulkyBookingItem } from "../schema/bulky"
import { pickup } from "../schema/execution"
import { instantOf, stampsOf } from "./times"

/** The planned or completed stop naming a booking: at most one, which `pickup_bulky_booking_id_key` holds. */
export const liveStop = and(eq(pickup.companyId, bulkyBooking.companyId), eq(pickup.bulkyBookingId, bulkyBooking.id), inArray(pickup.status, LIVE_STOP_STATUSES))

/** What a booking's status reads: its cancellation stamp and its live stop's id and status, the booking's and `liveStop`'s columns unless a test names others. */
type StatusColumns = { cancelledAt: SQLWrapper; stopId: SQLWrapper; stopStatus: SQLWrapper }

/** `bulkyBookingStatus` as a condition over a booking and its live stop (`liveStop`): the stamp, then the stop. */
export function bookingStatusIs(status: BulkyBookingStatus, { cancelledAt, stopId, stopStatus }: StatusColumns = { cancelledAt: bulkyBooking.cancelledAt, stopId: pickup.id, stopStatus: pickup.status }): SQL | undefined {
  switch (status) {
    case "cancelled":
      return isNotNull(cancelledAt)
    case "routed":
      return and(isNull(cancelledAt), eq(stopStatus, "planned"))
    case "collected":
      return and(isNull(cancelledAt), eq(stopStatus, "completed"))
    case "booked":
      return and(isNull(cancelledAt), isNull(stopId))
  }
}

export const bookingColumns = {
  id: bulkyBooking.id,
  projectId: bulkyBooking.projectId,
  customerId: bulkyBooking.customerId,
  agreementId: bulkyBooking.agreementId,
  propertyId: bulkyBooking.propertyId,
  sharedCollectionPointId: bulkyBooking.sharedCollectionPointId,
  wasteFractionId: bulkyBooking.wasteFractionId,
  day: bulkyBooking.day,
  planningAreaId: bulkyBooking.planningAreaId,
  scheduleId: bulkyBooking.scheduleId,
  productId: bulkyBooking.productId,
  note: bulkyBooking.note,
  bookedBy: bulkyBooking.bookedBy,
  cancelledAt: bulkyBooking.cancelledAt,
  cancelledBy: bulkyBooking.cancelledBy,
  cancelReason: bulkyBooking.cancelReason,
  createdAt: bulkyBooking.createdAt,
  updatedAt: bulkyBooking.updatedAt,
  stopId: pickup.id,
  stopRouteId: pickup.routeId,
  stopStatus: pickup.status,
}

export const stopOf = (row: BookingRow): BulkyStop | null => (row.stopId === null || row.stopRouteId === null || row.stopStatus === null ? null : { pickupId: row.stopId, routeId: row.stopRouteId, status: row.stopStatus })

export const statusOf = (row: BookingRow): BulkyBookingStatus => bulkyBookingStatus({ cancelledAt: row.cancelledAt, stopStatus: row.stopStatus })

export function bookingOf(row: BookingRow, items: readonly { description: string; quantity: number }[]): BulkyBooking {
  return {
    id: row.id,
    projectId: row.projectId,
    customerId: row.customerId,
    agreementId: row.agreementId,
    propertyId: row.propertyId,
    sharedCollectionPointId: row.sharedCollectionPointId,
    wasteFractionId: row.wasteFractionId,
    day: row.day,
    items: [...items],
    note: row.note,
    status: statusOf(row),
    planningAreaId: row.planningAreaId,
    scheduleId: row.scheduleId,
    productId: row.productId,
    stop: stopOf(row),
    bookedBy: row.bookedBy,
    cancelledAt: instantOf(row.cancelledAt),
    cancelledBy: row.cancelledBy,
    cancelReason: row.cancelReason,
    ...stampsOf(row),
  }
}

export const selectBookings = (tx: Tx) => tx.select(bookingColumns).from(bulkyBooking).leftJoin(pickup, liveStop)

export type BookingRow = Awaited<ReturnType<typeof selectBookings>>[number]

export async function bookingAnswered(tx: Tx, companyId: string, row: BookingRow): Promise<BulkyBooking> {
  return bookingOf(row, (await bulkyItemsOf(tx, companyId, [row.id])).get(row.id) ?? [])
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
