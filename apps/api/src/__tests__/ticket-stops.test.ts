// A stop booked to answer a ticket (O3c of #290): the office's Add stop
// names an open container request, overflow or defect of the route's project,
// held to the stop's service, container and place; the ticket then names the
// stop, with a comment, and refuses a second booking while that one is
// planned. The driver's completion of the stop services the ticket in the same
// request, with `ticket-completed` emitted once; the office's correction to
// completed does too, and one away from completed only tells the ticket.
// Every booking is kept in the ledger (#422), so a stop the office booked the
// ticket away from still services it when it is corrected to completed.
import assert from "node:assert/strict"
import { randomInt } from "node:crypto"
import { after, before, describe, test } from "node:test"

import { DriverCommandBatchOutcome, type CommandOutcomeRow } from "@waste/contracts/driver-commands"
import { PickupDetail } from "@waste/contracts/pickups"
import { RouteDetail } from "@waste/contracts/routes"
import { Ticket } from "@waste/contracts/tickets"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { product } from "@waste/db/schema/catalogue"
import { customer } from "@waste/db/schema/customers"
import { outboxEvent } from "@waste/db/schema/execution"
import { ticketBooking, ticketEvent } from "@waste/db/schema/resolution"
import { withCompany } from "@waste/db/tenant"
import { answeredAlready, bookedFor, correctedAway, notAnsweredBy, onlyAnOpenTicket, servedAfterClose, servicedBy, stopCorrected } from "@waste/domain/execution/ticket-stops"
import { and, asc, eq } from "drizzle-orm"

import { createApp } from "../app"
import { NOT_A_TICKET } from "../routes/ticket-stops"
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
const owner = ownerUnderTest()

const DAY = "2026-10-05"
const NOON = new Date(`${DAY}T12:00:00Z`)
const at = (time: string) => `${DAY}T${time}:00.000+02:00`

describe("a stop booked to answer a ticket", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let olivia: Call
  let mads: Call
  let warehouseId: string
  let subscriptionId: string
  let bin = 40

  const scoped = () => ({ companyId: a.companyId, projectId: a.projects.copenhagen.id })
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const inStock = async () => stocked(olivia, { projectId: a.projects.copenhagen.id, label: `BIN-${bin++}`, containerTypeId: ex.containerTypes.bin.id }, warehouseId)
  const inService = async () => {
    const into = await inStock()
    const response = await olivia(`/containers/${into.id}/placements`, { method: "POST", body: { subscriptionId, wasteFractionId: ex.fractions.residual.id, validFrom: "2026-01-01", occurredAt: "2026-01-01T08:00:00.000Z" } })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return into
  }
  const running = async (): Promise<RouteDetail> =>
    await created(olivia, "/routes", await olivia("/routes", { method: "POST", body: { projectId: a.projects.copenhagen.id, operatingDate: DAY, driverId: fleet.drivers.mads.id, vehicleId: fleet.vehicles.wh24.id } }), RouteDetail)
  const add = (routeId: string, values: Record<string, unknown>) => olivia(`/routes/${routeId}/pickups`, { method: "POST", body: values })
  const added = async (routeId: string, values: Record<string, unknown>): Promise<PickupDetail> => await created(olivia, `/routes/${routeId}/pickups`, await add(routeId, values), PickupDetail, "/pickups")
  /** A ticket the office opens at Parkvej, of the kind, about the container where one is named. */
  const opened = async (kind: string, containerId?: string): Promise<Ticket> =>
    await created(
      olivia,
      "/tickets",
      await olivia("/tickets", { method: "POST", body: { projectId: a.projects.copenhagen.id, kind, subject: `${kind} at Parkvej 18`, description: "Phoned in", links: { propertyId: ex.properties.parkvej.id, ...(containerId === undefined ? {} : { containerId }) } } }),
      Ticket,
    )
  const ticketOf = async (id: string) => Ticket.parse(await (await olivia(`/tickets/${id}`)).json())
  const historyOf = (ticketId: string) =>
    withCompany(pool.db, a.companyId, (tx: Tx) => tx.select().from(ticketEvent).where(and(eq(ticketEvent.companyId, a.companyId), eq(ticketEvent.ticketId, ticketId))).orderBy(asc(ticketEvent.id)))
  /** The stops the ledger says the ticket booked, in the order it booked them. */
  const bookingsOf = async (ticketId: string) =>
    (
      await withCompany(pool.db, a.companyId, (tx: Tx) =>
        tx.select({ pickupId: ticketBooking.pickupId }).from(ticketBooking).where(and(eq(ticketBooking.companyId, a.companyId), eq(ticketBooking.ticketId, ticketId))).orderBy(asc(ticketBooking.id)),
      )
    ).map((row) => row.pickupId)
  const completedEvents = (ticketId: string) =>
    withCompany(pool.db, a.companyId, (tx: Tx) => tx.select().from(outboxEvent).where(and(eq(outboxEvent.companyId, a.companyId), eq(outboxEvent.aggregateId, ticketId), eq(outboxEvent.kind, "ticket-completed"))))
  const commands = async (routeId: string, list: { kind: string; body: unknown; time: string }[]): Promise<CommandOutcomeRow[]> => {
    const response = await mads("/driver/commands", {
      method: "POST",
      body: { commands: list.map((command) => ({ id: testId(), kind: command.kind, routeId, occurredAt: at(command.time), deviceId: "device-mads-01", body: command.body })) },
    })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return DriverCommandBatchOutcome.parse(await response.json()).outcomes
  }
  /** Dispatches the route, starts it on Mads's phone, decides the stop and ends the day: a driver is on one route at a time. */
  const driven = async (routeId: string, pickupId: string, decision: "complete-pickup" | "fail-pickup") => {
    assert.equal((await olivia(`/routes/${routeId}/dispatch`, { method: "POST" })).status, 200)
    const outcomes = await commands(routeId, [
      { kind: "start-route", body: { vehicleId: fleet.vehicles.wh24.id }, time: "07:00" },
      { kind: decision, body: decision === "fail-pickup" ? { pickupId, reason: "inaccessible" } : { pickupId }, time: "10:12" },
      { kind: "end-route", body: {}, time: "10:30" },
    ])
    for (const outcome of outcomes) assert.equal(outcome.outcome, "applied", JSON.stringify(outcome))
  }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: "operate.driver-app", actions: ["view", "edit"] }])
    warehouseId = await warehouseIn(pool, a.companyId, a.projects.copenhagen.id, "TS-1")
    subscriptionId = testId()
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      const customerId = testId()
      const productId = testId()
      const agreementId = testId()
      await tx.insert(customer).values({ id: customerId, companyId: a.companyId, kind: "organisation", name: "Parkvej Boligforening", registrationNumber: String(randomInt(10_000_000, 100_000_000)), status: "active" })
      await tx.insert(product).values({ id: productId, ...scoped(), name: "Residual 240 L", kind: "container-collection", status: "active", unit: "pickup", containerTypeId: ex.containerTypes.bin.id, wasteFractionId: ex.fractions.residual.id })
      await tx.insert(agreement).values({ id: agreementId, ...scoped(), validFrom: "2026-01-01", number: "AGR-401", customerId, payerCustomerId: customerId, status: "active", billingCadence: "monthly", currency: "DKK" })
      await tx.insert(subscription).values({ id: subscriptionId, ...scoped(), validFrom: "2026-01-01", agreementId, productId, propertyId: ex.properties.parkvej.id })
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
    test("a container request booked as a delivery: the ticket names the stop, and its history says which", async () => {
      const request = await opened("container-request")
      const route = await running()
      const stop = await added(route.id, { service: "deliver", containerId: (await inStock()).id, subscriptionId, ticketId: request.id })
      const booked = await ticketOf(request.id)
      assert.deepEqual([booked.bookedRouteId, booked.bookedPickupId, booked.status], [route.id, stop.id, "open"])
      assert.deepEqual(await bookingsOf(request.id), [stop.id], "the ledger keeps the booking")
      const comment = (await historyOf(request.id)).at(-1)
      assert.deepEqual([comment?.kind, comment?.body, comment?.recordedBy], ["comment", bookedFor({ position: stop.position, route: route.label, service: "deliver" }), a.users.olivia.id])
    })

    test("the ticket is held to the stop: of the route's project, a kind the service answers, its container and place, open", async () => {
      const route = await running()
      const placed = await inService()
      const other = await inService()
      assert.deepEqual((await refused(await add(route.id, { containerId: placed.id, ticketId: testId() }), 400)).errors, [{ path: "ticketId", message: NOT_A_TICKET }])
      // The ticket is the body's own field, judged before the stop's place: a bin with no placement would be the stop's 409.
      assert.deepEqual((await refused(await add(route.id, { containerId: (await inStock()).id, ticketId: testId() }), 400)).errors, [{ path: "ticketId", message: NOT_A_TICKET }])
      const complaint = await opened("complaint")
      assert.deepEqual((await refused(await add(route.id, { containerId: placed.id, ticketId: complaint.id }), 400)).errors, [{ path: "service", message: notAnsweredBy("complaint", "empty") }])
      const defect = await opened("container-defect", placed.id)
      assert.deepEqual((await refused(await add(route.id, { service: "wash", containerId: placed.id, ticketId: defect.id }), 400)).errors, [{ path: "service", message: notAnsweredBy("container-defect", "wash") }])
      assert.deepEqual((await refused(await add(route.id, { service: "repair", containerId: other.id, ticketId: defect.id }), 400)).errors, [{ path: "containerId", message: "Name the container the ticket is about" }])
      assert.equal((await olivia(`/tickets/${defect.id}/reject`, { method: "POST", body: { reason: "Duplicate of a call" } })).status, 200)
      const rejected = await refused(await add(route.id, { service: "repair", containerId: placed.id, ticketId: defect.id }), 409)
      assert.equal(rejected.detail, onlyAnOpenTicket(defect.label, "rejected"))
    })

    test("one planned stop answers a ticket: a second booking is refused naming it, until it is taken off and replaced", async () => {
      const overflow = await opened("overflow")
      const route = await running()
      const placed = await inService()
      const first = await added(route.id, { containerId: placed.id, ticketId: overflow.id })
      // Another of the place's bins: the same work on the same container would meet the route's own refusal first.
      const twice = await refused(await add(route.id, { containerId: (await inService()).id, ticketId: overflow.id }), 409)
      assert.equal(twice.detail, answeredAlready(overflow.label, { position: first.position, route: route.label }))
      assert.equal((await olivia(`/pickups/${first.id}/remove`, { method: "POST", body: { reason: "Booked on the wrong day" } })).status, 200)
      const second = await added(route.id, { containerId: placed.id, ticketId: overflow.id })
      assert.equal((await ticketOf(overflow.id)).bookedPickupId, second.id)
      assert.deepEqual(await bookingsOf(overflow.id), [first.id, second.id], "the ticket names its current stop, the ledger every one")
    })
  })

  describe("the stop decided", () => {
    test("the driver's completion services the ticket, recorded by the driver, naming the stop, ticket-completed emitted once", async () => {
      const request = await opened("container-request")
      const route = await running()
      const stop = await added(route.id, { service: "deliver", containerId: (await inStock()).id, subscriptionId, ticketId: request.id })
      await driven(route.id, stop.id, "complete-pickup")
      const served = await ticketOf(request.id)
      assert.deepEqual([served.status, served.resolution], ["completed", "serviced"])
      const last = (await historyOf(request.id)).at(-1)
      assert.deepEqual([last?.kind, last?.resolution, last?.body, last?.recordedBy], ["status-changed", "serviced", servicedBy({ position: stop.position, route: route.label }), ex.logins.mads.id])
      assert.equal((await completedEvents(request.id)).length, 1)
    })

    test("a stop the driver failed and the office corrects to completed services the ticket then", async () => {
      const defect = await opened("container-defect")
      const route = await running()
      const placed = await inService()
      const stop = await added(route.id, { service: "repair", containerId: placed.id, ticketId: defect.id })
      await driven(route.id, stop.id, "fail-pickup")
      assert.equal((await ticketOf(defect.id)).status, "open", "a miss reaches the ticket through Resolution's consumer, not here")
      assert.equal((await olivia(`/pickups/${stop.id}/correct-outcome`, { method: "POST", body: { outcome: "completed", note: "Repaired after all" } })).status, 200)
      const served = await ticketOf(defect.id)
      assert.deepEqual([served.status, served.resolution], ["completed", "serviced"])
      assert.equal((await historyOf(defect.id)).at(-1)?.recordedBy, a.users.olivia.id)
    })

    test("a stop the ticket was booked away from after it failed, corrected to completed, still services the ticket: it names that stop again, and the stop booked since, still planned, for the office to take off (#422)", async () => {
      const defect = await opened("container-defect")
      const route = await running()
      const placed = await inService()
      const failed = await added(route.id, { service: "repair", containerId: placed.id, ticketId: defect.id })
      await driven(route.id, failed.id, "fail-pickup")
      const later = await running()
      const rebooked = await added(later.id, { service: "repair", containerId: placed.id, ticketId: defect.id })
      assert.equal((await ticketOf(defect.id)).bookedPickupId, rebooked.id)
      assert.equal((await olivia(`/pickups/${failed.id}/correct-outcome`, { method: "POST", body: { outcome: "completed", note: "Repaired after all" } })).status, 200)
      const served = await ticketOf(defect.id)
      assert.deepEqual([served.status, served.resolution, served.bookedPickupId], ["completed", "serviced", failed.id], "the stop that answered it")
      assert.equal((await historyOf(defect.id)).at(-1)?.body, servicedBy({ position: failed.position, route: route.label }, { position: rebooked.position, route: later.label }))
      assert.equal((await completedEvents(defect.id)).length, 1)
    })

    test("a stop the ticket was booked away from, completed and then corrected away after the stop booked since serviced it, is told as the correction alone (#422)", async () => {
      const defect = await opened("container-defect")
      const route = await running()
      const placed = await inService()
      const failed = await added(route.id, { service: "repair", containerId: placed.id, ticketId: defect.id })
      await driven(route.id, failed.id, "fail-pickup")
      const later = await running()
      const rebooked = await added(later.id, { service: "repair", containerId: placed.id, ticketId: defect.id })
      await driven(later.id, rebooked.id, "complete-pickup")
      assert.equal((await historyOf(defect.id)).at(-1)?.body, servicedBy({ position: rebooked.position, route: later.label }), "nothing else booked for it is planned")
      assert.equal((await olivia(`/pickups/${failed.id}/correct-outcome`, { method: "POST", body: { outcome: "completed", note: "Repaired after all" } })).status, 200)
      assert.equal((await historyOf(defect.id)).at(-1)?.body, servedAfterClose({ position: failed.position, route: route.label, service: "repair" }))
      assert.equal((await olivia(`/pickups/${failed.id}/correct-outcome`, { method: "POST", body: { outcome: "failed", reason: "inaccessible", note: "Wrong stop ticked" } })).status, 200)
      assert.equal((await historyOf(defect.id)).at(-1)?.body, stopCorrected({ position: failed.position, route: route.label, outcome: "failed", note: "Wrong stop ticked" }), "it never serviced the ticket")
      assert.deepEqual([(await ticketOf(defect.id)).bookedPickupId, (await completedEvents(defect.id)).length], [rebooked.id, 1])
    })

    test("a serviced ticket whose stop is corrected away from completed stays as it is, told in a comment; reopening is the office's", async () => {
      const overflow = await opened("overflow")
      const route = await running()
      const placed = await inService()
      const stop = await added(route.id, { containerId: placed.id, ticketId: overflow.id })
      await driven(route.id, stop.id, "complete-pickup")
      assert.equal((await olivia(`/pickups/${stop.id}/correct-outcome`, { method: "POST", body: { outcome: "failed", reason: "inaccessible", note: "The gate was locked" } })).status, 200)
      const after = await ticketOf(overflow.id)
      assert.deepEqual([after.status, after.resolution], ["completed", "serviced"])
      const last = (await historyOf(overflow.id)).at(-1)
      assert.deepEqual([last?.kind, last?.body], ["comment", correctedAway({ position: stop.position, route: route.label, service: "empty", outcome: "failed", note: "The gate was locked" })])
      assert.equal((await completedEvents(overflow.id)).length, 1, "no second completion, no reopening")
    })

    test("a ticket the office closed by hand hears its stop done after, and a correction away from it as the correction alone", async () => {
      const defect = await opened("container-defect")
      const route = await running()
      const placed = await inService()
      const stop = await added(route.id, { service: "repair", containerId: placed.id, ticketId: defect.id })
      assert.equal((await olivia(`/tickets/${defect.id}/complete`, { method: "POST", body: { resolution: "no-action", note: "Customer fixed it" } })).status, 200)
      await driven(route.id, stop.id, "complete-pickup")
      const history = await historyOf(defect.id)
      assert.equal(history.at(-1)?.body, servedAfterClose({ position: stop.position, route: route.label, service: "repair" }))
      assert.equal((await olivia(`/pickups/${stop.id}/correct-outcome`, { method: "POST", body: { outcome: "skipped", reason: "other", note: "Never went" } })).status, 200)
      assert.equal((await historyOf(defect.id)).at(-1)?.body, stopCorrected({ position: stop.position, route: route.label, outcome: "skipped", note: "Never went" }))
      assert.deepEqual([(await ticketOf(defect.id)).resolution, (await completedEvents(defect.id)).length], ["no-action", 1], "the office's own close stands")
    })
  })
})
