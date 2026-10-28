// Moving stops, splitting a route and merging two (O23 of #290, #358)
// through the API: a stop moved is taken off where it stood and added as the
// office's on the other route, judged there as Add stop judges it; a split's
// stops go onto a new ad-hoc route of the day; a merge takes every open stop
// and cancels the route it emptied as `merged`. Each command's refusals in
// the order the API judges them, the events written, and a ticket's booking
// going with its stop.
import assert from "node:assert/strict"
import { randomInt } from "node:crypto"
import { after, before, describe, test } from "node:test"

import { PickupDetail } from "@waste/contracts/pickups"
import { RouteDetail } from "@waste/contracts/routes"
import { Ticket } from "@waste/contracts/tickets"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { product } from "@waste/db/schema/catalogue"
import { containerServicePlacement } from "@waste/db/schema/containers"
import { customer } from "@waste/db/schema/customers"
import { outboxEvent } from "@waste/db/schema/execution"
import { ticketBooking } from "@waste/db/schema/resolution"
import { withCompany } from "@waste/db/tenant"
import { ANOTHER_ROUTE, emptiedThereAlready, mergedInto, movedTo, NOT_A_ROUTE_OF_THE_PROJECT, notOpenStopsOf, splitLeavesNone } from "@waste/domain/execution/stop-moves"
import { activeAnd, doesNotChange } from "@waste/domain/execution/transitions"
import { and, asc, eq, inArray } from "drizzle-orm"

import { createApp } from "../app"
import { ORDER_IS_FROZEN } from "../routes/routes"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { FIXTURE_DAY, seedExecution, seedRoute, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the tickets' history this suite appends, which `wms_api` may not delete. */
const owner = ownerUnderTest()

/** The request's clock, pinned: an hour before noon on the fixtures' Monday. */
const NOW = new Date(`${FIXTURE_DAY}T09:00:00Z`)

describe("moving stops, splitting and merging routes", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** View and edit on routes and pickups, and no create: may move and merge, never split. */
  let viewer: Call
  let other: Call

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [
      { moduleKey: "route-studio.routes", actions: ["view", "edit"] },
      { moduleKey: "route-studio.pickups", actions: ["view", "edit"] },
    ])
    // The three bins served at their addresses since January, as generation would plan them: a moved stop is judged on its new route's service date.
    const scoped = { companyId: a.companyId, projectId: a.projects.copenhagen.id }
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      const customerId = testId()
      const productId = testId()
      const agreementId = testId()
      await tx.insert(customer).values({ id: customerId, companyId: a.companyId, kind: "organisation", name: "Københavns Boliger", registrationNumber: String(randomInt(10_000_000, 100_000_000)), status: "active" })
      await tx.insert(product).values({ id: productId, ...scoped, name: "Residual 240 L", kind: "container-collection", status: "active", unit: "pickup", containerTypeId: ex.containerTypes.bin.id, wasteFractionId: ex.fractions.residual.id })
      await tx.insert(agreement).values({ id: agreementId, ...scoped, validFrom: "2026-01-01", number: "AGR-358", customerId, payerCustomerId: customerId, status: "active", billingCadence: "monthly", currency: "DKK" })
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
    app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOW })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
  })
  after(async () => {
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
  /** A planned Copenhagen route on the fixtures' Monday: the three bins unless said otherwise. */
  const route = (values: Parameters<typeof seedRoute>[4] = {}) => seedRoute(pool, a, fleet, ex, values)
  const empty = () => route({ pickups: [] })
  const move = (from: string, body: Record<string, unknown>, call = olivia) => call(`/routes/${from}/move-stops`, { method: "POST", body })
  const moved = async (from: string, body: Record<string, unknown>): Promise<RouteDetail> => {
    const response = await move(from, body)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return RouteDetail.parse(await response.json())
  }
  const split = (from: string, body: Record<string, unknown>, call = olivia) => call(`/routes/${from}/split`, { method: "POST", body })
  const merge = (into: string, body: Record<string, unknown>, call = olivia) => call(`/routes/${into}/merge`, { method: "POST", body })
  const eventsAbout = async (ids: readonly string[]) =>
    await withCompany(pool.db, a.companyId, async (tx: Tx) =>
      tx
        .select({ kind: outboxEvent.kind, aggregateId: outboxEvent.aggregateId })
        .from(outboxEvent)
        .where(and(eq(outboxEvent.companyId, a.companyId), inArray(outboxEvent.aggregateId, [...ids])))
        .orderBy(asc(outboxEvent.id)),
    )
  const stopsOf = (detail: RouteDetail) => detail.pickups.map((stop) => [stop.containerId, stop.status, stop.reason, stop.origin, stop.position])

  describe("POST /routes/:id/move-stops", () => {
    test("takes the stops off where they stood, saying where they went, and adds them to the other route as the office's after its last stop, in the order they stood", async () => {
      const from = await route()
      const to = await route({ pickups: [{ containerId: ex.containers.bin3.id, propertyId: ex.properties.norrebrogade.id }] })
      const before = { from: await read(from.id), to: await read(to.id) }
      const [bin1, bin2] = from.pickupIds
      const left = await moved(from.id, { pickupIds: [bin2, bin1], toRouteId: to.id })
      assert.deepEqual(stopsOf(left), [
        [ex.containers.bin1.id, "skipped", "removed-by-dispatcher", "generation", 1],
        [ex.containers.bin2.id, "skipped", "removed-by-dispatcher", "generation", 2],
        [ex.containers.bin3.id, "planned", null, "generation", 3],
      ])
      assert.deepEqual(
        left.pickups.slice(0, 2).map((stop) => stop.note),
        [movedTo(to.label), movedTo(to.label)],
      )
      const joined = await read(to.id)
      assert.deepEqual(stopsOf(joined), [
        [ex.containers.bin3.id, "planned", null, "generation", 1],
        [ex.containers.bin1.id, "planned", null, "office", 2],
        [ex.containers.bin2.id, "planned", null, "office", 3],
      ])
      assert.deepEqual(
        joined.pickups.slice(1).map((stop) => [stop.propertyId, stop.wasteFractionId]),
        [
          [ex.properties.parkvej.id, ex.fractions.residual.id],
          [ex.properties.havnegade.id, ex.fractions.residual.id],
        ],
        "judged on the route's service date, as Add stop judges a container's stop",
      )
      assert.ok(left.updatedAt > before.from.updatedAt && joined.updatedAt > before.to.updatedAt, "both routes' stops are part of them on the wire")
      assert.deepEqual(
        (await eventsAbout([bin1, bin2])).map((event) => [event.kind, event.aggregateId]),
        [
          ["pickup-skipped", bin1],
          ["pickup-skipped", bin2],
        ],
        "each stop taken off is told as remove tells it",
      )
    })

    test("moves onto a ready route, whose driver reads it through the routes' reads", async () => {
      const from = await route()
      const to = await route({ status: "ready", plannedDriverId: fleet.drivers.mads.id, plannedVehicleId: fleet.vehicles.wh24.id, pickups: [] })
      await moved(from.id, { pickupIds: [from.pickupIds[0]], toRouteId: to.id })
      assert.deepEqual(stopsOf(await read(to.id)), [[ex.containers.bin1.id, "planned", null, "office", 1]])
    })

    test("refuses, in order: a route not here (404), one that has started (409), the route itself or one of another project (400 at toRouteId), an id that is not an open stop (400 at pickupIds), a route to go to that has started (409), and an emptying the other route has already (409) — writing nothing", async () => {
      const from = await route()
      const to = await empty()
      const active = await route({ status: "active", plannedDriverId: fleet.drivers.mads.id, plannedVehicleId: fleet.vehicles.wh24.id, deviceId: "device-358" })
      const harbor = await route({ project: "harbor" })
      const [bin1] = from.pickupIds
      assert.equal((await refused(await move(from.id, { pickupIds: [bin1], toRouteId: to.id }, other), 404)).status, 404, "another company's route is not there")
      assert.equal((await refused(await move(active.id, { pickupIds: [active.pickupIds[0]], toRouteId: to.id }), 409)).detail, activeAnd(active.label, ORDER_IS_FROZEN))
      assert.equal((await refused(await move(ex.routes.completed.id, { pickupIds: [bin1], toRouteId: to.id }), 409)).detail, doesNotChange(ex.routes.completed.label, "completed"))
      assert.deepEqual((await refused(await move(from.id, { pickupIds: [bin1], toRouteId: from.id }), 400)).errors, [{ path: "toRouteId", message: ANOTHER_ROUTE }])
      assert.deepEqual((await refused(await move(from.id, { pickupIds: [bin1], toRouteId: harbor.id }), 400)).errors, [{ path: "toRouteId", message: NOT_A_ROUTE_OF_THE_PROJECT }])
      assert.deepEqual((await refused(await move(from.id, { pickupIds: [bin1], toRouteId: testId() }), 400)).errors, [{ path: "toRouteId", message: NOT_A_ROUTE_OF_THE_PROJECT }])
      assert.deepEqual((await refused(await move(from.id, { pickupIds: [bin1, to.id, ex.routes.completed.pickupIds[0]], toRouteId: to.id }), 400)).errors, [{ path: "pickupIds", message: notOpenStopsOf(2, from.label) }])
      assert.equal((await refused(await move(from.id, { pickupIds: [bin1], toRouteId: active.id }), 409)).detail, activeAnd(active.label, ORDER_IS_FROZEN))
      // BIN-3 is emptied on the other route already: the two would be one collection.
      const withBin3 = await route({ pickups: [{ containerId: ex.containers.bin3.id, propertyId: ex.properties.norrebrogade.id }] })
      assert.equal((await refused(await move(from.id, { pickupIds: [bin1, from.pickupIds[2]], toRouteId: withBin3.id }), 409)).detail, emptiedThereAlready(ex.containers.bin3.label, withBin3.label))
      // Nothing written by any of them.
      assert.deepEqual(
        (await read(from.id)).pickups.map((stop) => stop.status),
        ["planned", "planned", "planned"],
      )
      assert.deepEqual(stopsOf(await read(withBin3.id)), [[ex.containers.bin3.id, "planned", null, "generation", 1]])
      assert.deepEqual(await eventsAbout(from.pickupIds), [])
    })

    test("a stop that answers an open ticket takes the ticket with it: booked for the new stop, the ledger keeping both", async () => {
      const from = await route()
      const to = await empty()
      const ticket = await created(
        olivia,
        "/tickets",
        await olivia("/tickets", { method: "POST", body: { projectId: a.projects.copenhagen.id, kind: "overflow", subject: "Overflow at Parkvej 18", description: "Phoned in", links: { propertyId: ex.properties.parkvej.id, containerId: ex.containers.bin1.id } } }),
        Ticket,
      )
      const extra = await created(olivia, `/routes/${from.id}/pickups`, await olivia(`/routes/${from.id}/pickups`, { method: "POST", body: { containerId: ex.containers.bin1.id, ticketId: ticket.id, note: "Overflowing" } }), PickupDetail, "/pickups")
      await moved(from.id, { pickupIds: [extra.id], toRouteId: to.id })
      const [now] = (await read(to.id)).pickups
      assert.deepEqual([now.containerId, now.origin, now.note], [ex.containers.bin1.id, "office", "Overflowing"])
      const answered = Ticket.parse(await (await olivia(`/tickets/${ticket.id}`)).json())
      assert.deepEqual([answered.bookedPickupId, answered.bookedRouteId], [now.id, to.id])
      const ledger = await withCompany(pool.db, a.companyId, (tx: Tx) => tx.select({ pickupId: ticketBooking.pickupId }).from(ticketBooking).where(eq(ticketBooking.ticketId, ticket.id)).orderBy(asc(ticketBooking.id)))
      assert.deepEqual(
        ledger.map((row) => row.pickupId),
        [extra.id, now.id],
      )
    })
  })

  describe("POST /routes/:id/split", () => {
    test("makes an ad-hoc route on the route's day with its depot, station, start and provider and the crew the body names, and moves the stops onto it", async () => {
      const from = await route({ depotId: fleet.depots.nordhavn.id, unloadingStationId: fleet.stations.amager.id, plannedStartTime: "06:30" })
      const response = await split(from.id, { pickupIds: [from.pickupIds[2]], vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.mads.id, note: "Second truck" })
      const made = await created(olivia, "/routes", response, RouteDetail)
      assert.deepEqual(
        { scheme: made.routeSchemeId, serviceDate: made.serviceDate, operatingDate: made.operatingDate, status: made.status, note: made.note, start: made.plannedStartTime },
        { scheme: null, serviceDate: FIXTURE_DAY, operatingDate: FIXTURE_DAY, status: "planned", note: "Second truck", start: "06:30" },
      )
      assert.deepEqual(made.planned, { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.mads.id, trailerId: null, serviceProviderId: null, depotId: fleet.depots.nordhavn.id, unloadingStationId: fleet.stations.amager.id })
      assert.deepEqual(stopsOf(made), [[ex.containers.bin3.id, "planned", null, "office", 1]])
      const left = await read(from.id)
      assert.deepEqual(
        left.pickups.map((stop) => [stop.status, stop.note]),
        [
          ["planned", null],
          ["planned", null],
          ["skipped", movedTo(made.label)],
        ],
      )
      assert.deepEqual(
        (await eventsAbout([made.id])).map((event) => event.kind),
        ["route-reassigned"],
        "the crew it was made with, as POST /routes tells it",
      )
    })

    test("refuses a split that would take every open stop (400), the crew POST /routes refuses (400, then 409), and a role that may not create routes (403)", async () => {
      const from = await route()
      assert.deepEqual((await refused(await split(from.id, { pickupIds: from.pickupIds }), 400)).errors, [{ path: "pickupIds", message: splitLeavesNone(from.label) }])
      assert.deepEqual((await refused(await split(from.id, { pickupIds: [from.pickupIds[0]], vehicleId: fleet.vehicles.trailer.id }), 400)).errors, [{ path: "vehicleId", message: "Not a powered vehicle of this project" }])
      assert.match((await refused(await split(from.id, { pickupIds: [from.pickupIds[0]], driverId: fleet.drivers.karen.id }), 409)).detail ?? "", /is inactive; a route needs an active driver/)
      assert.equal((await refused(await split(from.id, { pickupIds: [from.pickupIds[0]] }, viewer), 403)).status, 403)
      assert.deepEqual(
        (await read(from.id)).pickups.map((stop) => stop.status),
        ["planned", "planned", "planned"],
        "nothing written",
      )
    })
  })

  describe("POST /routes/:id/merge", () => {
    test("moves every open stop of the other route onto this one and cancels it as merged, its stops taken off rather than cancelled", async () => {
      const into = await route({ pickups: [{ containerId: ex.containers.bin3.id, propertyId: ex.properties.norrebrogade.id }] })
      const away = await route({ pickups: [{ containerId: ex.containers.bin1.id, propertyId: ex.properties.parkvej.id }, { containerId: ex.containers.bin2.id, propertyId: ex.properties.havnegade.id, status: "skipped", reason: "removed-by-dispatcher", outcomeAt: new Date(`${FIXTURE_DAY}T05:00:00Z`) }] })
      const response = await merge(into.id, { routeId: away.id }, viewer)
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
      const kept = RouteDetail.parse(await response.json())
      assert.deepEqual(stopsOf(kept), [
        [ex.containers.bin3.id, "planned", null, "generation", 1],
        [ex.containers.bin1.id, "planned", null, "office", 2],
      ])
      const gone = await read(away.id)
      assert.deepEqual([gone.status, gone.cancelReasonCode, gone.note, gone.heldAt], ["cancelled", "merged", mergedInto(into.label), null])
      assert.deepEqual(
        gone.pickups.map((stop) => [stop.status, stop.reason, stop.note]),
        [
          ["skipped", "removed-by-dispatcher", movedTo(into.label)],
          ["skipped", "removed-by-dispatcher", null],
        ],
      )
      assert.deepEqual(
        (await eventsAbout([away.id, ...away.pickupIds])).map((event) => [event.kind, event.aggregateId]),
        [
          ["pickup-skipped", away.pickupIds[0]],
          ["route-cancelled", away.id],
        ],
      )
    })

    test("refuses the route itself or one of another project (400 at routeId), a route that has started on either side (409), and another company's (404)", async () => {
      const into = await route()
      const away = await route()
      // A driver of its own: Mads is out on the move's active route already.
      const active = await route({ status: "active", deviceId: "device-358-b" })
      assert.deepEqual((await refused(await merge(into.id, { routeId: into.id }), 400)).errors, [{ path: "routeId", message: ANOTHER_ROUTE }])
      assert.deepEqual((await refused(await merge(into.id, { routeId: (await route({ project: "harbor" })).id }), 400)).errors, [{ path: "routeId", message: NOT_A_ROUTE_OF_THE_PROJECT }])
      assert.equal((await refused(await merge(active.id, { routeId: away.id }), 409)).detail, activeAnd(active.label, ORDER_IS_FROZEN))
      assert.equal((await refused(await merge(into.id, { routeId: active.id }), 409)).detail, activeAnd(active.label, ORDER_IS_FROZEN))
      assert.equal((await refused(await merge(into.id, { routeId: away.id }, other), 404)).status, 404)
      assert.equal((await read(away.id)).status, "planned", "nothing written")
    })
  })
})
