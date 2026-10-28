// Fleet rules on the server (O7 of #290) through the API: a vehicle named
// afresh on `assign`, the planned vehicle of a route stops are moved, merged
// or added onto, each serves the stops it would carry — a fraction one of its
// compartments carries, a container its type lifts, a stop no heavier than one
// trip takes of its fraction — or the command is refused in the first rule's
// sentence. A route heavier than one payload is not refused: its Plan unloads
// on the way.
import assert from "node:assert/strict"
import { randomInt } from "node:crypto"
import { after, before, beforeEach, describe, test } from "node:test"

import { RouteDetail } from "@waste/contracts/routes"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { containerType, product, wasteFraction } from "@waste/db/schema/catalogue"
import { containerServicePlacement } from "@waste/db/schema/containers"
import { customer } from "@waste/db/schema/customers"
import { vehicleCompartment, vehicleCompartmentFraction } from "@waste/db/schema/fleet"
import { containerTypeVehicleType } from "@waste/db/schema/fleet-types"
import { withCompany } from "@waste/db/tenant"
import { and, eq, inArray } from "drizzle-orm"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { FIXTURE_DAY, seedExecution, seedRoute, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures, type PlanningFixtures } from "./scheme-fixtures"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const owner = ownerUnderTest()

/** The request's clock, pinned: an hour before noon on the fixtures' Monday. */
const NOW = new Date(`${FIXTURE_DAY}T09:00:00Z`)

describe("fleet rules on the server", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let planning: PlanningFixtures
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let olivia: Call

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    planning = await seedPlanning(pool, a)
    fleet = await seedFleet(pool, a, planning)
    ex = await seedExecution(pool, a, fleet)
    // The three bins served at their addresses since January, so Add stop and a move find their placements; residual waste at 200 kg/m³, so a 240 L bin is expected to weigh 48 kg.
    const scoped = { companyId: a.companyId, projectId: a.projects.copenhagen.id }
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.update(wasteFraction).set({ densityKgPerCubicMetre: 200 }).where(and(eq(wasteFraction.companyId, a.companyId), eq(wasteFraction.id, ex.fractions.residual.id)))
      const customerId = testId()
      const productId = testId()
      const agreementId = testId()
      await tx.insert(customer).values({ id: customerId, companyId: a.companyId, kind: "organisation", name: "Københavns Boliger", registrationNumber: String(randomInt(10_000_000, 100_000_000)), status: "active" })
      await tx.insert(product).values({ id: productId, ...scoped, name: "Residual 240 L", kind: "container-collection", status: "active", unit: "pickup", containerTypeId: ex.containerTypes.bin.id, wasteFractionId: ex.fractions.residual.id })
      await tx.insert(agreement).values({ id: agreementId, ...scoped, validFrom: "2026-01-01", number: "AGR-343", customerId, payerCustomerId: customerId, status: "active", billingCadence: "monthly", currency: "DKK" })
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

  /** WH-25's compartments, replaced whole through the API — none, as the fixtures write it, for a vehicle that carries anything — and its type lifting what is said (nothing said: any). */
  const kit = async (compartments: { capacityKg?: number; wasteFractionIds: string[] }[], lifts: string[] = []) => {
    if (compartments.length > 0) {
      const response = await olivia(`/vehicles/${fleet.vehicles.wh25.id}/compartments`, { method: "PUT", body: { compartments } })
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    }
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      if (compartments.length === 0) {
        const chambers = tx.select({ id: vehicleCompartment.id }).from(vehicleCompartment).where(and(eq(vehicleCompartment.companyId, a.companyId), eq(vehicleCompartment.vehicleId, fleet.vehicles.wh25.id)))
        await tx.delete(vehicleCompartmentFraction).where(and(eq(vehicleCompartmentFraction.companyId, a.companyId), inArray(vehicleCompartmentFraction.vehicleCompartmentId, chambers)))
        await tx.delete(vehicleCompartment).where(and(eq(vehicleCompartment.companyId, a.companyId), eq(vehicleCompartment.vehicleId, fleet.vehicles.wh25.id)))
      }
      await tx.delete(containerTypeVehicleType).where(and(eq(containerTypeVehicleType.companyId, a.companyId), eq(containerTypeVehicleType.vehicleTypeId, planning.vehicleTypes.rearLoader.id)))
      if (lifts.length > 0) await tx.insert(containerTypeVehicleType).values(lifts.map((containerTypeId) => ({ id: testId(), companyId: a.companyId, containerTypeId, vehicleTypeId: planning.vehicleTypes.rearLoader.id })))
    })
  }
  beforeEach(async () => {
    if (a !== undefined) await kit([])
  })

  const route = (values: Parameters<typeof seedRoute>[4] = {}) => seedRoute(pool, a, fleet, ex, values)
  const assign = (id: string, body: Record<string, unknown>) => olivia(`/routes/${id}/assign`, { method: "POST", body })
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const ok = async (response: Response) => {
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return RouteDetail.parse(await response.json())
  }

  describe("POST /routes/:id/assign", () => {
    test("refuses a vehicle none of whose compartments carries a fraction the route's open stops collect, counting them", async () => {
      await kit([{ wasteFractionIds: [ex.fractions.glass.id] }])
      const planned = await route()
      const problem = await refused(await assign(planned.id, { vehicleId: fleet.vehicles.wh25.id }), 409)
      assert.equal(problem.detail, `WH-25 has no compartment for Residual waste, which 3 stops of route ${planned.label} collect`)
    })

    test("takes a vehicle carrying the fraction in one of its compartments, or with none naming a fraction", async () => {
      await kit([{ wasteFractionIds: [ex.fractions.glass.id] }, { wasteFractionIds: [ex.fractions.residual.id] }])
      assert.equal((await ok(await assign((await route()).id, { vehicleId: fleet.vehicles.wh25.id }))).planned.vehicleId, fleet.vehicles.wh25.id)
      await kit([])
      assert.equal((await ok(await assign((await route()).id, { vehicleId: fleet.vehicles.wh25.id }))).planned.vehicleId, fleet.vehicles.wh25.id)
    })

    test("refuses a vehicle whose type does not lift the stops' containers, where its type names the containers it lifts", async () => {
      // A type pairing another container type alone: the bins are not among them.
      const other = await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        const id = testId()
        await tx.insert(containerType).values({ id, companyId: a.companyId, name: "1100 L bin", volumeLitres: 1100 })
        return id
      })
      await kit([], [other])
      const planned = await route()
      const problem = await refused(await assign(planned.id, { vehicleId: fleet.vehicles.wh25.id }), 409)
      assert.equal(problem.detail, `WH-25 cannot lift a 240 L bin, which 3 stops of route ${planned.label} empty`)
      await kit([], [other, ex.containerTypes.bin.id])
      await ok(await assign(planned.id, { vehicleId: fleet.vehicles.wh25.id }))
    })

    test("refuses a stop heavier than one trip takes of its fraction, and not a route heavier than one payload: its Plan unloads on the way", async () => {
      await kit([{ capacityKg: 40, wasteFractionIds: [ex.fractions.residual.id] }])
      const planned = await route()
      const problem = await refused(await assign(planned.id, { vehicleId: fleet.vehicles.wh25.id }), 409)
      assert.equal(problem.detail, `WH-25 takes 40 kg of Residual waste on one trip, and 3 stops of route ${planned.label} are expected to weigh up to 48 kg each`)
      // 100 kg a trip: three bins of 48 kg are 144 kg, two trips.
      await kit([{ capacityKg: 100, wasteFractionIds: [ex.fractions.residual.id] }])
      const detail = await ok(await assign(planned.id, { vehicleId: fleet.vehicles.wh25.id }))
      assert.equal(detail.workload.overCapacityKg, null, "the vehicle's own payload is unsaid; the compartments bound only one trip")
    })

    test("judges only a vehicle named afresh: a driver alone moved asks nothing of the stored one", async () => {
      const planned = await route({ plannedVehicleId: fleet.vehicles.wh25.id })
      await kit([{ wasteFractionIds: [ex.fractions.glass.id] }])
      await ok(await assign(planned.id, { driverId: fleet.drivers.mads.id }))
    })
  })

  describe("stops joining a route with a planned vehicle", () => {
    test("a move or a merge is refused where the vehicle cannot serve them, naming the route they come from", async () => {
      await kit([{ wasteFractionIds: [ex.fractions.glass.id] }])
      const from = await route()
      const to = await route({ pickups: [], plannedVehicleId: fleet.vehicles.wh25.id })
      const moving = await olivia(`/routes/${from.id}/move-stops`, { method: "POST", body: { pickupIds: [from.pickupIds[0]], toRouteId: to.id } })
      assert.equal((await refused(moving, 409)).detail, `WH-25 has no compartment for Residual waste, which a stop of route ${from.label} collects`)
      const merging = await olivia(`/routes/${to.id}/merge`, { method: "POST", body: { routeId: from.id } })
      assert.equal((await refused(merging, 409)).detail, `WH-25 has no compartment for Residual waste, which 3 stops of route ${from.label} collect`)
      await kit([{ wasteFractionIds: [ex.fractions.residual.id] }])
      await ok(await olivia(`/routes/${from.id}/move-stops`, { method: "POST", body: { pickupIds: [from.pickupIds[0]], toRouteId: to.id } }))
    })

    test("a split's new route takes only a vehicle that serves the stops split onto it", async () => {
      await kit([{ wasteFractionIds: [ex.fractions.glass.id] }])
      const from = await route()
      const splitting = await olivia(`/routes/${from.id}/split`, { method: "POST", body: { pickupIds: [from.pickupIds[0], from.pickupIds[1]], vehicleId: fleet.vehicles.wh25.id } })
      assert.equal((await refused(splitting, 409)).detail, `WH-25 has no compartment for Residual waste, which 2 stops of route ${from.label} collect`)
    })

    test("Add stop is refused where the route's vehicle cannot serve the stop", async () => {
      await kit([{ wasteFractionIds: [ex.fractions.glass.id] }])
      const to = await route({ pickups: [], plannedVehicleId: fleet.vehicles.wh25.id })
      const adding = await olivia(`/routes/${to.id}/pickups`, { method: "POST", body: { containerId: ex.containers.bin1.id } })
      assert.equal((await refused(adding, 409)).detail, "WH-25 has no compartment for Residual waste, which the stop collects")
      const read = await ok(await olivia(`/routes/${to.id}`))
      assert.equal(read.pickups.length, 0, "the stop refused is not kept")
    })
  })
})
