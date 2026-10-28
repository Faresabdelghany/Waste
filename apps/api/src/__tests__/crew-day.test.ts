// A route's crew against the rest of its day (O7 of #290) through the API:
// a live allocation reserving the vehicle or the driver with another crew,
// and the crew on another route of the day — a known overlap refused
// outright, spans apart taken, a span not known taken only with
// `acceptSameDay` — on assign, reschedule, a new ad-hoc route and a split;
// and the order the refusals come in: away, allocated, double-booked, unfit.
import assert from "node:assert/strict"
import { randomInt } from "node:crypto"
import { after, before, describe, test } from "node:test"

import { RouteDetail } from "@waste/contracts/routes"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { product } from "@waste/db/schema/catalogue"
import { containerServicePlacement } from "@waste/db/schema/containers"
import { customer } from "@waste/db/schema/customers"
import { route as routeTable } from "@waste/db/schema/execution"
import { driver } from "@waste/db/schema/fleet"
import { plan } from "@waste/db/schema/routing"
import { withCompany } from "@waste/db/tenant"
import { eq } from "drizzle-orm"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { FIXTURE_DAY, seedExecution, seedRoute, type ExecutionFixtures, type SeededRoute } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const owner = ownerUnderTest()

/** The request's clock, pinned: the fixtures' Monday morning; every test's routes run on a later weekday of their own. */
const NOW = new Date(`${FIXTURE_DAY}T06:00:00Z`)

describe("a route's crew against the rest of its day", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let olivia: Call
  /** A second driver who may take WH-24 and WH-25, beside Mads Jensen. */
  const anna = { id: testId(), name: "Anna Berg" }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    const scoped = { companyId: a.companyId, projectId: a.projects.copenhagen.id }
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.insert(driver).values({ id: anna.id, ...scoped, name: anna.name, employment: "employee", licenceClass: "ce", licenceExpiry: "2030-12-31", status: "active" })
      // The bins served at their addresses since January, so a split's stops find their placements on the new route.
      const customerId = testId()
      const productId = testId()
      const agreementId = testId()
      await tx.insert(customer).values({ id: customerId, companyId: a.companyId, kind: "organisation", name: "Københavns Boliger", registrationNumber: String(randomInt(10_000_000, 100_000_000)), status: "active" })
      await tx.insert(product).values({ id: productId, ...scoped, name: "Residual 240 L", kind: "container-collection", status: "active", unit: "pickup", containerTypeId: ex.containerTypes.bin.id, wasteFractionId: ex.fractions.residual.id })
      await tx.insert(agreement).values({ id: agreementId, ...scoped, validFrom: "2026-01-01", number: "AGR-343-DAY", customerId, payerCustomerId: customerId, status: "active", billingCadence: "monthly", currency: "DKK" })
      for (const [bin, place] of [
        [ex.containers.bin1, ex.properties.parkvej],
        [ex.containers.bin2, ex.properties.havnegade],
        [ex.containers.bin3, ex.properties.norrebrogade],
      ] as const) {
        const subscriptionId = testId()
        await tx.insert(subscription).values({ id: subscriptionId, ...scoped, validFrom: "2026-01-01", agreementId, productId, propertyId: place.id })
        await tx.insert(containerServicePlacement).values({ id: testId(), ...scoped, validFrom: "2026-01-01", containerId: bin.id, subscriptionId, wasteFractionId: ex.fractions.residual.id })
      }
    })
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOW })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  /** A planned Copenhagen route with no stops on the day given, its span `start` plus `minutes` where both are said (a measured Plan of that drive). */
  const route = async (day: string, values: Parameters<typeof seedRoute>[4] & { start?: string; minutes?: number } = {}): Promise<SeededRoute> => {
    const { start, minutes, ...seed } = values
    const seeded = await seedRoute(pool, a, fleet, ex, { operatingDate: day, pickups: [], plannedStartTime: start ?? null, ...seed })
    if (minutes !== undefined) {
      const planId = testId()
      await ownerPool.db.insert(plan).values({ id: planId, companyId: a.companyId, projectId: seeded.projectId, routeId: seeded.id, solver: "manual", status: "ready", fingerprint: `o7-${planId}`, trip: "stops-only", provider: "fake", distanceMetres: 9_000, durationSeconds: minutes * 60 })
      await ownerPool.db.update(routeTable).set({ activePlanId: planId }).where(eq(routeTable.id, seeded.id))
    }
    return seeded
  }
  const post = (path: string, body: Record<string, unknown>) => olivia(path, { method: "POST", body })
  const refused = async (response: Response, status = 409) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return (await readProblem(response)).detail
  }
  const ok = async (response: Response, status = 200) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return RouteDetail.parse(await response.json())
  }
  const allocate = async (values: Record<string, unknown>): Promise<string> => {
    const response = await post("/vehicle-allocations", { projectId: a.projects.copenhagen.id, ...values })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return ((await response.json()) as { id: string }).id
  }

  describe("the crew on another route of the day", () => {
    test("a known overlap is refused, and acceptSameDay does not take it back", async () => {
      const day = "2026-10-06"
      const morning = await route(day, { plannedDriverId: fleet.drivers.mads.id, start: "07:00", minutes: 240 })
      const later = await route(day, { start: "10:00", minutes: 120 })
      const detail = `Mads Jensen is planned on route ${morning.label} 07:00–11:00, which overlaps route ${later.label}'s 10:00–12:00`
      assert.equal(await refused(await post(`/routes/${later.id}/assign`, { driverId: fleet.drivers.mads.id })), detail)
      assert.equal(await refused(await post(`/routes/${later.id}/assign`, { driverId: fleet.drivers.mads.id, acceptSameDay: true })), detail)
    })

    test("known spans apart are taken, one ending as the other starts", async () => {
      const day = "2026-10-07"
      await route(day, { plannedVehicleId: fleet.vehicles.wh24.id, start: "07:00", minutes: 180 })
      const afternoon = await route(day, { start: "10:00", minutes: 120 })
      assert.equal((await ok(await post(`/routes/${afternoon.id}/assign`, { vehicleId: fleet.vehicles.wh24.id }))).planned.vehicleId, fleet.vehicles.wh24.id)
    })

    test("a span not known is refused until the body says acceptSameDay", async () => {
      const day = "2026-10-08"
      const first = await route(day, { plannedVehicleId: fleet.vehicles.wh24.id, start: "07:00" })
      const second = await route(day, { start: "13:00", minutes: 60 })
      assert.equal(
        await refused(await post(`/routes/${second.id}/assign`, { vehicleId: fleet.vehicles.wh24.id })),
        `WH-24 is planned on route ${first.label} the same day, and the times of it and route ${second.label} are not both known (a planned start and a measured Plan); confirm the same day to plan WH-24 on both`,
      )
      await ok(await post(`/routes/${second.id}/assign`, { vehicleId: fleet.vehicles.wh24.id, acceptSameDay: true }))
    })

    test("a reschedule judges the crew on the new day, and a new start against the day's other routes", async () => {
      const day = "2026-10-13"
      const other = await route(day, { plannedDriverId: fleet.drivers.mads.id, start: "07:00", minutes: 120 })
      const moving = await route("2026-10-12", { plannedDriverId: fleet.drivers.mads.id, start: "08:00", minutes: 60 })
      assert.match(await refused(await post(`/routes/${moving.id}/reschedule`, { operatingDate: day })), new RegExp(`^Mads Jensen is planned on route ${other.label} 07:00–09:00, which overlaps route ${moving.label}'s 08:00–09:00$`))
      const moved = await ok(await post(`/routes/${moving.id}/reschedule`, { operatingDate: day, plannedStartTime: "09:00" }))
      assert.equal(moved.operatingDate, day, "apart once the start moves with it")
      assert.match(await refused(await post(`/routes/${moving.id}/reschedule`, { plannedStartTime: "08:30" })), /overlaps/, "a start alone is judged too")
    })

    test("a new ad-hoc route and a split's route have no measured Plan, so beside another of the day they take acceptSameDay", async () => {
      const day = "2026-10-14"
      const busy = await route(day, { plannedDriverId: fleet.drivers.mads.id, start: "07:00", minutes: 120 })
      const body = { projectId: a.projects.copenhagen.id, operatingDate: day, driverId: fleet.drivers.mads.id }
      assert.match(await refused(await post("/routes", body)), new RegExp(`^Mads Jensen is planned on route ${busy.label} the same day`))
      await ok(await post("/routes", { ...body, acceptSameDay: true }), 201)
      const splitting = await seedRoute(pool, a, fleet, ex, { operatingDate: day })
      const split = { pickupIds: [splitting.pickupIds[0]], driverId: fleet.drivers.mads.id }
      assert.match(await refused(await post(`/routes/${splitting.id}/split`, split)), /confirm the same day/)
      await ok(await post(`/routes/${splitting.id}/split`, { ...split, acceptSameDay: true }), 201)
    })
  })

  describe("the day's allocations", () => {
    test("one reserving the vehicle with another driver, or the driver with another vehicle, is refused naming its window; its own crew is taken", async () => {
      const day = "2026-10-15"
      await allocate({ vehicleId: fleet.vehicles.wh25.id, driverId: anna.id, plannedFrom: `${day}T06:00:00+02:00`, plannedTo: `${day}T14:00:00+02:00` })
      const planned = await route(day)
      assert.equal(
        await refused(await post(`/routes/${planned.id}/assign`, { vehicleId: fleet.vehicles.wh25.id, driverId: fleet.drivers.mads.id })),
        "WH-25 is allocated Thu 15 Oct 06:00–14:00 with Anna Berg; plan the route with the allocation's crew, or change the allocation first",
      )
      assert.equal(
        await refused(await post(`/routes/${planned.id}/assign`, { vehicleId: fleet.vehicles.wh24.id, driverId: anna.id })),
        "Anna Berg is allocated Thu 15 Oct 06:00–14:00 with WH-25; plan the route with the allocation's crew, or change the allocation first",
      )
      await ok(await post(`/routes/${planned.id}/assign`, { vehicleId: fleet.vehicles.wh25.id }))
      await ok(await post(`/routes/${planned.id}/assign`, { driverId: anna.id }))
    })

    test("one of another day is not asked: a window ending at the day's midnight does not touch it", async () => {
      const day = "2026-10-16"
      await allocate({ vehicleId: fleet.vehicles.wh25.id, driverId: anna.id, plannedFrom: "2026-10-15T20:00:00+02:00", plannedTo: `${day}T00:00:00+02:00` })
      const planned = await route(day)
      await ok(await post(`/routes/${planned.id}/assign`, { vehicleId: fleet.vehicles.wh25.id, driverId: fleet.drivers.mads.id }))
    })
  })

  describe("the order of the refusals", () => {
    test("away, then allocated, then double-booked, then the vehicle's fit", async () => {
      const day = "2026-10-20"
      const planned = await seedRoute(pool, a, fleet, ex, { operatingDate: day, plannedStartTime: "07:00" })
      const assign = () => post(`/routes/${planned.id}/assign`, { vehicleId: fleet.vehicles.wh25.id, driverId: fleet.drivers.mads.id })
      // Every rule broken at once: WH-25 out of use, allocated with Anna, on another route at once, and carrying no residual waste.
      await route(day, { plannedVehicleId: fleet.vehicles.wh25.id, plannedDriverId: anna.id, start: "07:00", minutes: 60 })
      const allocation = await allocate({ vehicleId: fleet.vehicles.wh25.id, driverId: anna.id, plannedFrom: `${day}T05:00:00+02:00`, plannedTo: `${day}T06:00:00+02:00` })
      const kitted = await olivia(`/vehicles/${fleet.vehicles.wh25.id}/compartments`, { method: "PUT", body: { compartments: [{ wasteFractionIds: [ex.fractions.glass.id] }] } })
      assert.equal(kitted.status, 200, JSON.stringify(await kitted.clone().json()))
      const outOfUse = await post("/vehicle-unavailability", { vehicleId: fleet.vehicles.wh25.id, validFrom: day, validTo: "2026-10-21", reason: "maintenance" })
      assert.equal(outOfUse.status, 201, JSON.stringify(await outOfUse.clone().json()))

      assert.match(await refused(await assign()), /^CN 42 019 is unavailable|^WH-25 is unavailable/, "away first")
      const { id: periodId } = (await outOfUse.json()) as { id: string }
      assert.equal((await olivia(`/vehicle-unavailability/${periodId}`, { method: "DELETE" })).status, 204)
      assert.match(await refused(await assign()), /^WH-25 is allocated/, "then allocated")
      assert.equal((await post(`/vehicle-allocations/${allocation}/release`, { reason: "Anna takes the other route" })).status, 200)
      assert.match(await refused(await assign()), /^WH-25 is planned on route/, "then double-booked")
      assert.match(await refused(await post(`/routes/${planned.id}/assign`, { vehicleId: fleet.vehicles.wh25.id, driverId: fleet.drivers.mads.id, acceptSameDay: true })), /^WH-25 has no compartment for Residual waste/, "then the fit")
    })
  })
})
