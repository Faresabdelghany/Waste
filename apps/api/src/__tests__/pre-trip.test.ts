// Pre-trip inspection through the API (O13 of #290): a vehicle type's
// checklist replaced whole and read back on the type and on the driver's
// start screen; a driver's `pre-trip-check` judged against it, appended, and
// — where it finds defects — the defects recorded, the office's ticket opened
// and a critical one grounding the vehicle, which the start rule then refuses;
// a replay answering the first check; and the office's reads and resolve.
import assert from "node:assert/strict"
import { after, before, beforeEach, describe, test } from "node:test"

import { CommandOutcomeRow, DriverCommandBatchOutcome, DriverMe } from "@waste/contracts/driver-commands"
import { Page } from "@waste/contracts/pagination"
import { PreTripCheck, VehicleDefect } from "@waste/contracts/pre-trip"
import { VehicleType } from "@waste/contracts/vehicle-types"
import { createDb, type Database } from "@waste/db/client"
import { createJobSender } from "@waste/db/jobs"
import { session as sessionTable } from "@waste/db/schema/execution"
import { vehicle as vehicleTable } from "@waste/db/schema/fleet"
import { ticket as ticketTable } from "@waste/db/schema/resolution"
import { withCompany } from "@waste/db/tenant"
import { checkNotNow, notInService } from "@waste/domain/execution/commands"
import type { DriverCommandKind } from "@waste/domain/execution/vocabulary"
import { NOT_ON_THE_CHECKLIST, unanswered } from "@waste/domain/resources/pre-trip"
import { FakeProvider } from "@waste/routing/fake"
import { and, eq, isNull } from "drizzle-orm"
import { Hono } from "hono"

import type { createApp } from "../app"
import { authenticate } from "../auth/principal"
import { errorHandler } from "../problem"
import { driverDoorRoutes } from "../routes/driver"
import { alreadyResolved, preTripRoutes } from "../routes/pre-trip-checks"
import { routeRoutes } from "../routes/routes"
import { vehicleRoutes } from "../routes/vehicles"
import { vehicleTypeRoutes } from "../routes/vehicle-types"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { FIXTURE_DAY, routeFor, seedDriverFixtures, type DriverFixtures, type RouteOptions } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures, type PlanningFixtures } from "./scheme-fixtures"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the ledgers this suite writes, which `wms_api` may not delete. */
const owner = ownerUnderTest()

const CheckPage = Page(PreTripCheck)
const DefectPage = Page(VehicleDefect)

/** The request's clock: the afternoon of the operating date, so every command's instant is behind it. */
const NOW = new Date(`${FIXTURE_DAY}T14:00:00Z`)
const at = (time: string): string => `${FIXTURE_DAY}T${time}:00.000Z`

let tick = Date.now()
const mint = (): string => testId((tick += 1))

type Envelope = { id: string; kind: DriverCommandKind; routeId: string; occurredAt: string; deviceId: string; body: unknown }
const envelope = (kind: DriverCommandKind, routeId: string, body: unknown, occurredAt = at("06:15")): Envelope => ({ id: mint(), kind, routeId, occurredAt, deviceId: "device-mads-01", body })

describe("pre-trip inspection", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let a: Tenant
  let planning: PlanningFixtures
  let fleet: FleetFixtures
  let fixtures: DriverFixtures
  let mads: Call
  let olivia: Call

  before(async () => {
    pool = createDb(database.url, { max: 6 })
    ownerPool = createDb(owner.url, { max: 1 })
    const keys = await signingKeys()
    a = await seedTenant(pool)
    planning = await seedPlanning(pool, a)
    fleet = await seedFleet(pool, a, planning)
    fixtures = await seedDriverFixtures(pool, a, fleet)
    const guard = authenticate({ pool, verifier: keys.verifier })
    const app = new Hono()
    app.onError(errorHandler())
    app.route("/", driverDoorRoutes(guard, { now: () => NOW, log: () => {} }))
    app.route("/", routeRoutes(guard, { now: () => NOW, routing: new FakeProvider(), jobs: createJobSender(pool) }))
    app.route("/", vehicleTypeRoutes(guard))
    app.route("/", vehicleRoutes(guard, { now: () => NOW }))
    app.route("/", preTripRoutes(guard, { now: () => NOW }))
    const asApp = app as unknown as ReturnType<typeof createApp>
    mads = callingAs(asApp, keys, fixtures.accounts.mads, a.companyId)
    olivia = callingAs(asApp, keys, a.users.olivia, a.companyId)
  })
  /** Every test starts with the rear loader's checklist as the suite sets it and both trucks in service, and no session open. */
  beforeEach(async () => {
    if (!a) return
    const open = await withCompany(pool.db, a.companyId, (tx) => tx.select({ routeId: sessionTable.routeId }).from(sessionTable).where(and(eq(sessionTable.companyId, a.companyId), isNull(sessionTable.endedAt))))
    for (const found of open) await olivia(`/routes/${found.routeId}/cancel`, { method: "POST", body: { reasonCode: "other", reason: "Cleared by the suite" } })
    await withCompany(pool.db, a.companyId, (tx) => tx.update(vehicleTable).set({ status: "active" }).where(eq(vehicleTable.companyId, a.companyId)))
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const minted = (options: Partial<RouteOptions> = {}) => routeFor(pool, a, fleet, fixtures, { driver: fleet.drivers.mads, ...options })
  const typeId = () => planning.vehicleTypes.rearLoader.id

  /** Sets the rear loader's checklist and answers the type. */
  const setChecklist = async (items: { label: string; critical?: boolean }[]): Promise<VehicleType> => {
    const response = await olivia(`/vehicle-types/${typeId()}/checklist`, { method: "PUT", body: { items } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return VehicleType.parse(await response.json())
  }
  const one = async (command: Envelope): Promise<CommandOutcomeRow> => {
    const response = await mads("/driver/commands", { method: "POST", body: { commands: [command] } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const [outcome] = DriverCommandBatchOutcome.parse(await response.json()).outcomes
    return outcome
  }
  const vehicleStatus = async (id: string) => {
    const [row] = await withCompany(pool.db, a.companyId, (tx) => tx.select({ status: vehicleTable.status }).from(vehicleTable).where(and(eq(vehicleTable.companyId, a.companyId), eq(vehicleTable.id, id))))
    return row.status
  }
  const defectsOf = async (vehicleId: string, status?: string) => {
    const response = await olivia(`/vehicle-defects?vehicleId=${vehicleId}${status === undefined ? "" : `&status=${status}`}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return DefectPage.parse(await response.json()).items
  }

  test("the checklist is replaced whole, in order, critical unless said, and read back on the type and on the driver's start screen", async () => {
    const type = await setChecklist([{ label: "Brakes" }, { label: "Lights", critical: false }])
    assert.deepEqual(
      type.checklist.map(({ label, critical }) => ({ label, critical })),
      [
        { label: "Brakes", critical: true },
        { label: "Lights", critical: false },
      ],
    )
    const again = await olivia(`/vehicle-types/${typeId()}`)
    assert.deepEqual(VehicleType.parse(await again.json()).checklist, type.checklist)
    const me = DriverMe.parse(await (await mads("/driver/me")).json())
    const truck = me.vehicles.find((candidate) => candidate.id === fleet.vehicles.wh24.id)
    assert.deepEqual(truck?.checklist, type.checklist)
    const twice = await olivia(`/vehicle-types/${typeId()}/checklist`, { method: "PUT", body: { items: [{ label: "Brakes" }, { label: "brakes " }] } })
    assert.equal((await readProblem(twice)).status, 400)
  })

  test("a check that passes everything is appended with its readings and grounds nothing; it is read back by the office and answered again on a replay", async () => {
    const type = await setChecklist([{ label: "Brakes" }, { label: "Lights", critical: false }])
    const route = await minted()
    const command = envelope("pre-trip-check", route.id, { vehicleId: fleet.vehicles.wh24.id, items: type.checklist.map((item) => ({ itemId: item.id, passed: true })), odometerKm: 182_400, engineHours: 6_120 })
    const outcome = await one(command)
    assert.equal(outcome.outcome, "applied", JSON.stringify(outcome.problem))
    assert.equal(outcome.result?.resource, "pre-trip-check")
    const check = PreTripCheck.parse(outcome.result?.value)
    assert.equal(check.id, command.id)
    assert.equal(check.defectCount, 0)
    assert.equal(check.odometerKm, 182_400)
    assert.deepEqual(
      check.items.map((item) => item.label),
      ["Brakes", "Lights"],
    )
    assert.equal(await vehicleStatus(fleet.vehicles.wh24.id), "active")
    const listed = CheckPage.parse(await (await olivia(`/pre-trip-checks?vehicleId=${fleet.vehicles.wh24.id}`)).json()).items
    assert.ok(listed.some((row) => row.id === command.id))
    const replay = await one(command)
    assert.equal(replay.outcome, "replayed")
    assert.deepEqual(replay.result, outcome.result)
  })

  test("a critical defect records the defects, opens one ticket for them, grounds the vehicle and so refuses the start on it", async () => {
    const type = await setChecklist([{ label: "Brakes" }, { label: "Lights", critical: false }])
    const route = await minted()
    const [brakes, lights] = type.checklist
    const command = envelope("pre-trip-check", route.id, {
      vehicleId: fleet.vehicles.wh24.id,
      items: [
        { itemId: brakes.id, passed: false, note: "Pulls to the left" },
        { itemId: lights.id, passed: false },
      ],
    })
    const outcome = await one(command)
    assert.equal(outcome.outcome, "applied", JSON.stringify(outcome.problem))
    assert.equal(PreTripCheck.parse(outcome.result?.value).defectCount, 2)
    assert.equal(await vehicleStatus(fleet.vehicles.wh24.id), "maintenance")

    const defects = (await defectsOf(fleet.vehicles.wh24.id, "open")).filter((defect) => defect.preTripCheckId === command.id)
    assert.deepEqual(
      defects.map(({ label, critical, note }) => ({ label, critical, note })),
      [
        { label: "Brakes", critical: true, note: "Pulls to the left" },
        { label: "Lights", critical: false, note: null },
      ],
    )
    const ticketId = defects[0].ticketId
    assert.ok(ticketId !== null)
    assert.equal(defects[1].ticketId, ticketId, "one ticket for the check")
    const [opened] = await withCompany(pool.db, a.companyId, (tx) => tx.select().from(ticketTable).where(and(eq(ticketTable.companyId, a.companyId), eq(ticketTable.id, ticketId))))
    assert.equal(opened.kind, "vehicle-defect")
    assert.equal(opened.priority, "high")
    assert.equal(opened.source, "driver-app")
    assert.equal(opened.routeId, route.id)
    assert.equal(opened.subject, "Pre-trip check found 2 defects on WH-24")

    const start = await one(envelope("start-route", route.id, { vehicleId: fleet.vehicles.wh24.id }, at("06:30")))
    assert.equal(start.outcome, "rejected")
    assert.equal(start.problem?.detail, notInService("WH-24", "maintenance", "vehicle"))
  })

  test("a minor defect is recorded and ticketed at medium, and the vehicle stays in service", async () => {
    const type = await setChecklist([{ label: "Brakes" }, { label: "Lights", critical: false }])
    const route = await minted()
    const [brakes, lights] = type.checklist
    const outcome = await one(
      envelope("pre-trip-check", route.id, {
        vehicleId: fleet.vehicles.wh24.id,
        items: [
          { itemId: brakes.id, passed: true },
          { itemId: lights.id, passed: false, note: "Left indicator out" },
        ],
      }),
    )
    assert.equal(outcome.outcome, "applied", JSON.stringify(outcome.problem))
    assert.equal(await vehicleStatus(fleet.vehicles.wh24.id), "active")
    const [defect] = (await defectsOf(fleet.vehicles.wh24.id, "open")).filter((row) => row.preTripCheckId === outcome.commandId)
    const [opened] = await withCompany(pool.db, a.companyId, (tx) => tx.select({ priority: ticketTable.priority }).from(ticketTable).where(and(eq(ticketTable.companyId, a.companyId), eq(ticketTable.id, defect.ticketId!))))
    assert.equal(opened.priority, "medium")
  })

  test("an answer off the list or an item unanswered is the command's 400; a check on a vehicle out of service or a finished route its 409", async () => {
    const type = await setChecklist([{ label: "Brakes" }, { label: "Lights", critical: false }])
    const route = await minted()
    const [brakes] = type.checklist
    const partial = await one(envelope("pre-trip-check", route.id, { vehicleId: fleet.vehicles.wh24.id, items: [{ itemId: brakes.id, passed: true }] }))
    assert.equal(partial.outcome, "rejected")
    assert.deepEqual(partial.problem?.errors, [{ path: "body.items", message: unanswered("Lights") }])
    const stranger = await one(envelope("pre-trip-check", route.id, { vehicleId: fleet.vehicles.wh24.id, items: [...type.checklist.map((item) => ({ itemId: item.id, passed: true })), { itemId: mint(), passed: true }] }))
    assert.deepEqual(stranger.problem?.errors, [{ path: "body.items.2.itemId", message: NOT_ON_THE_CHECKLIST }])

    await withCompany(pool.db, a.companyId, (tx) => tx.update(vehicleTable).set({ status: "unavailable" }).where(and(eq(vehicleTable.companyId, a.companyId), eq(vehicleTable.id, fleet.vehicles.wh24.id))))
    const out = await one(envelope("pre-trip-check", route.id, { vehicleId: fleet.vehicles.wh24.id, items: type.checklist.map((item) => ({ itemId: item.id, passed: true })) }))
    assert.equal(out.problem?.status, 409)
    assert.equal(out.problem?.detail, notInService("WH-24", "unavailable", "vehicle"))

    const planned = await minted({ status: "planned" })
    const early = await one(envelope("pre-trip-check", planned.id, { vehicleId: fleet.vehicles.wh25.id, items: type.checklist.map((item) => ({ itemId: item.id, passed: true })) }))
    assert.equal(early.problem?.detail, checkNotNow(planned.label))
  })

  test("the office resolves a defect once, with a note; the vehicle's status is its own edit", async () => {
    const type = await setChecklist([{ label: "Brakes" }])
    const route = await minted()
    const outcome = await one(envelope("pre-trip-check", route.id, { vehicleId: fleet.vehicles.wh24.id, items: [{ itemId: type.checklist[0].id, passed: false }] }))
    const [defect] = (await defectsOf(fleet.vehicles.wh24.id, "open")).filter((row) => row.preTripCheckId === outcome.commandId)
    const response = await olivia(`/vehicle-defects/${defect.id}/resolve`, { method: "POST", body: { note: "Pads replaced" } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const resolved = VehicleDefect.parse(await response.json())
    assert.equal(resolved.status, "resolved")
    assert.equal(resolved.resolutionNote, "Pads replaced")
    assert.equal(resolved.resolvedAt, NOW.toISOString())
    assert.equal(await vehicleStatus(fleet.vehicles.wh24.id), "maintenance")
    const twice = await olivia(`/vehicle-defects/${defect.id}/resolve`, { method: "POST", body: {} })
    const problem = await readProblem(twice)
    assert.equal(problem.status, 409)
    assert.equal(problem.detail, alreadyResolved("Brakes"))
    assert.equal((await readProblem(await olivia(`/vehicle-defects/${mint()}/resolve`, { method: "POST", body: {} }))).status, 404)
    assert.ok((await defectsOf(fleet.vehicles.wh24.id, "resolved")).some((row) => row.id === defect.id))
  })
})
