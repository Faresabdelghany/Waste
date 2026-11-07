import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { dayInTimezone, instantOnDay, timeInTimezone } from "@waste/domain/clock"
import { addDays } from "@waste/domain/days"
import { sql } from "drizzle-orm"

import { createDb, type Database } from "../client"
import { dayOnClock, instantAt, instantOnClock, shownOnClock, timeOnClock, todayOnClock } from "../query/project-clock"
import { databaseUnderTest } from "./database"

const database = databaseUnderTest()

/** Clocks either side of UTC, with and without summer time, one a half hour off the hour, one south of the equator. */
const ZONES = ["UTC", "Europe/Copenhagen", "Africa/Cairo", "America/New_York", "Asia/Kolkata", "Pacific/Auckland"]
/** The days the zones' clocks change in 2026, and the year's turn. */
const DAYS = ["2026-03-08", "2026-03-29", "2026-04-05", "2026-04-24", "2026-09-27", "2026-10-25", "2026-10-29", "2026-10-30", "2026-11-01", "2026-12-31"]

const QUARTER_HOUR = 15 * 60_000
/** Every quarter of an hour from noon UTC the day before each day to noon the day after, and a millisecond before each midnight UTC. */
const INSTANTS = DAYS.flatMap((day) => {
  const from = Date.parse(`${addDays(day, -1)}T12:00:00Z`)
  const quarters = Array.from({ length: 48 * 4 }, (_, n) => new Date(from + n * QUARTER_HOUR))
  return [...quarters, new Date(Date.parse(`${day}T00:00:00Z`) - 1)]
})
/** Every half hour of each day, the hours the clocks skip and the ones they repeat among them. */
const TIMES = Array.from({ length: 48 }, (_, n) => n * 1800)

const ISO = (column: ReturnType<typeof sql>) => sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
const clock = (seconds: number) => `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String((seconds / 60) % 60).padStart(2, "0")}:00`

describe("the project's clock in SQL is the domain's", { skip: database.skip }, () => {
  let pool: Database
  before(() => {
    pool = createDb(database.appUrl, { max: 1 })
  })
  after(() => pool.close())

  test("an instant's day, its time and the two as shown are dayInTimezone's and timeInTimezone's, on every zone, across every clock change", async () => {
    const mismatches: string[] = []
    for (const zone of ZONES) {
      const at = sql`t.at::timestamptz`
      const rows = await pool.db.execute<{ at: string; day: string; time: string; shown: string }>(sql`
        select t.at, to_char(${dayOnClock(at, sql`${zone}`)}, 'YYYY-MM-DD') as day, ${timeOnClock(at, sql`${zone}`)} as time, ${shownOnClock(at, sql`${zone}`)} as shown
          from (values ${sql.join(
            INSTANTS.map((instant) => sql`(${instant.toISOString()})`),
            sql`, `,
          )}) as t(at)
      `)
      assert.equal(rows.length, INSTANTS.length)
      for (const row of rows) {
        const instant = new Date(row.at)
        const expected = { day: dayInTimezone(instant, zone), time: timeInTimezone(instant, zone) }
        const told = { day: row.day, time: row.time, shown: row.shown }
        if (told.day !== expected.day || told.time !== expected.time || told.shown !== `${expected.day} ${expected.time}`) mismatches.push(`${row.at} in ${zone}: SQL ${JSON.stringify(told)}, domain ${JSON.stringify(expected)}`)
      }
    }
    assert.deepEqual(mismatches, [])
  })

  test("today at the caller's instant is the day that instant falls on, whatever Postgres's own clock says", async () => {
    const at = new Date("2026-09-05T22:30:00Z")
    const [row] = await pool.db.execute<{ london: string; copenhagen: string; instant: string }>(sql`
      select to_char(${todayOnClock(at, sql`${"Europe/London"}`)}, 'YYYY-MM-DD') as london,
             to_char(${todayOnClock(at, sql`${"Europe/Copenhagen"}`)}, 'YYYY-MM-DD') as copenhagen,
             ${ISO(instantAt(at))} as instant
    `)
    assert.deepEqual(row, { london: "2026-09-05", copenhagen: "2026-09-06", instant: "2026-09-05T22:30:00.000Z" }, "still the 5th in London and already the 6th in Copenhagen")
  })

  test("a time of a project's day is instantOnDay's instant, on every zone, the hours the clocks skip and repeat included", async () => {
    const mismatches: string[] = []
    for (const zone of ZONES) {
      const pairs = DAYS.flatMap((day) => TIMES.map((seconds) => ({ day, seconds })))
      const rows = await pool.db.execute<{ day: string; time: string; instant: string; midnight: string }>(sql`
        select t.day, t.time, ${ISO(instantOnClock(sql`t.day`, sql`${zone}`, sql`t.time::time`))} as instant, ${ISO(instantOnClock(sql`t.day`, sql`${zone}`))} as midnight
          from (values ${sql.join(
            pairs.map(({ day, seconds }) => sql`(${day}::date, ${clock(seconds)})`),
            sql`, `,
          )}) as t(day, time)
      `)
      assert.equal(rows.length, pairs.length)
      for (const row of rows) {
        const day = row.day.slice(0, 10)
        const [hours, minutes] = row.time.split(":").map(Number)
        const expected = instantOnDay(day, hours * 3600 + minutes * 60, zone).toISOString()
        if (row.instant !== expected) mismatches.push(`${day} ${row.time} in ${zone}: SQL ${row.instant}, domain ${expected}`)
        const midnight = instantOnDay(day, 0, zone).toISOString()
        if (row.midnight !== midnight) mismatches.push(`${day} midnight in ${zone}: SQL ${row.midnight}, domain ${midnight}`)
      }
    }
    assert.deepEqual(mismatches, [])
  })

  test("a day given as a value is read as that day", async () => {
    const [row] = await pool.db.execute<{ instant: string }>(sql`select ${ISO(instantOnClock("2026-10-25", sql`${"Europe/Copenhagen"}`, sql`${"02:30:00"}::time`))} as instant`)
    assert.equal(row.instant, instantOnDay("2026-10-25", 2.5 * 3600, "Europe/Copenhagen").toISOString(), "the hour the clocks repeat is read once, as the domain reads it")
  })
})
