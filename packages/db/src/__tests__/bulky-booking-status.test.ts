import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { bulkyBookingStatus } from "@waste/domain/execution/bulky"
import { BULKY_BOOKING_STATUSES, type PickupStatus } from "@waste/domain/execution/vocabulary"
import { sql } from "drizzle-orm"

import { createDb, type Database } from "../client"
import { bookingStatusIs } from "../shapes/bulky-bookings"
import { databaseUnderTest } from "./database"

const database = databaseUnderTest()

/** Every booking a list can meet: cancelled or not, beside no live stop, a planned one or a completed one (`liveStop` joins no other). */
const BOOKINGS = [null, "2026-11-02T09:00:00Z"].flatMap((cancelledAt) =>
  ([null, "planned", "completed"] as (PickupStatus | null)[]).map((stopStatus) => ({ cancelledAt, stopStatus, stopId: stopStatus === null ? null : "01a1b821-98c6-7747-8885-35ca8c7d0162" })),
)

describe("a bulky booking's status in SQL is bulkyBookingStatus's", { skip: database.skip }, () => {
  let pool: Database
  before(() => {
    pool = createDb(database.appUrl, { max: 1 })
  })
  after(() => pool.close())

  for (const status of BULKY_BOOKING_STATUSES) {
    test(`${status}: the bookings the condition holds of are the ones the domain calls ${status}`, async () => {
      const condition = bookingStatusIs(status, { cancelledAt: sql`t.cancelled_at`, stopId: sql`t.stop_id`, stopStatus: sql`t.stop_status` })
      const rows = await pool.db.execute<{ n: number }>(sql`
        select t.n
          from (values ${sql.join(
            BOOKINGS.map((booking, n) => sql`(${n}::int, ${booking.cancelledAt}::timestamptz, ${booking.stopId}::uuid, ${booking.stopStatus}::text)`),
            sql`, `,
          )}) as t(n, cancelled_at, stop_id, stop_status)
         where ${condition}
         order by t.n
      `)
      assert.deepEqual(
        rows.map((row) => row.n),
        BOOKINGS.flatMap((booking, n) => (bulkyBookingStatus(booking) === status ? [n] : [])),
      )
    })
  }
})
