// Vehicle maintenance plans (O20 of #290): a plan is due on whichever of its
// intervals comes first, measured from the last service against the vehicle's
// latest readings, due soon inside the margins and overdue past a limit.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { AN_INTERVAL, HOURS_NEED_A_READING, KM_NEEDS_A_READING, MAINTENANCE_WARNING_DAYS, MAINTENANCE_WARNING_KM, maintenanceDue, nextDueLine, planIssue } from "../maintenance"

const plan = { intervalDays: 365, intervalKm: 30_000, intervalHours: null, lastDoneOn: "2026-01-10", lastDoneKm: 160_000, lastDoneHours: null }
const none = { odometerKm: null, engineHours: null }

describe("maintenanceDue", () => {
  test("is ok well before every limit, with the next limits counted from the last service", () => {
    assert.deepEqual(maintenanceDue(plan, "2026-06-01", { odometerKm: 170_000, engineHours: 5_000 }), { state: "ok", nextDueOn: "2027-01-10", nextDueKm: 190_000, nextDueHours: null, odometerKm: 170_000, engineHours: 5_000 })
  })

  test("is due soon inside the date's or the distance's margin, and overdue on or past either limit", () => {
    assert.equal(maintenanceDue(plan, "2026-12-27", none).state, "due-soon", `${MAINTENANCE_WARNING_DAYS} days before`)
    assert.equal(maintenanceDue(plan, "2026-12-26", none).state, "ok")
    assert.equal(maintenanceDue(plan, "2027-01-10", none).state, "overdue")
    assert.equal(maintenanceDue(plan, "2026-06-01", { odometerKm: 190_000 - MAINTENANCE_WARNING_KM, engineHours: null }).state, "due-soon")
    assert.equal(maintenanceDue(plan, "2026-06-01", { odometerKm: 190_000, engineHours: null }).state, "overdue")
  })

  test("the worst limit wins, and a reading older than the service is the service's own", () => {
    assert.equal(maintenanceDue(plan, "2026-12-30", { odometerKm: 195_000, engineHours: null }).state, "overdue")
    assert.equal(maintenanceDue(plan, "2026-06-01", { odometerKm: 150_000, engineHours: null }).odometerKm, 160_000)
    assert.equal(maintenanceDue(plan, "2026-06-01", none).odometerKm, 160_000)
  })

  test("an hours plan counts the engine hours", () => {
    const hours = { intervalDays: null, intervalKm: null, intervalHours: 500, lastDoneOn: "2026-01-10", lastDoneKm: null, lastDoneHours: 6_000 }
    assert.equal(maintenanceDue(hours, "2030-01-01", { odometerKm: null, engineHours: 6_400 }).state, "ok", "no date limit")
    assert.equal(maintenanceDue(hours, "2026-02-01", { odometerKm: null, engineHours: 6_460 }).state, "due-soon")
    assert.equal(maintenanceDue(hours, "2026-02-01", { odometerKm: null, engineHours: 6_500 }).state, "overdue")
  })
})

describe("planIssue and nextDueLine", () => {
  test("a plan needs an interval, and a distance or hours interval the reading it counts from", () => {
    assert.deepEqual(planIssue({ intervalDays: null, intervalKm: null, intervalHours: null, lastDoneKm: null, lastDoneHours: null }), { path: "intervalDays", message: AN_INTERVAL })
    assert.deepEqual(planIssue({ intervalDays: null, intervalKm: 30_000, intervalHours: null, lastDoneKm: null, lastDoneHours: null }), { path: "lastDoneKm", message: KM_NEEDS_A_READING })
    assert.deepEqual(planIssue({ intervalDays: null, intervalKm: null, intervalHours: 500, lastDoneKm: null, lastDoneHours: null }), { path: "lastDoneHours", message: HOURS_NEED_A_READING })
    assert.equal(planIssue({ intervalDays: 365, intervalKm: null, intervalHours: null, lastDoneKm: null, lastDoneHours: null }), undefined)
  })

  test("reads the next limits a plan has", () => {
    assert.equal(nextDueLine({ nextDueOn: "2027-01-10", nextDueKm: 190_000, nextDueHours: 6_500 }), "2027-01-10 · 190,000 km · 6,500 h")
    assert.equal(nextDueLine({ nextDueOn: null, nextDueKm: null, nextDueHours: 6_500 }), "6,500 h")
  })
})
