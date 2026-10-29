// Vehicle maintenance through the API (O20 of #290): a plan created on a
// vehicle and read with where it stands — by its date on the project's day,
// and by the odometer and the engine hours a driver's pre-trip check last
// read — patched under the rule over the merged row, and retired; a
// Maintenance Order of a plan opened under its name and completed, which
// moves the plan's last service; a one-off order cancelled; and the refusals.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { CommandOutcomeRow, DriverCommandBatchOutcome } from "@waste/contracts/driver-commands"
import { MaintenanceOrder, MaintenancePlan, NAME_THE_ORDER } from "@waste/contracts/maintenance"
import { Page } from "@waste/contracts/pagination"
import { createDb, type Database } from "@waste/db/client"
import { createJobSender } from "@waste/db/jobs"
import type { DriverCommandKind } from "@waste/domain/execution/vocabulary"
import { AN_INTERVAL, KM_NEEDS_A_READING } from "@waste/domain/resources/maintenance"
import { FakeProvider } from "@waste/routing/fake"
import { Hono } from "hono"

import type { createApp } from "../app"
import { authenticate } from "../auth/principal"
import { errorHandler } from "../problem"
import { driverDoorRoutes } from "../routes/driver"
import { alreadyClosed, maintenanceRoutes, NEEDS_THE_ODOMETER, NOT_A_PLAN_OF_THE_VEHICLE, NOT_A_VEHICLE_HERE, NOT_AHEAD } from "../routes/maintenance"
import { preTripRoutes } from "../routes/pre-trip-checks"
import { routeRoutes } from "../routes/routes"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { FIXTURE_DAY, routeFor, seedDriverFixtures, type DriverFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the pre-trip checks this suite appends, which `wms_api` may not delete. */
const owner = ownerUnderTest()

const PlanPage = Page(MaintenancePlan)
const OrderPage = Page(MaintenanceOrder)

/** The request's clock: the afternoon of the fixture day, which is the project's today. */
const NOW = new Date(`${FIXTURE_DAY}T14:00:00Z`)

let tick = Date.now()
const mint = (): string => testId((tick += 1))

describe("vehicle maintenance", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let a: Tenant
  let fleet: FleetFixtures
  let fixtures: DriverFixtures
  let olivia: Call
  let viewer: Call
  let mads: Call

  before(async () => {
    pool = createDb(database.url, { max: 6 })
    ownerPool = createDb(owner.url, { max: 1 })
    const keys = await signingKeys()
    a = await seedTenant(pool)
    const planning = await seedPlanning(pool, a)
    fleet = await seedFleet(pool, a, planning)
    fixtures = await seedDriverFixtures(pool, a, fleet)
    const guard = authenticate({ pool, verifier: keys.verifier })
    const app = new Hono()
    app.onError(errorHandler())
    app.route("/", driverDoorRoutes(guard, { now: () => NOW, log: () => {} }))
    app.route("/", routeRoutes(guard, { now: () => NOW, routing: new FakeProvider(), jobs: createJobSender(pool) }))
    app.route("/", preTripRoutes(guard, { now: () => NOW }))
    app.route("/", maintenanceRoutes(guard, { now: () => NOW }))
    const asApp = app as unknown as ReturnType<typeof createApp>
    olivia = callingAs(asApp, keys, a.users.olivia, a.companyId)
    viewer = callingAs(asApp, keys, a.users.viewer, a.companyId)
    mads = callingAs(asApp, keys, fixtures.accounts.mads, a.companyId)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const createPlan = async (body: Record<string, unknown>): Promise<MaintenancePlan> => {
    const response = await olivia("/maintenance-plans", { method: "POST", body })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return MaintenancePlan.parse(await response.json())
  }
  const readPlan = async (id: string): Promise<MaintenancePlan> => {
    const response = await olivia(`/maintenance-plans/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return MaintenancePlan.parse(await response.json())
  }
  const openOrder = async (body: Record<string, unknown>): Promise<MaintenanceOrder> => {
    const response = await olivia("/maintenance-orders", { method: "POST", body })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return MaintenanceOrder.parse(await response.json())
  }
  /** A driver's pre-trip check of the vehicle reading the odometer and the engine hours, on a route of the fixture day. */
  const checkReads = async (vehicleId: string, odometerKm: number, engineHours: number): Promise<CommandOutcomeRow> => {
    const route = await routeFor(pool, a, fleet, fixtures, { driver: fleet.drivers.mads })
    const kind: DriverCommandKind = "pre-trip-check"
    const command = { id: mint(), kind, routeId: route.id, occurredAt: `${FIXTURE_DAY}T06:15:00.000Z`, deviceId: "device-mads-01", body: { vehicleId, items: [], odometerKm, engineHours } }
    const response = await mads("/driver/commands", { method: "POST", body: { commands: [command] } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const [outcome] = DriverCommandBatchOutcome.parse(await response.json()).outcomes
    assert.equal(outcome.outcome, "applied", JSON.stringify(outcome.problem))
    return outcome
  }

  test("a plan is read with where it stands: by its date on the project's day, and by the latest reading of a pre-trip check over the last service's", async () => {
    const annual = await createPlan({ vehicleId: fleet.vehicles.wh25.id, name: "Annual service", intervalDays: 365, lastDoneOn: "2025-10-12" })
    assert.equal(annual.projectId, a.projects.copenhagen.id)
    assert.equal(annual.status, "active")
    assert.deepEqual(annual.due, { state: "due-soon", nextDueOn: "2026-10-12", nextDueKm: null, nextDueHours: null, odometerKm: null, engineHours: null })

    const brakes = await createPlan({ vehicleId: fleet.vehicles.wh24.id, name: "Brake inspection", intervalKm: 20_000, intervalHours: 1_000, lastDoneOn: "2026-06-01", lastDoneKm: 170_000, lastDoneHours: 5_500 })
    assert.equal(brakes.due.state, "ok")
    assert.equal(brakes.due.odometerKm, 170_000, "nothing read since: the service's own reading")
    await checkReads(fleet.vehicles.wh24.id, 189_200, 6_120)
    const read = await readPlan(brakes.id)
    assert.deepEqual(read.due, { state: "due-soon", nextDueOn: null, nextDueKm: 190_000, nextDueHours: 6_500, odometerKm: 189_200, engineHours: 6_120 })

    const listed = PlanPage.parse(await (await olivia(`/maintenance-plans?vehicleId=${fleet.vehicles.wh24.id}`)).json()).items
    assert.deepEqual(
      listed.map((plan) => plan.id),
      [brakes.id],
    )
    assert.equal(listed[0].due.state, "due-soon")
  })

  test("a create is held to the rule: an interval, the reading a distance interval counts from, and a vehicle of the caller's projects", async () => {
    const none = await olivia("/maintenance-plans", { method: "POST", body: { vehicleId: fleet.vehicles.wh24.id, name: "Nothing", lastDoneOn: "2026-01-01" } })
    assert.deepEqual((await readProblem(none)).errors, [{ path: "intervalDays", message: AN_INTERVAL }])
    const unread = await olivia("/maintenance-plans", { method: "POST", body: { vehicleId: fleet.vehicles.wh24.id, name: "Tyres", intervalKm: 40_000, lastDoneOn: "2026-01-01" } })
    assert.deepEqual((await readProblem(unread)).errors, [{ path: "lastDoneKm", message: KM_NEEDS_A_READING }])
    const elsewhere = await olivia("/maintenance-plans", { method: "POST", body: { vehicleId: mint(), name: "Annual", intervalDays: 365, lastDoneOn: "2026-01-01" } })
    assert.deepEqual((await readProblem(elsewhere)).errors, [{ path: "vehicleId", message: NOT_A_VEHICLE_HERE }])
    const owned = await olivia("/maintenance-plans", { method: "POST", body: { vehicleId: fleet.vehicles.wh24.id, name: "Annual", intervalDays: 365, lastDoneOn: "2026-01-01", status: "retired" } })
    assert.equal((await readProblem(owned)).status, 400)
    const refused = await viewer("/maintenance-plans")
    assert.equal(refused.status, 403)
  })

  test("a patch is held to the rule over the merged row, and retiring a plan keeps it", async () => {
    const plan = await createPlan({ vehicleId: fleet.vehicles.trailer.id, name: "Axle check", intervalDays: 180, lastDoneOn: "2026-09-01" })
    const bare = await olivia(`/maintenance-plans/${plan.id}`, { method: "PATCH", body: { intervalDays: null } })
    assert.deepEqual((await readProblem(bare)).errors, [{ path: "intervalDays", message: AN_INTERVAL }])
    const byKm = await olivia(`/maintenance-plans/${plan.id}`, { method: "PATCH", body: { intervalKm: 30_000 } })
    assert.deepEqual((await readProblem(byKm)).errors, [{ path: "lastDoneKm", message: KM_NEEDS_A_READING }])
    const both = await olivia(`/maintenance-plans/${plan.id}`, { method: "PATCH", body: { intervalKm: 30_000, lastDoneKm: 12_000 } })
    assert.equal(both.status, 200, JSON.stringify(await both.clone().json()))
    assert.equal(MaintenancePlan.parse(await both.json()).due.nextDueKm, 42_000)
    const retired = await olivia(`/maintenance-plans/${plan.id}`, { method: "PATCH", body: { status: "retired" } })
    assert.equal(MaintenancePlan.parse(await retired.json()).status, "retired")
    const order = await olivia("/maintenance-orders", { method: "POST", body: { vehicleId: fleet.vehicles.trailer.id, planId: plan.id } })
    assert.deepEqual((await readProblem(order)).errors, [{ path: "planId", message: NOT_A_PLAN_OF_THE_VEHICLE }])
    const missing = await olivia(`/maintenance-plans/${mint()}`)
    assert.equal(missing.status, 404)
  })

  test("an order of a plan takes its name, and completing it is the service done: the plan's last service moves, and it reads ok again", async () => {
    const plan = await createPlan({ vehicleId: fleet.vehicles.wh25.id, name: "Oil change", intervalDays: 90, intervalKm: 15_000, lastDoneOn: "2026-06-01", lastDoneKm: 80_000 })
    assert.equal(plan.due.state, "overdue", "ninety days past 1 June")
    const order = await openOrder({ vehicleId: fleet.vehicles.wh25.id, planId: plan.id, dueOn: "2026-10-07" })
    assert.deepEqual({ title: order.title, status: order.status, planId: order.planId, dueOn: order.dueOn, completedOn: order.completedOn }, { title: "Oil change", status: "open", planId: plan.id, dueOn: "2026-10-07", completedOn: null })

    const ahead = await olivia(`/maintenance-orders/${order.id}/complete`, { method: "POST", body: { completedOn: "2026-10-06", odometerKm: 93_000 } })
    assert.deepEqual((await readProblem(ahead)).errors, [{ path: "completedOn", message: NOT_AHEAD }])
    const unread = await olivia(`/maintenance-orders/${order.id}/complete`, { method: "POST", body: { completedOn: FIXTURE_DAY } })
    assert.deepEqual((await readProblem(unread)).errors, [{ path: "odometerKm", message: NEEDS_THE_ODOMETER }])

    const done = await olivia(`/maintenance-orders/${order.id}/complete`, { method: "POST", body: { completedOn: FIXTURE_DAY, odometerKm: 93_000, note: "Oil and filter" } })
    assert.equal(done.status, 200, JSON.stringify(await done.clone().json()))
    const completed = MaintenanceOrder.parse(await done.json())
    assert.deepEqual({ status: completed.status, completedOn: completed.completedOn, odometerKm: completed.odometerKm, closingNote: completed.closingNote }, { status: "completed", completedOn: FIXTURE_DAY, odometerKm: 93_000, closingNote: "Oil and filter" })
    assert.ok(completed.closedAt !== null)
    const after = await readPlan(plan.id)
    assert.deepEqual({ lastDoneOn: after.lastDoneOn, lastDoneKm: after.lastDoneKm, state: after.due.state, nextDueOn: after.due.nextDueOn, nextDueKm: after.due.nextDueKm }, { lastDoneOn: FIXTURE_DAY, lastDoneKm: 93_000, state: "ok", nextDueOn: "2027-01-03", nextDueKm: 108_000 })

    const again = await olivia(`/maintenance-orders/${order.id}/cancel`, { method: "POST", body: {} })
    const refused = await readProblem(again)
    assert.equal(refused.status, 409)
    assert.equal(refused.detail, alreadyClosed("Oil change", "completed"))
  })

  test("a one-off order needs a title, is cancelled with why, and leaves no plan moved; the list narrows by vehicle and status", async () => {
    const untitled = await olivia("/maintenance-orders", { method: "POST", body: { vehicleId: fleet.vehicles.trailer.id } })
    assert.deepEqual((await readProblem(untitled)).errors, [{ path: "title", message: NAME_THE_ORDER }])
    const order = await openOrder({ vehicleId: fleet.vehicles.trailer.id, title: "Replace the left tail light", note: "From the pre-trip defect" })
    assert.equal(order.planId, null)
    const cancelled = await olivia(`/maintenance-orders/${order.id}/cancel`, { method: "POST", body: { note: "Done under warranty" } })
    assert.equal(cancelled.status, 200, JSON.stringify(await cancelled.clone().json()))
    assert.deepEqual(
      (({ status, closingNote, completedOn }) => ({ status, closingNote, completedOn }))(MaintenanceOrder.parse(await cancelled.json())),
      { status: "cancelled", closingNote: "Done under warranty", completedOn: null },
    )
    const listed = OrderPage.parse(await (await olivia(`/maintenance-orders?vehicleId=${fleet.vehicles.trailer.id}&status=cancelled`)).json()).items
    assert.deepEqual(
      listed.map((row) => row.id),
      [order.id],
    )
    assert.equal((await olivia(`/maintenance-orders/${mint()}`)).status, 404)
  })
})
