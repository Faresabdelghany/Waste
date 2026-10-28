// The ledger's work orders on a stop (O3b of #290): the office books a
// delivery of a container from stock under a subscription, a removal of one
// in service to a warehouse, and a swap of one for a replacement from stock;
// a planned delivery or swap holds its container back from another booking,
// the index deciding, and a planned removal or swap the container it takes
// away; the driver's completion moves the containers through the ledger, a
// refusal on the way leaving the completion standing, the ledger untouched,
// and the office an internal task with its sentence; the office's correction
// to completed moves them too, and one away from completed says they moved;
// and a termination lists the deliveries booked under what it ends.
import assert from "node:assert/strict"
import { randomInt } from "node:crypto"
import { after, before, describe, test } from "node:test"

import { AgreementTerminated } from "@waste/contracts/agreements"
import { DriverCommandBatchOutcome, type CommandOutcomeRow } from "@waste/contracts/driver-commands"
import { PickupDetail } from "@waste/contracts/pickups"
import { RouteDetail } from "@waste/contracts/routes"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { product } from "@waste/db/schema/catalogue"
import { containerServicePlacement } from "@waste/db/schema/containers"
import { customer } from "@waste/db/schema/customers"
import { ticket } from "@waste/db/schema/resolution"
import { stockMovement } from "@waste/db/schema/stock"
import { withCompany } from "@waste/db/tenant"
import { and, asc, eq } from "drizzle-orm"

import { createApp } from "../app"
import { OUTSIDE_SUBSCRIPTION } from "../routes/lifecycle"
import { bookedAlready, heldBy } from "../routes/pickups"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { stocked, warehouseIn } from "./stock-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the ledgers this suite appends to, which `wms_api` may not delete. */
const owner = ownerUnderTest()

const DAY = "2026-10-05"
const NOON = new Date(`${DAY}T12:00:00Z`)
const at = (time: string) => `${DAY}T${time}:00.000+02:00`

describe("the ledger's work orders", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let olivia: Call
  let mads: Call
  let warehouseId: string
  let closedWarehouseId: string
  /** Parkvej's subscription, under which BIN-20 serves and a delivery is booked. */
  let subscriptionId: string
  /** A second subscription at Havnegade, for a replacement issued elsewhere meanwhile. */
  let elsewhereId: string
  let customerId: string
  let productId: string
  let bin = 30

  const scoped = () => ({ companyId: a.companyId, projectId: a.projects.copenhagen.id })
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  /** A container from stock, in the warehouse: one the ledger would issue. */
  const inStock = async () => stocked(olivia, { projectId: a.projects.copenhagen.id, label: `BIN-${bin++}`, containerTypeId: ex.containerTypes.bin.id }, warehouseId)
  /** A container in service at Parkvej under the subscription, issued through the ledger. */
  const inService = async (under = subscriptionId) => {
    const into = await inStock()
    const response = await olivia(`/containers/${into.id}/placements`, { method: "POST", body: { subscriptionId: under, wasteFractionId: ex.fractions.residual.id, validFrom: "2026-01-01", occurredAt: "2026-01-01T08:00:00.000Z" } })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return into
  }
  /** A ready route for Mads on WH-24 on the day, Mads's session open on it. */
  const running = async (): Promise<RouteDetail> => {
    const route = await created(olivia, "/routes", await olivia("/routes", { method: "POST", body: { projectId: a.projects.copenhagen.id, operatingDate: DAY, driverId: fleet.drivers.mads.id, vehicleId: fleet.vehicles.wh24.id, acceptSameDay: true } }), RouteDetail)
    return route
  }
  const add = (routeId: string, values: Record<string, unknown>) => olivia(`/routes/${routeId}/pickups`, { method: "POST", body: values })
  const added = async (routeId: string, values: Record<string, unknown>): Promise<PickupDetail> => await created(olivia, `/routes/${routeId}/pickups`, await add(routeId, values), PickupDetail, "/pickups")
  const commands = async (routeId: string, list: { kind: string; body: unknown; time: string }[]): Promise<CommandOutcomeRow[]> => {
    const response = await mads("/driver/commands", {
      method: "POST",
      body: { commands: list.map((command) => ({ id: testId(), kind: command.kind, routeId, occurredAt: at(command.time), deviceId: "device-mads-01", body: command.body })) },
    })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return DriverCommandBatchOutcome.parse(await response.json()).outcomes
  }
  /** Dispatches the route and starts it on Mads's phone: what a completion needs. */
  const startRoute = async (routeId: string) => {
    assert.equal((await olivia(`/routes/${routeId}/dispatch`, { method: "POST" })).status, 200)
    const [outcome] = await commands(routeId, [{ kind: "start-route", body: { vehicleId: fleet.vehicles.wh24.id }, time: "07:00" }])
    assert.equal(outcome.outcome, "applied", JSON.stringify(outcome))
  }
  /** Completes the stop and ends the day, so the next test's route may start: a driver is on one route at a time. */
  const complete = async (routeId: string, pickupId: string) => {
    const [completed, ended] = await commands(routeId, [
      { kind: "complete-pickup", body: { pickupId }, time: "10:12" },
      { kind: "end-route", body: {}, time: "10:30" },
    ])
    assert.equal(completed.outcome, "applied", JSON.stringify(completed))
    assert.equal(ended.outcome, "applied", JSON.stringify(ended))
  }
  const movementsOf = (containerId: string) =>
    withCompany(pool.db, a.companyId, (tx: Tx) => tx.select({ kind: stockMovement.kind, toKind: stockMovement.toKind, warehouseId: stockMovement.toWarehouseId }).from(stockMovement).where(and(eq(stockMovement.companyId, a.companyId), eq(stockMovement.containerId, containerId))).orderBy(asc(stockMovement.id)))
  const ticketsOf = (pickupId: string) => withCompany(pool.db, a.companyId, (tx: Tx) => tx.select().from(ticket).where(and(eq(ticket.companyId, a.companyId), eq(ticket.pickupId, pickupId))))
  /** A subscription at Parkvej under an agreement of its own, for a test that ends one. */
  const ownAgreement = async (): Promise<{ agreementId: string; subscriptionId: string }> => {
    const ids = { agreementId: testId(), subscriptionId: testId() }
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.insert(agreement).values({ id: ids.agreementId, ...scoped(), validFrom: "2026-01-01", number: `AGR-${bin++}`, customerId, payerCustomerId: customerId, status: "active", billingCadence: "monthly", currency: "DKK" })
      await tx.insert(subscription).values({ id: ids.subscriptionId, ...scoped(), validFrom: "2026-01-01", agreementId: ids.agreementId, productId, propertyId: ex.properties.parkvej.id })
    })
    return ids
  }
  const placementsOf = (containerId: string) =>
    withCompany(pool.db, a.companyId, (tx: Tx) =>
      tx
        .select({ subscriptionId: containerServicePlacement.subscriptionId, validFrom: containerServicePlacement.validFrom, validTo: containerServicePlacement.validTo })
        .from(containerServicePlacement)
        .where(and(eq(containerServicePlacement.companyId, a.companyId), eq(containerServicePlacement.containerId, containerId)))
        .orderBy(asc(containerServicePlacement.validFrom)),
    )

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    // Mads's login is on the viewer's role: the driver door is granted there.
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: "operate.driver-app", actions: ["view", "edit"] }])
    warehouseId = await warehouseIn(pool, a.companyId, a.projects.copenhagen.id, "WO-1")
    closedWarehouseId = await warehouseIn(pool, a.companyId, a.projects.copenhagen.id, "WO-9", "closed")
    subscriptionId = testId()
    elsewhereId = testId()
    customerId = testId()
    productId = testId()
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      const agreementId = testId()
      await tx.insert(customer).values({ id: customerId, companyId: a.companyId, kind: "organisation", name: "Parkvej Boligforening", registrationNumber: String(randomInt(10_000_000, 100_000_000)), status: "active" })
      await tx.insert(product).values({ id: productId, ...scoped(), name: "Residual 240 L", kind: "container-collection", status: "active", unit: "pickup", containerTypeId: ex.containerTypes.bin.id, wasteFractionId: ex.fractions.residual.id })
      await tx.insert(agreement).values({ id: agreementId, ...scoped(), validFrom: "2026-01-01", number: "AGR-301", customerId, payerCustomerId: customerId, status: "active", billingCadence: "monthly", currency: "DKK" })
      await tx.insert(subscription).values([
        { id: subscriptionId, ...scoped(), validFrom: "2026-01-01", agreementId, productId, propertyId: ex.properties.parkvej.id },
        { id: elsewhereId, ...scoped(), validFrom: "2026-01-01", agreementId, productId, propertyId: ex.properties.havnegade.id },
      ])
    })
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    mads = callingAs(app, keys, ex.logins.mads, a.companyId)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  describe("booking", () => {
    test("a delivery of a container from stock goes where its subscription serves, with the product's fraction, and books the subscription", async () => {
      const route = await running()
      const bin = await inStock()
      const stop = await added(route.id, { service: "deliver", containerId: bin.id, subscriptionId })
      assert.deepEqual([stop.service, stop.containerId, stop.subscriptionId, stop.propertyId, stop.wasteFractionId, stop.warehouseId], ["deliver", bin.id, subscriptionId, ex.properties.parkvej.id, ex.fractions.residual.id, null])
    })

    test("a planned delivery holds its container back: a second booking is refused naming the stop that holds it, until that stop is taken off", async () => {
      const first = await running()
      const second = await running()
      const bin = await inStock()
      const holding = await added(first.id, { service: "deliver", containerId: bin.id, subscriptionId })
      const problem = await refused(await add(second.id, { service: "deliver", containerId: bin.id, subscriptionId }), 409)
      assert.equal(problem.detail, heldBy(bin.label, { service: "deliver", route: first.label, position: holding.position }))
      assert.equal((await olivia(`/pickups/${holding.id}/remove`, { method: "POST", body: { reason: "Booked on the wrong route" } })).status, 200)
      await added(second.id, { service: "deliver", containerId: bin.id, subscriptionId })
    })

    test("the ledger's state is the booking's: a container in service is not delivered, one in stock is not removed, a closed warehouse takes nothing back", async () => {
      const route = await running()
      const placed = await inService()
      const stock = await inStock()
      assert.match((await refused(await add(route.id, { service: "deliver", containerId: placed.id, subscriptionId }), 409)).detail ?? "", /is in service at another placement; return it first/)
      assert.match((await refused(await add(route.id, { service: "remove", containerId: stock.id, warehouseId }), 409)).detail ?? "", /has no placement in force on the route's service date/)
      assert.match((await refused(await add(route.id, { service: "remove", containerId: placed.id, warehouseId: closedWarehouseId }), 409)).detail ?? "", /is closed; a movement arrives only at an active or restricted warehouse/)
    })

    test("a swap books the container taken, a replacement from stock, held back like a delivery's, and the warehouse", async () => {
      const route = await running()
      const placed = await inService()
      const replacement = await inStock()
      const stop = await added(route.id, { service: "swap", containerId: placed.id, replacementContainerId: replacement.id, warehouseId })
      assert.deepEqual([stop.service, stop.replacementContainerId, stop.warehouseId, stop.propertyId], ["swap", replacement.id, warehouseId, ex.properties.parkvej.id])
      const other = await running()
      const otherPlaced = await inService()
      assert.match((await refused(await add(other.id, { service: "swap", containerId: otherPlaced.id, replacementContainerId: replacement.id, warehouseId }), 409)).detail ?? "", /is held for a swap on route/)
    })

    test("a planned removal or swap holds the container it takes away: another route's is refused naming the stop, and the same work twice on one route says what it is", async () => {
      const first = await running()
      const second = await running()
      const placed = await inService()
      const holding = await added(first.id, { service: "remove", containerId: placed.id, warehouseId })
      const problem = await refused(await add(second.id, { service: "swap", containerId: placed.id, replacementContainerId: (await inStock()).id, warehouseId }), 409)
      assert.equal(problem.detail, heldBy(placed.label, { service: "remove", route: first.label, position: holding.position }))
      assert.match(problem.detail ?? "", /is held for a removal on route/)
      const twice = await refused(await add(first.id, { service: "remove", containerId: placed.id, warehouseId }), 409)
      assert.equal(twice.detail, bookedAlready(placed.label, "remove", first.label))
      assert.match(twice.detail ?? "", /has a planned removal the office added/)
    })

    test("a removal of a container whose agreement has ended is booked where it stands, since the ledger has it in service until it is taken away", async () => {
      const ended = await ownAgreement()
      const placed = await inService(ended.subscriptionId)
      const terminated = await olivia(`/agreements/${ended.agreementId}/terminate`, { method: "POST", body: { on: "2026-10-01" } })
      assert.equal(terminated.status, 200, JSON.stringify(await terminated.clone().json()))
      const route = await running()
      const stop = await added(route.id, { service: "remove", containerId: placed.id, warehouseId })
      assert.deepEqual([stop.propertyId, stop.wasteFractionId], [ex.properties.parkvej.id, ex.fractions.residual.id])
      await startRoute(route.id)
      await complete(route.id, stop.id)
      assert.deepEqual((await movementsOf(placed.id)).map((movement) => movement.kind), ["receipt", "issue", "return"])
      assert.deepEqual((await placementsOf(placed.id)).map((placement) => placement.validTo), ["2026-10-01"], "the placement keeps the end the termination gave it")
    })

    test("a termination lists a planned delivery booked under a subscription it ends among the stops to take off", async () => {
      const own = await ownAgreement()
      const route = await running()
      const stock = await inStock()
      const stop = await added(route.id, { service: "deliver", containerId: stock.id, subscriptionId: own.subscriptionId })
      const response = await olivia(`/agreements/${own.agreementId}/terminate`, { method: "POST", body: { on: "2026-10-03" } })
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
      const { stopsToRemove } = AgreementTerminated.parse(await response.json())
      assert.deepEqual(
        stopsToRemove.map((toRemove) => [toRemove.pickupId, toRemove.containerId]),
        [[stop.id, stock.id]],
      )
    })
  })

  describe("completion", () => {
    test("a delivery completed issues its container under the subscription from the completion's day", async () => {
      const route = await running()
      const bin = await inStock()
      const stop = await added(route.id, { service: "deliver", containerId: bin.id, subscriptionId })
      await startRoute(route.id)
      await complete(route.id, stop.id)
      assert.deepEqual((await movementsOf(bin.id)).map((movement) => movement.kind), ["receipt", "issue"])
      assert.deepEqual(await placementsOf(bin.id), [{ subscriptionId, validFrom: DAY, validTo: null }])
    })

    test("a removal completed returns its container to the booked warehouse, ending its placement on the day", async () => {
      const route = await running()
      const placed = await inService()
      const stop = await added(route.id, { service: "remove", containerId: placed.id, warehouseId })
      await startRoute(route.id)
      await complete(route.id, stop.id)
      const movements = await movementsOf(placed.id)
      assert.deepEqual(movements.map((movement) => [movement.kind, movement.warehouseId]).at(-1), ["return", warehouseId])
      assert.deepEqual((await placementsOf(placed.id)).map((placement) => placement.validTo), [DAY])
    })

    test("a swap completed returns the container taken and issues its replacement under the same subscription, from the same day", async () => {
      const route = await running()
      const placed = await inService()
      const replacement = await inStock()
      const stop = await added(route.id, { service: "swap", containerId: placed.id, replacementContainerId: replacement.id, warehouseId })
      await startRoute(route.id)
      await complete(route.id, stop.id)
      assert.deepEqual((await placementsOf(placed.id)).map((placement) => placement.validTo), [DAY])
      assert.deepEqual(await placementsOf(replacement.id), [{ subscriptionId, validFrom: DAY, validTo: null }])
    })

    test("a swap whose replacement was issued elsewhere meanwhile: the stop completes, nothing of the ledger moves, and the office gets a task with the ledger's sentence", async () => {
      const route = await running()
      const placed = await inService()
      const replacement = await inStock()
      const stop = await added(route.id, { service: "swap", containerId: placed.id, replacementContainerId: replacement.id, warehouseId })
      // The office issues the replacement at Havnegade by hand after the booking.
      const issued = await olivia(`/containers/${replacement.id}/placements`, { method: "POST", body: { subscriptionId: elsewhereId, wasteFractionId: ex.fractions.residual.id, validFrom: "2026-10-01" } })
      assert.equal(issued.status, 201, JSON.stringify(await issued.clone().json()))
      await startRoute(route.id)
      await complete(route.id, stop.id)
      const done = PickupDetail.parse(await (await olivia(`/pickups/${stop.id}`)).json())
      assert.equal(done.status, "completed", "the driver's completion stands")
      assert.deepEqual((await placementsOf(placed.id)).map((placement) => placement.validTo), [null], "no half-swap: the container taken is still in service")
      assert.deepEqual((await movementsOf(placed.id)).map((movement) => movement.kind), ["receipt", "issue"])
      assert.deepEqual((await placementsOf(replacement.id)).map((placement) => placement.subscriptionId), [elsewhereId])
      const [task] = await ticketsOf(stop.id)
      assert.deepEqual([task.kind, task.priority, task.source, task.createdBy], ["internal-task", "high", "driver-app", ex.logins.mads.id])
      assert.equal(task.subject, `Swap of ${placed.label} for ${replacement.label} at Parkvej 18, 2100 København Ø not recorded`)
      assert.match(task.description, new RegExp(`The driver completed the stop at 10:12, but the ledger refused the swap: Container ${replacement.label} is in service at another placement; return it first\\. Record it through the container's commands\\.`))
    })

    test("a refusal the ledger gives at a field is told in the field's own sentence", async () => {
      const own = await ownAgreement()
      const route = await running()
      const stock = await inStock()
      const stop = await added(route.id, { service: "deliver", containerId: stock.id, subscriptionId: own.subscriptionId })
      // The subscription ends on the day after the booking: the delivery would begin outside it.
      const patched = await olivia(`/subscriptions/${own.subscriptionId}`, { method: "PATCH", body: { validTo: DAY } })
      assert.equal(patched.status, 200, JSON.stringify(await patched.clone().json()))
      await startRoute(route.id)
      await complete(route.id, stop.id)
      const [task] = await ticketsOf(stop.id)
      assert.match(task.description, new RegExp(`refused the delivery: ${OUTSIDE_SUBSCRIPTION}\\. Record it`))
      assert.deepEqual((await movementsOf(stock.id)).map((movement) => movement.kind), ["receipt"])
    })
  })

  describe("the office's correction", () => {
    test("a delivery the driver failed and the office corrects to completed is issued then, from the correction's day", async () => {
      const route = await running()
      const stock = await inStock()
      const stop = await added(route.id, { service: "deliver", containerId: stock.id, subscriptionId })
      await startRoute(route.id)
      const [failed, ended] = await commands(route.id, [
        { kind: "fail-pickup", body: { pickupId: stop.id, reason: "inaccessible" }, time: "10:12" },
        { kind: "end-route", body: {}, time: "10:30" },
      ])
      assert.deepEqual([failed.outcome, ended.outcome], ["applied", "applied"])
      assert.deepEqual((await movementsOf(stock.id)).map((movement) => movement.kind), ["receipt"])
      const corrected = await olivia(`/pickups/${stop.id}/correct-outcome`, { method: "POST", body: { outcome: "completed", note: "Delivered; the wrong button was tapped" } })
      assert.equal(corrected.status, 200, JSON.stringify(await corrected.clone().json()))
      assert.deepEqual((await movementsOf(stock.id)).map((movement) => movement.kind), ["receipt", "issue"])
      assert.deepEqual(await placementsOf(stock.id), [{ subscriptionId, validFrom: DAY, validTo: null }])
    })

    test("a completed swap the office corrects to failed leaves the ledger as it moved, and tells the office so", async () => {
      const route = await running()
      const placed = await inService()
      const replacement = await inStock()
      const stop = await added(route.id, { service: "swap", containerId: placed.id, replacementContainerId: replacement.id, warehouseId })
      await startRoute(route.id)
      await complete(route.id, stop.id)
      const corrected = await olivia(`/pickups/${stop.id}/correct-outcome`, { method: "POST", body: { outcome: "failed", reason: "inaccessible", note: "The gate was locked; nothing was swapped" } })
      assert.equal(corrected.status, 200, JSON.stringify(await corrected.clone().json()))
      assert.deepEqual((await placementsOf(replacement.id)).map((placement) => placement.subscriptionId), [subscriptionId], "the ledger stands as it moved")
      const [task] = await ticketsOf(stop.id)
      assert.deepEqual([task.kind, task.priority, task.source, task.createdBy], ["internal-task", "high", "dispatch", a.users.olivia.id])
      assert.equal(task.subject, `Swap of ${placed.label} for ${replacement.label} at Parkvej 18, 2100 København Ø recorded, stop now failed`)
      assert.match(task.description, /the office corrected the stop to failed at 14:00\. If the swap did not happen, put the containers back/)
    })
  })
})
