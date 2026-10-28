// Balancing a day across vehicles (O15 of #290) through the API: the preview
// proposes moving a stop off a route over its vehicle's payload onto a route
// of the day that can take it, weighing each route as the route read does;
// the apply moves the accepted stops through O23's move and asks each route it
// touched a new Plan; a day that changed since the preview, a move it did not
// propose and a project the caller does not work in are refused.
import assert from "node:assert/strict"
import { randomInt } from "node:crypto"
import { after, before, describe, test } from "node:test"

import { RouteBalancePreview, RouteBalanceResult, RouteDetail } from "@waste/contracts/routes"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { ROUTING_MEASURE_QUEUE, ROUTING_OPTIMISE_QUEUE } from "@waste/db/commands/plans"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { product, wasteFraction } from "@waste/db/schema/catalogue"
import { containerServicePlacement } from "@waste/db/schema/containers"
import { customer } from "@waste/db/schema/customers"
import { vehicle } from "@waste/db/schema/fleet"
import { PGBOSS_SCHEMA } from "@waste/db/sql/pgboss"
import { withCompany } from "@waste/db/tenant"
import { eq, sql } from "drizzle-orm"
import { PgBoss } from "pg-boss"

import { createApp } from "../app"
import { DAY_CHANGED, NOT_PROPOSED } from "../routes/route-balance"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution, seedRoute, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the routing jobs and the ledgers this suite writes, which `wms_api` may not delete. */
const owner = ownerUnderTest()

/** A day of the suite's own, after the fixtures' Monday, so no fixture route is weighed beside its routes. */
const DAY = "2026-10-12"
const NOW = new Date("2026-10-09T09:00:00Z")

describe("balancing a day across vehicles", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  let other: Call
  let capacityBefore: number | null = null

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    // The apply asks each touched route a Plan: the worker's queues, which this suite stands in for.
    const boss = new PgBoss({ connectionString: owner.url, schema: PGBOSS_SCHEMA, migrate: false, supervise: false, schedule: false })
    boss.on("error", () => undefined)
    await boss.start()
    await boss.createQueue(ROUTING_MEASURE_QUEUE, { policy: "exclusive" })
    await boss.createQueue(ROUTING_OPTIMISE_QUEUE, { policy: "exclusive" })
    await boss.stop({ graceful: false, close: true })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    // The three bins placed since January, as a moved stop is judged on its new route's service date; residual at 100 kg a cubic metre, each 240 L bin 24 kg, on a WH-24 that carries 50.
    const scoped = { companyId: a.companyId, projectId: a.projects.copenhagen.id }
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      const customerId = testId()
      const productId = testId()
      const agreementId = testId()
      await tx.insert(customer).values({ id: customerId, companyId: a.companyId, kind: "organisation", name: "Københavns Boliger", registrationNumber: String(randomInt(10_000_000, 100_000_000)), status: "active" })
      await tx.insert(product).values({ id: productId, ...scoped, name: "Residual 240 L", kind: "container-collection", status: "active", unit: "pickup", containerTypeId: ex.containerTypes.bin.id, wasteFractionId: ex.fractions.residual.id })
      await tx.insert(agreement).values({ id: agreementId, ...scoped, validFrom: "2026-01-01", number: "AGR-O15", customerId, payerCustomerId: customerId, status: "active", billingCadence: "monthly", currency: "DKK" })
      for (const [bin, place] of [
        [ex.containers.bin1, ex.properties.parkvej],
        [ex.containers.bin2, ex.properties.havnegade],
        [ex.containers.bin3, ex.properties.norrebrogade],
      ] as const) {
        const subscriptionId = testId()
        await tx.insert(subscription).values({ id: subscriptionId, ...scoped, validFrom: "2026-01-01", agreementId, productId, propertyId: place.id })
        await tx.insert(containerServicePlacement).values({ id: testId(), ...scoped, validFrom: "2026-01-01", containerId: bin.id, subscriptionId, wasteFractionId: ex.fractions.residual.id })
      }
      await tx.update(wasteFraction).set({ densityKgPerCubicMetre: 100 }).where(eq(wasteFraction.id, ex.fractions.residual.id))
      const [wh24] = await tx.select({ capacityKg: vehicle.capacityKg }).from(vehicle).where(eq(vehicle.id, fleet.vehicles.wh24.id))
      capacityBefore = wh24.capacityKg
      await tx.update(vehicle).set({ capacityKg: 50 }).where(eq(vehicle.id, fleet.vehicles.wh24.id))
    })
    app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOW })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
  })
  after(async () => {
    for (const companyId of [a?.companyId, b?.companyId]) {
      if (companyId === undefined || !ownerPool) continue
      await ownerPool.db.execute(sql`delete from ${sql.raw(PGBOSS_SCHEMA)}.job where name in (${ROUTING_MEASURE_QUEUE}, ${ROUTING_OPTIMISE_QUEUE}) and data ->> 'companyId' = ${companyId}`)
    }
    if (a) await withCompany(pool.db, a.companyId, (tx: Tx) => tx.update(vehicle).set({ capacityKg: capacityBefore }).where(eq(vehicle.id, fleet.vehicles.wh24.id)))
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const read = async (id: string): Promise<RouteDetail> => {
    const response = await olivia(`/routes/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return RouteDetail.parse(await response.json())
  }
  const preview = async (day: string, call = olivia): Promise<RouteBalancePreview> => {
    const response = await call("/routes/balance-preview", { method: "POST", body: { projectId: a.projects.copenhagen.id, operatingDate: day } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return RouteBalancePreview.parse(await response.json())
  }
  const apply = (day: string, token: string, moves: { pickupId: string; toRouteId: string }[], call = olivia) =>
    call("/routes/balance", { method: "POST", body: { projectId: a.projects.copenhagen.id, operatingDate: day, token, moves } })

  /** WH-24's route of the day, over its payload with the three bins, and a route beside it with no vehicle that empties Nørrebrogade's bin already. */
  async function overloadedDay(day: string) {
    const over = await seedRoute(pool, a, fleet, ex, { operatingDate: day, plannedVehicleId: fleet.vehicles.wh24.id })
    const beside = await seedRoute(pool, a, fleet, ex, { operatingDate: day, pickups: [{ containerId: ex.containers.bin3.id, propertyId: ex.properties.norrebrogade.id }] })
    return { over, beside }
  }

  test("the preview moves one bin off the route over its payload onto the route beside it — never the bin that route empties already — and weighs both before and after as the route read does", async () => {
    const { over, beside } = await overloadedDay(DAY)
    const proposal = await preview(DAY)
    assert.equal(proposal.moves.length, 1)
    const [move] = proposal.moves
    assert.deepEqual([move.fromRouteId, move.toRouteId], [over.id, beside.id])
    assert.ok([over.pickupIds[0], over.pickupIds[1]].includes(move.pickupId), "a bin the route beside does not empty already")
    const weighed = new Map(proposal.routes.map((day) => [day.routeId, day] as const))
    assert.deepEqual([weighed.get(over.id)?.before.kg, weighed.get(over.id)?.before.overCapacityKg, weighed.get(over.id)?.after.overCapacityKg], [72, 22, 0])
    assert.deepEqual([weighed.get(beside.id)?.before.kg, weighed.get(beside.id)?.after.kg, weighed.get(beside.id)?.after.overCapacityKg], [24, 48, null])
    // The route read says the same of the route over: its load against its payload.
    assert.deepEqual([(await read(over.id)).workload.expectedKg, (await read(over.id)).workload.overCapacityKg], [72, 22])
  })

  test("the apply moves the accepted stop as O23 moves one, asks each route it touched a new Plan, and a second apply of the same preview finds the day changed", async () => {
    const day = "2026-10-19"
    const { over, beside } = await overloadedDay(day)
    const proposal = await preview(day)
    const [move] = proposal.moves
    const response = await apply(day, proposal.token, [{ pickupId: move.pickupId, toRouteId: move.toRouteId }])
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const result = RouteBalanceResult.parse(await response.json())
    assert.equal(result.moved, 1)
    assert.deepEqual(
      result.routes.map((touched) => touched.routeId),
      [over.id, beside.id].sort(),
    )
    for (const touched of result.routes) {
      assert.ok(touched.planId !== null, "each touched route is asked a Plan")
      assert.equal((await read(touched.routeId)).activePlan?.id ?? touched.planId, touched.planId)
    }
    const left = (await read(over.id)).pickups.find((stop) => stop.id === move.pickupId)
    assert.deepEqual([left?.status, left?.reason], ["skipped", "removed-by-dispatcher"])
    const added = (await read(beside.id)).pickups.find((stop) => stop.movedFromPickupId === move.pickupId)
    assert.deepEqual([added?.status, added?.origin], ["planned", "office"])
    assert.equal((await read(over.id)).workload.overCapacityKg, 0)
    const again = await refused(await apply(day, proposal.token, [{ pickupId: move.pickupId, toRouteId: move.toRouteId }]), 409)
    assert.equal(again.detail, DAY_CHANGED)
  })

  test("refuses a move the preview did not propose, at the move, and moves nothing", async () => {
    const day = "2026-10-26"
    const { over, beside } = await overloadedDay(day)
    const proposal = await preview(day)
    // Nørrebrogade's bin is the one the route beside empties already: never proposed.
    const problem = await refused(await apply(day, proposal.token, [{ pickupId: over.pickupIds[2], toRouteId: beside.id }]), 400)
    assert.deepEqual(problem.errors, [{ path: "moves.0", message: NOT_PROPOSED }])
    assert.ok((await read(over.id)).pickups.every((stop) => stop.status === "planned"))
  })

  test("refuses a project the caller does not work in, at the project", async () => {
    const response = await other("/routes/balance-preview", { method: "POST", body: { projectId: a.projects.copenhagen.id, operatingDate: DAY } })
    const problem = await refused(response, 400)
    assert.deepEqual(problem.errors?.map((error) => error.path), ["projectId"])
  })

  test("a day with no route over proposes nothing", async () => {
    const day = "2026-11-02"
    await seedRoute(pool, a, fleet, ex, { operatingDate: day, pickups: [{ containerId: ex.containers.bin1.id, propertyId: ex.properties.parkvej.id }] })
    const proposal = await preview(day)
    assert.deepEqual(proposal.moves, [])
    for (const route of proposal.routes) assert.deepEqual(route.before, route.after)
  })
})
