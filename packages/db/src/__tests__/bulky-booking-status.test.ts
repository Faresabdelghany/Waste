import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { bulkyBookingStatus } from "@waste/domain/execution/bulky"
import { BULKY_BOOKING_STATUSES, type PickupStatus } from "@waste/domain/execution/vocabulary"
import { sql } from "drizzle-orm"

import { createDb, type Database } from "../client"
import { bookingStatusIs } from "../shapes/bulky-bookings"
import { databaseUnderTest, freshDatabase, type FreshDatabase } from "./database"

const database = databaseUnderTest()

/** Every booking a list can meet: cancelled or not, beside no live stop, a planned one or a completed one (`liveStop` joins no other). */
const BOOKINGS = [null, "2026-11-02T09:00:00Z"].flatMap((cancelledAt) =>
  ([null, "planned", "completed"] as (PickupStatus | null)[]).map((stopStatus) => ({ cancelledAt, stopStatus, stopId: stopStatus === null ? null : "01a1b821-98c6-7747-8885-35ca8c7d0162" })),
)

// The condition reads the booking's and the live stop's own columns, so a
// database of its own holds the two tables with those columns alone, one row
// of each per booking, the stop's absent where the booking has none.
describe("a bulky booking's status in SQL is bulkyBookingStatus's", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let pool: Database
  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_bulky_status_test")
    pool = createDb(fresh.url, { max: 1 })
    await pool.db.execute(sql`create schema wms`)
    await pool.db.execute(sql`create table wms.bulky_booking (n int primary key, cancelled_at timestamptz)`)
    await pool.db.execute(sql`create table wms.pickup (n int primary key, id uuid, status text)`)
    for (const [n, booking] of BOOKINGS.entries()) {
      await pool.db.execute(sql`insert into wms.bulky_booking values (${n}, ${booking.cancelledAt}::timestamptz)`)
      if (booking.stopId !== null) await pool.db.execute(sql`insert into wms.pickup values (${n}, ${booking.stopId}::uuid, ${booking.stopStatus})`)
    }
  })
  after(async () => {
    await pool?.close()
    await fresh?.drop()
  })

  for (const status of BULKY_BOOKING_STATUSES) {
    test(`${status}: the bookings the condition holds of are the ones the domain calls ${status}`, async () => {
      const rows = await pool.db.execute<{ n: number }>(sql`
        select wms.bulky_booking.n
          from wms.bulky_booking
          left join wms.pickup on wms.pickup.n = wms.bulky_booking.n
         where ${bookingStatusIs(status)}
         order by wms.bulky_booking.n
      `)
      assert.deepEqual(
        rows.map((row) => row.n),
        BOOKINGS.flatMap((booking, n) => (bulkyBookingStatus(booking) === status ? [n] : [])),
      )
    })
  }
})
