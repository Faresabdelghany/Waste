// Vehicle maintenance on the wire (O20 of #290): a plan's create holds the
// interval rule, its patch moves any field, and an order names its plan or
// says what it is for; the plan reads back with where it stands.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { AN_INTERVAL, KM_NEEDS_A_READING, MAINTENANCE_INTERVAL_MAX } from "@waste/domain/resources/maintenance"

import { MaintenanceOrder, MaintenanceOrderComplete, MaintenanceOrderCreate, MaintenancePlan, MaintenancePlanCreate, MaintenancePlanPatch, NAME_THE_ORDER } from "../maintenance"
import { refusal } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const WHEN = "2026-10-05T06:20:00.000Z"

describe("MaintenancePlanCreate", () => {
  test("takes a name, at least one interval and the last service, with the reading a distance interval counts from", () => {
    const body = { vehicleId: ID, name: "Annual service", intervalDays: 365, intervalKm: 30_000, lastDoneOn: "2026-01-10", lastDoneKm: 160_000 }
    assert.deepEqual(MaintenancePlanCreate.parse(body), body)
    assert.deepEqual(refusal(MaintenancePlanCreate.safeParse({ vehicleId: ID, name: "Nothing", lastDoneOn: "2026-01-10" })), [{ path: "intervalDays", message: AN_INTERVAL }])
    assert.deepEqual(refusal(MaintenancePlanCreate.safeParse({ vehicleId: ID, name: "Oil", intervalKm: 15_000, lastDoneOn: "2026-01-10" })), [{ path: "lastDoneKm", message: KM_NEEDS_A_READING }])
  })

  test("bounds each interval, and refuses a member the server owns", () => {
    assert.equal(MaintenancePlanCreate.safeParse({ vehicleId: ID, name: "Long", intervalDays: MAINTENANCE_INTERVAL_MAX.days + 1, lastDoneOn: "2026-01-10" }).success, false)
    assert.equal(MaintenancePlanCreate.safeParse({ vehicleId: ID, name: "Owned", intervalDays: 30, lastDoneOn: "2026-01-10", status: "active" }).success, false)
  })

  test("a patch moves any field, an interval to none, and changes something", () => {
    assert.deepEqual(MaintenancePlanPatch.parse({ intervalKm: null, status: "retired" }), { intervalKm: null, status: "retired" })
    assert.equal(MaintenancePlanPatch.safeParse({}).success, false)
  })
})

describe("the plan and the order", () => {
  test("a plan reads back with where it stands", () => {
    const plan = {
      id: ID,
      createdAt: WHEN,
      updatedAt: WHEN,
      projectId: OTHER,
      vehicleId: OTHER,
      name: "Annual service",
      intervalDays: 365,
      intervalKm: null,
      intervalHours: null,
      lastDoneOn: "2026-01-10",
      lastDoneKm: null,
      lastDoneHours: null,
      status: "active",
      due: { state: "due-soon", nextDueOn: "2027-01-10", nextDueKm: null, nextDueHours: null, odometerKm: null, engineHours: null },
    }
    assert.deepEqual(MaintenancePlan.parse(plan), plan)
  })

  test("an order names its plan or says what it is for, and is completed on a day with the readings then", () => {
    assert.equal(MaintenanceOrderCreate.safeParse({ vehicleId: ID, planId: OTHER }).success, true)
    assert.equal(MaintenanceOrderCreate.safeParse({ vehicleId: ID, title: "Replace the left mirror" }).success, true)
    assert.deepEqual(refusal(MaintenanceOrderCreate.safeParse({ vehicleId: ID })), [{ path: "title", message: NAME_THE_ORDER }])
    assert.equal(MaintenanceOrderComplete.safeParse({ completedOn: "2026-10-05", odometerKm: 190_100 }).success, true)
    assert.equal(MaintenanceOrderComplete.safeParse({ odometerKm: 190_100 }).success, false)
    const order = { id: ID, createdAt: WHEN, updatedAt: WHEN, projectId: OTHER, vehicleId: OTHER, planId: null, title: "Mirror", status: "open", dueOn: null, note: null, completedOn: null, odometerKm: null, engineHours: null, closingNote: null, closedAt: null }
    assert.deepEqual(MaintenanceOrder.parse(order), order)
  })
})
