// The fleet's emissions (M10 of #293): a fuel's factor over its periods, a
// vehicle type's consumption set, and the report that measures a Monday's
// routes by them.
//
// The Monday, 2026-11-02, in Copenhagen Central, beside the execution
// fixtures' own week:
//   optimised  — WH-24 (diesel), its active Plan the optimiser's at 8 km, the
//                baseline it was optimised from at 10 km and one measured
//                since at 15 km; two residual stops and a glass
//   manual     — WH-24, its manual Plan at 12 km; three residual stops, one
//                of them removed by the dispatcher
//   unplanned  — unassigned, no Plan
//   measuring  — WH-24, its Plan still calculating
//   electric   — WH-25 (electric), measured at 5 km, no electric factor
//   cancelled  — WH-24, measured, cancelled: never drove
// The rear loader burns 450 ml of diesel and 1.3 kWh a kilometre; diesel
// emits 2658 g a litre from 2026, 2640 in 2025.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { EACH_FUEL_ONCE, EmissionsReport, FuelEmissionFactor, type FuelEmissionFactorCreate } from "@waste/contracts/emissions"
import { Page } from "@waste/contracts/pagination"
import { VehicleType } from "@waste/contracts/vehicle-types"
import { createDb, type Database } from "@waste/db/client"
import { route } from "@waste/db/schema/execution"
import { vehicle } from "@waste/db/schema/fleet"
import { plan } from "@waste/db/schema/routing"
import { withCompany } from "@waste/db/tenant"
import { drivenGrams } from "@waste/domain/resources/emissions"
import { and, eq } from "drizzle-orm"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { at, seedExecution, seedRoute, type ExecutionFixtures, type RouteSeed, type SeededRoute } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures, type PlanningFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the proofs and the Plans' ledgers the fixtures append, which `wms_api` may not delete. */
const owner = ownerUnderTest()

const DAY = "2026-11-02"
const NOW = new Date("2026-11-03T08:00:00Z")
const DIESEL_2026: FuelEmissionFactorCreate = { fuel: "diesel", gramsPerUnit: 2658, source: "Energistyrelsen, standard factors for the reporting year 2025: gas oil 35.87 GJ/m³ at 74.10 t CO2/TJ", validFrom: "2026-01-01" }

describe("the fleet's emissions", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let a: Tenant
  let b: Tenant
  let planning: PlanningFixtures
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  let other: Call
  /** The viewer: Improve's Performance and nothing it measures. */
  let performanceOnly: Call
  const routes: Record<"optimised" | "manual" | "unplanned" | "measuring" | "electric" | "cancelled" | "lastYear", SeededRoute> = {} as never

  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const ok = async <T>(response: Response, schema: { parse: (value: unknown) => T }): Promise<T> => {
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }

  /** A Plan on a route, made its active one where said: measured when `metres` is given, calculating when null. */
  async function planOn(seeded: SeededRoute, solver: "optimiser" | "manual" | "baseline", metres: number | null, active: boolean): Promise<void> {
    const id = testId()
    await withCompany(pool.db, a.companyId, async (tx) => {
      await tx.insert(plan).values({
        id,
        companyId: a.companyId,
        projectId: seeded.projectId,
        routeId: seeded.id,
        solver,
        status: metres === null ? "calculating" : "ready",
        fingerprint: `emissions-${id}`,
        trip: "stops-only",
        provider: "fake",
        distanceMetres: metres,
        durationSeconds: metres === null ? null : Math.round(metres / 8),
      })
      if (active) await tx.update(route).set({ activePlanId: id }).where(and(eq(route.companyId, a.companyId), eq(route.id, seeded.id)))
    })
  }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    const keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    planning = await seedPlanning(pool, a)
    fleet = await seedFleet(pool, a, planning)
    ex = await seedExecution(pool, a, fleet)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: "improve.performance", actions: ["view"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOW })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    performanceOnly = callingAs(app, keys, a.users.viewer, a.companyId)

    // WH-24 runs on diesel, WH-25 on electricity.
    await withCompany(pool.db, a.companyId, async (tx) => {
      await tx.update(vehicle).set({ fuel: "diesel" }).where(and(eq(vehicle.companyId, a.companyId), eq(vehicle.id, fleet.vehicles.wh24.id)))
      await tx.update(vehicle).set({ fuel: "electric" }).where(and(eq(vehicle.companyId, a.companyId), eq(vehicle.id, fleet.vehicles.wh25.id)))
    })

    const { bin1, bin2, bin3 } = ex.containers
    const { parkvej, havnegade, norrebrogade } = ex.properties
    const fresh = (seed: RouteSeed) => seedRoute(pool, a, fleet, ex, { operatingDate: DAY, ...seed })
    routes.optimised = await fresh({
      plannedVehicleId: fleet.vehicles.wh24.id,
      pickups: [
        { containerId: bin1.id, propertyId: parkvej.id },
        { containerId: bin2.id, propertyId: havnegade.id },
        { containerId: bin3.id, propertyId: norrebrogade.id, wasteFractionId: ex.fractions.glass.id },
      ],
    })
    routes.manual = await fresh({
      plannedVehicleId: fleet.vehicles.wh24.id,
      pickups: [
        { containerId: bin1.id, propertyId: parkvej.id },
        { containerId: bin2.id, propertyId: havnegade.id },
        // Withdrawn by the dispatcher: not a stop the split counts.
        { containerId: bin3.id, propertyId: norrebrogade.id, wasteFractionId: ex.fractions.glass.id, status: "skipped", reason: "removed-by-dispatcher", outcomeAt: at(DAY, "05:00") },
      ],
    })
    routes.unplanned = await fresh({})
    routes.measuring = await fresh({ plannedVehicleId: fleet.vehicles.wh24.id })
    routes.electric = await fresh({ plannedVehicleId: fleet.vehicles.wh25.id })
    routes.cancelled = await fresh({ status: "cancelled", plannedVehicleId: fleet.vehicles.wh24.id })
    // The last Monday of 2025, judged by 2025's factor.
    routes.lastYear = await fresh({ operatingDate: "2025-12-29", plannedVehicleId: fleet.vehicles.wh24.id })
    await planOn(routes.optimised, "baseline", 10_000, false)
    await planOn(routes.optimised, "optimiser", 8_000, true)
    // A baseline measured since, over other stops: not the one the active Plan was optimised from.
    await planOn(routes.optimised, "baseline", 15_000, false)
    await planOn(routes.manual, "manual", 12_000, true)
    await planOn(routes.measuring, "manual", null, true)
    await planOn(routes.electric, "manual", 5_000, true)
    await planOn(routes.cancelled, "manual", 9_000, true)
    await planOn(routes.lastYear, "manual", 10_000, true)
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  describe("a vehicle type's consumption", () => {
    test("is replaced whole, read in fuel order with each fuel's unit, and moves the type's updatedAt", async () => {
      const id = planning.vehicleTypes.rearLoader.id
      const before = await ok(await olivia(`/vehicle-types/${id}`), VehicleType)
      assert.deepEqual(before.consumption, [])
      const put = await olivia(`/vehicle-types/${id}/consumption`, { method: "PUT", body: { consumption: [{ fuel: "electric", milliUnitsPerKm: 1300 }, { fuel: "diesel", milliUnitsPerKm: 450 }] } })
      const answered = await ok(put, VehicleType)
      assert.deepEqual(answered.consumption, [
        { fuel: "diesel", unit: "litre", milliUnitsPerKm: 450 },
        { fuel: "electric", unit: "kwh", milliUnitsPerKm: 1300 },
      ])
      assert.ok(answered.updatedAt > before.updatedAt, "the set is part of the type")
      assert.deepEqual(answered.containerTypeIds, before.containerTypeIds, "the container types stand")
      assert.deepEqual(await ok(await olivia(`/vehicle-types/${id}`), VehicleType), answered, "the answer is the next read")
      const listed = await ok(await olivia("/vehicle-types"), Page(VehicleType))
      assert.deepEqual(listed.items.find((type) => type.id === id)?.consumption, answered.consumption)
    })

    test("refuses a fuel twice, an amount out of bounds, and another company's type", async () => {
      const id = planning.vehicleTypes.glassCrane.id
      const twice = await refused(await olivia(`/vehicle-types/${id}/consumption`, { method: "PUT", body: { consumption: [{ fuel: "diesel", milliUnitsPerKm: 400 }, { fuel: "diesel", milliUnitsPerKm: 410 }] } }), 400)
      assert.deepEqual(twice.errors?.map((error) => [error.path, error.message]), [["consumption", EACH_FUEL_ONCE]])
      await refused(await olivia(`/vehicle-types/${id}/consumption`, { method: "PUT", body: { consumption: [{ fuel: "diesel", milliUnitsPerKm: 0 }] } }), 400)
      await refused(await other(`/vehicle-types/${id}/consumption`, { method: "PUT", body: { consumption: [] } }), 404)
    })

    test("an empty set clears it", async () => {
      const id = planning.vehicleTypes.glassCrane.id
      await ok(await olivia(`/vehicle-types/${id}/consumption`, { method: "PUT", body: { consumption: [{ fuel: "hvo", milliUnitsPerKm: 380 }] } }), VehicleType)
      assert.deepEqual((await ok(await olivia(`/vehicle-types/${id}/consumption`, { method: "PUT", body: { consumption: [] } }), VehicleType)).consumption, [])
    })
  })

  describe("a fuel's emission factor", () => {
    let current: FuelEmissionFactor
    let earlier: FuelEmissionFactor

    test("is created with its fuel's unit and read back at its Location", async () => {
      current = await created(olivia, "/fuel-emission-factors", await olivia("/fuel-emission-factors", { method: "POST", body: DIESEL_2026 }), FuelEmissionFactor)
      assert.deepEqual([current.fuel, current.unit, current.gramsPerUnit, current.validFrom, current.validTo], ["diesel", "litre", 2658, "2026-01-01", null])
      earlier = await created(olivia, "/fuel-emission-factors", await olivia("/fuel-emission-factors", { method: "POST", body: { ...DIESEL_2026, gramsPerUnit: 2640, validFrom: "2025-01-01", validTo: "2026-01-01" } }), FuelEmissionFactor)
    })

    test("never holds a day with another period of its fuel", async () => {
      const overlap = await refused(await olivia("/fuel-emission-factors", { method: "POST", body: { ...DIESEL_2026, validFrom: "2026-06-01" } }), 409)
      assert.match(overlap.detail ?? "", /Another factor for this fuel is in force over part of that period/)
      // Another fuel, the same days: its own periods.
      await created(olivia, "/fuel-emission-factors", await olivia("/fuel-emission-factors", { method: "POST", body: { ...DIESEL_2026, fuel: "hvo", gramsPerUnit: 0, source: "Demo value" } }), FuelEmissionFactor)
      // Reopening the 2025 period would run into 2026's.
      await refused(await olivia(`/fuel-emission-factors/${earlier.id}`, { method: "PATCH", body: { validTo: null } }), 409)
    })

    test("is patched in its end and its source alone, the end after the start", async () => {
      const resourced = await ok(await olivia(`/fuel-emission-factors/${earlier.id}`, { method: "PATCH", body: { source: "Energistyrelsen, 2024 list" } }), FuelEmissionFactor)
      assert.equal(resourced.source, "Energistyrelsen, 2024 list")
      await refused(await olivia(`/fuel-emission-factors/${earlier.id}`, { method: "PATCH", body: { validTo: "2025-01-01" } }), 400)
      await refused(await olivia(`/fuel-emission-factors/${earlier.id}`, { method: "PATCH", body: { gramsPerUnit: 2600 } }), 400)
      await refused(await other(`/fuel-emission-factors/${earlier.id}`, { method: "PATCH", body: { source: "Not ours" } }), 404)
    })

    test("lists by fuel and by the day in force, and another company's are not listed", async () => {
      const onDay = await ok(await olivia("/fuel-emission-factors?fuel=diesel&validOn=2025-12-31"), Page(FuelEmissionFactor))
      assert.deepEqual(onDay.items.map((factor) => factor.id), [earlier.id])
      const diesel = await ok(await olivia("/fuel-emission-factors?fuel=diesel"), Page(FuelEmissionFactor))
      assert.deepEqual(diesel.items.map((factor) => factor.id).sort(), [current.id, earlier.id].sort())
      assert.deepEqual((await ok(await other("/fuel-emission-factors"), Page(FuelEmissionFactor))).items, [])
    })
  })

  describe("the report", () => {
    const optimisedGrams = drivenGrams(8_000, 450, 2658)
    const manualGrams = drivenGrams(12_000, 450, 2658)

    test("measures each route whole, counts the unmeasured by their first gap, and leaves the cancelled out", async () => {
      const report = await ok(await olivia(`/reports/emissions?from=${DAY}&to=${DAY}`), EmissionsReport)
      assert.deepEqual(report.window, { projectId: null, from: DAY, to: DAY })
      assert.deepEqual(report.planned, { routes: 2, metres: 20_000, grams: optimisedGrams + manualGrams })
      assert.equal(report.actualGrams, null)
      assert.deepEqual(report.unmeasured, [
        { gap: "no-plan", routes: 1 },
        { gap: "plan-unmeasured", routes: 1 },
        { gap: "no-factor", routes: 1 },
      ])
    })

    test("sums the routes by vehicle and by project, and splits each route's grams by its counted stops", async () => {
      const report = await ok(await olivia(`/reports/emissions?from=${DAY}&to=${DAY}`), EmissionsReport)
      assert.deepEqual(report.byVehicle, [{ vehicleId: fleet.vehicles.wh24.id, callsign: fleet.vehicles.wh24.label, fuel: "diesel", routes: 2, metres: 20_000, grams: optimisedGrams + manualGrams }])
      assert.deepEqual(report.byProject, [{ projectId: a.projects.copenhagen.id, name: a.projects.copenhagen.name, routes: 2, metres: 20_000, grams: optimisedGrams + manualGrams }])
      // The optimised route: two residual stops and a glass; the manual one's glass stop was withdrawn, so all its grams are residual's.
      const glass = Math.floor(optimisedGrams / 3) + (optimisedGrams % 3 === 2 ? 1 : 0)
      const residual = optimisedGrams - glass + manualGrams
      const byName = new Map(report.byFraction.map((row) => [row.wasteFractionId, row.grams]))
      assert.equal(byName.get(ex.fractions.glass.id), glass)
      assert.equal(byName.get(ex.fractions.residual.id), residual)
      assert.equal(report.byFraction.reduce((sum, row) => sum + row.grams, 0), report.planned.grams, "the split sums to the whole")
    })

    test("counts the optimiser's saving against the baseline it was optimised from, never one measured since", async () => {
      const report = await ok(await olivia(`/reports/emissions?from=${DAY}&to=${DAY}`), EmissionsReport)
      assert.deepEqual(report.saving, { routes: 1, metres: 2_000, grams: drivenGrams(10_000, 450, 2658) - optimisedGrams })
    })

    test("judges a route by the factor in force on its operating day", async () => {
      const lastYear = await ok(await olivia("/reports/emissions?from=2025-12-29&to=2025-12-29"), EmissionsReport)
      assert.deepEqual(lastYear.planned, { routes: 1, metres: 10_000, grams: drivenGrams(10_000, 450, 2640) })
      // The fixtures' Monday of 2026-10-05 holds their three routes, none with a Plan: all unmeasured, none counted as zero.
      const fixtures = await ok(await olivia("/reports/emissions?from=2026-10-05&to=2026-10-05"), EmissionsReport)
      assert.deepEqual(fixtures.planned, { routes: 0, metres: 0, grams: 0 })
      assert.deepEqual(fixtures.unmeasured, [{ gap: "no-plan", routes: 3 }])
    })

    test("narrows to a project the caller works in, and refuses one they do not", async () => {
      const harbor = await ok(await olivia(`/reports/emissions?projectId=${a.projects.harbor.id}&from=${DAY}&to=${DAY}`), EmissionsReport)
      assert.deepEqual(harbor.planned, { routes: 0, metres: 0, grams: 0 })
      assert.deepEqual(harbor.unmeasured, [])
      await refused(await olivia(`/reports/emissions?projectId=${b.projects.copenhagen.id}&from=${DAY}&to=${DAY}`), 400)
      const theirs = await ok(await other(`/reports/emissions?from=${DAY}&to=${DAY}`), EmissionsReport)
      assert.deepEqual(theirs.planned, { routes: 0, metres: 0, grams: 0 }, "another company reads none of these routes")
    })

    test("is read under Performance and the routes' grant both, over a window of at most a year", async () => {
      const problem = await refused(await performanceOnly(`/reports/emissions?from=${DAY}&to=${DAY}`), 403)
      assert.match(problem.detail ?? "", /route-studio\.routes/)
      await refused(await olivia("/reports/emissions?from=2025-01-01&to=2026-01-02"), 400)
      await refused(await olivia(`/reports/emissions?from=${DAY}&to=${DAY}&interval=day`), 400)
    })
  })
})
