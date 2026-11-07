import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { maintenanceDue, type MaintenancePlanState } from "@waste/domain/resources/maintenance"
import { sql } from "drizzle-orm"

import { createDb, type Database } from "../client"
import { maintenanceDueState, nextDue } from "../query/maintenance-due"
import { databaseUnderTest } from "./database"

const database = databaseUnderTest()

const LAST_DONE_ON = "2026-01-01"
/** Every plan of the intervals and baselines below: none, a short one inside its margin from the start, a long one. */
const PLANS: MaintenancePlanState[] = [null, 30, 365].flatMap((intervalDays) =>
  [null, 500, 15_000].flatMap((intervalKm) =>
    [null, 40, 250].flatMap((intervalHours) =>
      [null, 120_000].flatMap((lastDoneKm) => [null, 3_000].map((lastDoneHours) => ({ intervalDays, intervalKm, intervalHours, lastDoneOn: LAST_DONE_ON, lastDoneKm, lastDoneHours }))),
    ),
  ),
)
/** The days around the margins and the limits of the two date intervals, and before the service. */
const DAYS = ["2025-12-31", "2026-01-01", "2026-01-16", "2026-01-17", "2026-01-30", "2026-01-31", "2026-02-01", "2026-12-17", "2026-12-18", "2027-01-01", "2027-01-02"]

const PLAN = {
  intervalDays: sql`t.interval_days`,
  intervalKm: sql`t.interval_km`,
  intervalHours: sql`t.interval_hours`,
  lastDoneOn: sql`t.last_done_on`,
  lastDoneKm: sql`t.last_done_km`,
  lastDoneHours: sql`t.last_done_hours`,
}

describe("a maintenance plan's due state in SQL is the domain's", { skip: database.skip }, () => {
  let pool: Database
  before(() => {
    pool = createDb(database.appUrl, { max: 1 })
  })
  after(() => pool.close())

  test("its next limits and its state are maintenanceDue's on the last service's readings, for every plan on every day", async () => {
    const next = nextDue(PLAN)
    const rows = await pool.db.execute<{ n: number; today: string; on: string | null; km: number | null; hours: number | null; state: string }>(sql`
      select t.n, to_char(t.today, 'YYYY-MM-DD') as today, to_char(${next.on}, 'YYYY-MM-DD') as on, ${next.km} as km, ${next.hours} as hours, ${maintenanceDueState(PLAN, sql`t.today`)} as state
        from (values ${sql.join(
          PLANS.flatMap((plan, n) =>
            DAYS.map((day) => sql`(${n}::int, ${plan.intervalDays}::int, ${plan.intervalKm}::int, ${plan.intervalHours}::int, ${plan.lastDoneOn}::date, ${plan.lastDoneKm}::int, ${plan.lastDoneHours}::int, ${day}::date)`),
          ),
          sql`, `,
        )}) as t(n, interval_days, interval_km, interval_hours, last_done_on, last_done_km, last_done_hours, today)
    `)
    assert.equal(rows.length, PLANS.length * DAYS.length)
    const mismatches: string[] = []
    for (const row of rows) {
      const plan = PLANS[row.n]!
      const due = maintenanceDue(plan, row.today, { odometerKm: null, engineHours: null })
      const told = { on: row.on, km: row.km, hours: row.hours, state: row.state }
      const expected = { on: due.nextDueOn, km: due.nextDueKm, hours: due.nextDueHours, state: due.state }
      if (JSON.stringify(told) !== JSON.stringify(expected)) mismatches.push(`${JSON.stringify(plan)} on ${row.today}: SQL ${JSON.stringify(told)}, domain ${JSON.stringify(expected)}`)
    }
    assert.deepEqual(mismatches, [])
    assert.deepEqual(new Set(rows.map((row) => row.state)), new Set(["ok", "due-soon", "overdue"]), "the fixtures reach every state")
  })
})
