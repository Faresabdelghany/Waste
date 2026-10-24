// The ad-hoc Route and the extra Pickup (#111) through the API: `POST
// /routes`, the office's route with no scheme, and `POST /routes/:id/pickups`,
// the office's stop on a route that has not started — a container, whose
// placement on the route's service date gives the place and the fraction, or
// an address-only stop — each with its refusals in the order the API judges
// them; the ad-hoc route under the commands that move every route, the hold's
// two never holding it; the driver door reading an address-only stop; and
// the ticket's `complete · recollected` naming the stop the office added.
import assert from "node:assert/strict"
import { randomInt } from "node:crypto"
import { after, before, describe, test } from "node:test"

import { DriverRouteDetail } from "@waste/contracts/driver-commands"
import { PickupDetail } from "@waste/contracts/pickups"
import { Page } from "@waste/contracts/pagination"
import { Route, RouteDetail, RouteListItem } from "@waste/contracts/routes"
import { Ticket } from "@waste/contracts/tickets"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { product } from "@waste/db/schema/catalogue"
import { container, containerServicePlacement } from "@waste/db/schema/containers"
import { customer, property, sharedCollectionPoint } from "@waste/db/schema/customers"
import { outboxEvent } from "@waste/db/schema/execution"
import { withCompany } from "@waste/db/tenant"
import { activeAnd, doesNotChange } from "@waste/domain/execution/transitions"
import { and, asc, eq } from "drizzle-orm"

import { createApp } from "../app"
import { NOT_A_PICKUP } from "../routes/references"
import { stopWasMissed } from "../routes/tickets"
import { alreadyAStop, NOT_A_CONTAINER, notPlacedOn } from "../routes/pickups"
import { adHocNeverHeld, ORDER_IS_FROZEN } from "../routes/routes"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution, seedRoute, TOWN_HALL, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the tickets' history this suite appends, which `wms_api` may not delete. */
const owner = ownerUnderTest()
const RoutePage = Page(RouteListItem)

/** The request's clock, pinned: noon on the fixtures' Monday. */
const NOON = new Date("2026-10-05T12:00:00Z")
/** The day the office makes its routes for: the Tuesday after the fixtures' Monday. */
const TUESDAY = "2026-10-06"

describe("the ad-hoc route and the extra pickup", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let theirFleet: FleetFixtures
  let ex: ExecutionFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role with view and edit on routes and pickups, and no create: Copenhagen Central only. */
  let viewer: Call
  /** Mads's driver-app login, on the viewer's role with the driver door granted. */
  let mads: Call
  /** The other company's administrator: every route here is one that does not exist for them. */
  let other: Call
  /** BIN-9, placed at Parkvej 18 as glass since January: the container the office's stop names. */
  let placed: { id: string; label: string }
  /** BIN-8, whose placement and subscription stand while the agreement over them ended on 1 October: placed nowhere in force on Tuesday. */
  let lapsed: { id: string; label: string }
  /** A shared collection point of Copenhagen Central, open. */
  let point: { id: string }
  /** A property of Copenhagen Central that is inactive. */
  let inactive: { id: string }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    theirFleet = await seedFleet(pool, b, await seedPlanning(pool, b))
    await grantRole(pool, a.companyId, a.roles.viewer.id, [
      { moduleKey: "route-studio.routes", actions: ["view", "edit"] },
      { moduleKey: "route-studio.pickups", actions: ["view", "edit"] },
      { moduleKey: "operate.driver-app", actions: ["view", "edit"] },
    ])
    placed = { id: testId(), label: "BIN-9" }
    lapsed = { id: testId(), label: "BIN-8" }
    point = { id: testId() }
    inactive = { id: testId() }
    const scoped = { companyId: a.companyId, projectId: a.projects.copenhagen.id }
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      const customerId = testId()
      const productId = testId()
      const agreementId = testId()
      const subscriptionId = testId()
      await tx.insert(customer).values({ id: customerId, companyId: a.companyId, kind: "organisation", name: "Parkvej Boligforening", registrationNumber: String(randomInt(10_000_000, 100_000_000)), status: "active" })
      await tx.insert(product).values({ id: productId, ...scoped, name: "Glass 240 L", kind: "container-collection", status: "active", unit: "pickup", containerTypeId: ex.containerTypes.bin.id, wasteFractionId: ex.fractions.glass.id })
      await tx.insert(agreement).values({ id: agreementId, ...scoped, validFrom: "2026-01-01", number: "AGR-111", customerId, payerCustomerId: customerId, status: "active", billingCadence: "monthly", currency: "DKK" })
      await tx.insert(subscription).values({ id: subscriptionId, ...scoped, validFrom: "2026-01-01", agreementId, productId, propertyId: ex.properties.parkvej.id })
      await tx.insert(container).values({ id: placed.id, ...scoped, label: placed.label, containerTypeId: ex.containerTypes.bin.id, ownership: "company" })
      // BIN-9 is the stop's container; BIN-1 is placed too, and is a stop of the fixtures' planned route already.
      await tx.insert(containerServicePlacement).values([
        { id: testId(), ...scoped, validFrom: "2026-01-01", containerId: placed.id, subscriptionId, wasteFractionId: ex.fractions.glass.id },
        { id: testId(), ...scoped, validFrom: "2026-01-01", containerId: ex.containers.bin1.id, subscriptionId, wasteFractionId: ex.fractions.residual.id },
      ])
      // An agreement that ended on 1 October over a subscription and a placement left open, as an import may leave them: generation would not plan BIN-8 on Tuesday, and neither may the office.
      const endedId = testId()
      const endedSubscriptionId = testId()
      await tx.insert(agreement).values({ id: endedId, ...scoped, validFrom: "2026-01-01", validTo: "2026-10-01", number: "AGR-110", customerId, payerCustomerId: customerId, status: "active", billingCadence: "monthly", currency: "DKK" })
      await tx.insert(subscription).values({ id: endedSubscriptionId, ...scoped, validFrom: "2026-01-01", agreementId: endedId, productId, propertyId: ex.properties.norrebrogade.id })
      await tx.insert(container).values({ id: lapsed.id, ...scoped, label: lapsed.label, containerTypeId: ex.containerTypes.bin.id, ownership: "company" })
      await tx.insert(containerServicePlacement).values({ id: testId(), ...scoped, validFrom: "2026-01-01", containerId: lapsed.id, subscriptionId: endedSubscriptionId, wasteFractionId: ex.fractions.residual.id })
      await tx.insert(sharedCollectionPoint).values({ id: point.id, ...scoped, name: "Miljøstation Nord", kind: "surface", address: "Parkvej 20, 2100 København Ø", location: TOWN_HALL, operatingModel: "municipal", accessMode: "open", billingMode: "municipal", status: "open" })
      await tx.insert(property).values({ id: inactive.id, ...scoped, name: "Gammel Kongevej 1", address: "Gammel Kongevej 1, 1610 København V", kind: "residential", location: TOWN_HALL, status: "inactive" })
    })
    app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    mads = callingAs(app, keys, ex.logins.mads, a.companyId)
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
  const create = (values: Record<string, unknown>, call = olivia) => call("/routes", { method: "POST", body: { projectId: a.projects.copenhagen.id, operatingDate: TUESDAY, ...values } })
  const made = async (values: Record<string, unknown> = {}, call = olivia): Promise<RouteDetail> => await created(call, "/routes", await create(values, call), RouteDetail)
  const add = (routeId: string, values: Record<string, unknown>, call = olivia) => call(`/routes/${routeId}/pickups`, { method: "POST", body: values })
  const added = async (routeId: string, values: Record<string, unknown>, call = olivia): Promise<PickupDetail> => await created(call, `/routes/${routeId}/pickups`, await add(routeId, values, call), PickupDetail, "/pickups")
  /** The `Route` inside a detail: what an outbox payload carries. */
  const routeOf = ({ pickups: _pickups, session: _session, sessions: _sessions, unloads: _unloads, activePlan: _activePlan, ...rest }: RouteDetail): Route => rest
  const eventsAbout = async (aggregateId: string) =>
    await withCompany(pool.db, a.companyId, async (tx: Tx) =>
      tx
        .select({ kind: outboxEvent.kind, aggregateKind: outboxEvent.aggregateKind, payload: outboxEvent.payload })
        .from(outboxEvent)
        .where(and(eq(outboxEvent.companyId, a.companyId), eq(outboxEvent.aggregateId, aggregateId)))
        .orderBy(asc(outboxEvent.id)),
    )

  describe("POST /routes", () => {
    test("makes an ad-hoc route: no scheme and no group, its day its service date, planned, numbered from the company's counter, with what the body names; the assignment is written as assign writes it", async () => {
      const route = await made({ depotId: fleet.depots.nordhavn.id, unloadingStationId: fleet.stations.amager.id, vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.mads.id, note: "Re-collections for Tuesday" })
      assert.deepEqual(
        { scheme: route.routeSchemeId, group: route.collectionGroupId, serviceDate: route.serviceDate, operatingDate: route.operatingDate, status: route.status, note: route.note, run: route.generationRunId, heldAt: route.heldAt, pickups: route.pickups },
        { scheme: null, group: null, serviceDate: TUESDAY, operatingDate: TUESDAY, status: "planned", note: "Re-collections for Tuesday", run: null, heldAt: null, pickups: [] },
      )
      assert.deepEqual(route.planned, { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.mads.id, trailerId: null, serviceProviderId: null, depotId: fleet.depots.nordhavn.id, unloadingStationId: fleet.stations.amager.id })
      assert.equal(route.label, `RC-${route.number}`)
      assert.deepEqual(await read(route.id), route)
      assert.deepEqual(
        (await eventsAbout(route.id)).map((event) => [event.kind, event.aggregateKind, event.payload]),
        [["route-reassigned", "route", routeOf(route)]],
        "the Planned Assignment the office gave it, as assign's event carries it",
      )
      // The next one takes the next number, and one with no driver and no vehicle writes no event.
      const bare = await made({})
      assert.equal(bare.number, route.number + 1)
      assert.deepEqual([bare.planned.vehicleId, bare.planned.driverId, bare.note], [null, null, null])
      assert.deepEqual(await eventsAbout(bare.id), [])
      // A form's nulls are fields not given.
      const fromAForm = await made({ depotId: null, unloadingStationId: null, vehicleId: null, driverId: null, note: null })
      assert.equal(fromAForm.number, bare.number + 1)
    })

    test("refuses, in order, a project or a reference this account may not name (400 at the field) and then a vehicle or a driver out of service (409), writing nothing", async () => {
      const before = await made({})
      assert.deepEqual((await refused(await create({ projectId: b.projects.copenhagen.id }), 400)).errors, [{ path: "projectId", message: "Not a project this account works in" }])
      assert.deepEqual((await refused(await create({ projectId: a.projects.harbor.id }, viewer), 403)).status, 403, "the viewer may not create, whatever the project")
      assert.deepEqual((await refused(await olivia("/routes", { method: "POST", body: { projectId: a.projects.copenhagen.id } }), 400)).errors?.map((error) => error.path), ["operatingDate"])
      assert.match((await refused(await create({ routeSchemeId: ex.schemes.copenhagen.id }), 400)).errors?.[0].message ?? "", /routeSchemeId/, "the scheme is generation's, never the body's")
      assert.deepEqual((await refused(await create({ depotId: fleet.depots.harbor.id }), 400)).errors, [{ path: "depotId", message: "Not a depot of this project" }])
      assert.deepEqual((await refused(await create({ unloadingStationId: theirFleet.stations.amager.id }), 400)).errors, [{ path: "unloadingStationId", message: "Not an unloading station of this company" }])
      assert.deepEqual((await refused(await create({ vehicleId: fleet.vehicles.trailer.id }), 400)).errors, [{ path: "vehicleId", message: "Not a powered vehicle of this project" }])
      assert.deepEqual((await refused(await create({ driverId: fleet.drivers.henrik.id }), 400)).errors, [{ path: "driverId", message: "Not a driver of this project" }])
      const licence = await refused(await create({ vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.freja.id }), 400)
      assert.deepEqual(licence.errors?.map((error) => error.path), ["driverId"], "Freja holds B, and WH-24 needs C on the operating date")
      assert.match((await refused(await create({ vehicleId: fleet.vehicles.retired.id }), 409)).detail ?? "", /is retired; a route needs a vehicle in service/)
      assert.match((await refused(await create({ driverId: fleet.drivers.karen.id }), 409)).detail ?? "", /is inactive; a route needs an active driver/)
      // A 400 before a 409: a retired truck with another project's depot is told of the depot.
      assert.deepEqual((await refused(await create({ depotId: fleet.depots.harbor.id, vehicleId: fleet.vehicles.retired.id }), 400)).errors?.map((error) => error.path), ["depotId"])
      // Nothing written: the counter took no number for any of them.
      assert.equal((await made({})).number, before.number + 1)
    })

    test("an ad-hoc route moves like any other — assign and reschedule hold nothing, since no run reads it, release-hold refuses it, and it dispatches to its driver", async () => {
      const route = await made({ vehicleId: fleet.vehicles.wh24.id })
      const assigned = RouteDetail.parse(await (await olivia(`/routes/${route.id}/assign`, { method: "POST", body: { driverId: fleet.drivers.mads.id } })).json())
      assert.deepEqual([assigned.planned.driverId, assigned.heldAt], [fleet.drivers.mads.id, null])
      const moved = RouteDetail.parse(await (await olivia(`/routes/${route.id}/reschedule`, { method: "POST", body: { operatingDate: "2026-10-07", plannedStartTime: "07:00" } })).json())
      assert.deepEqual([moved.operatingDate, moved.serviceDate, moved.plannedStartTime, moved.heldAt], ["2026-10-07", TUESDAY, "07:00", null], "the service date stays the day it was made for")
      assert.equal((await refused(await olivia(`/routes/${route.id}/release-hold`, { method: "POST", body: {} }), 409)).detail, adHocNeverHeld(route.label))
      const dispatched = RouteDetail.parse(await (await olivia(`/routes/${route.id}/dispatch`, { method: "POST" })).json())
      assert.equal(dispatched.status, "ready")
      // It lists beside the generated routes, and a scheme's filter never answers it.
      const listed = RoutePage.parse(await (await olivia(`/routes?serviceDate=${TUESDAY}&limit=200`)).json())
      assert.ok(listed.items.some((item) => item.id === route.id))
      const ofTheScheme = RoutePage.parse(await (await olivia(`/routes?routeSchemeId=${ex.schemes.copenhagen.id}&limit=200`)).json())
      assert.equal(ofTheScheme.items.some((item) => item.id === route.id), false)
    })
  })

  describe("POST /routes/:id/pickups", () => {
    test("a container's stop on a generated route takes its place and fraction from the placement on the service date, goes after the last stop, and is the office's", async () => {
      const route = ex.routes.planned
      const beforeAdding = await read(route.id)
      const stop = await added(route.id, { containerId: placed.id, note: "Extra emptying asked for by phone" })
      assert.deepEqual(
        { routeId: stop.routeId, containerId: stop.containerId, origin: stop.origin, status: stop.status, position: stop.position, sequence: stop.sequence, propertyId: stop.propertyId, pointId: stop.sharedCollectionPointId, fraction: stop.wasteFractionId, note: stop.note, proofs: stop.proofs },
        { routeId: route.id, containerId: placed.id, origin: "office", status: "planned", position: 4, sequence: 4, propertyId: ex.properties.parkvej.id, pointId: null, fraction: ex.fractions.glass.id, note: "Extra emptying asked for by phone", proofs: [] },
      )
      const after = await read(route.id)
      assert.deepEqual(
        after.pickups.map((pickup) => [pickup.id, pickup.origin]),
        [...route.pickupIds.map((id) => [id, "generation"]), [stop.id, "office"]],
      )
      assert.ok(after.updatedAt > beforeAdding.updatedAt, "the route's stops are part of it on the wire")
      assert.equal(after.progress.total, beforeAdding.progress.total + 1)
      assert.deepEqual(await eventsAbout(stop.id), [], "no event: the stop is news at its outcome")
    })

    test("an address-only stop names a property or a shared collection point with its fraction and no container, on a ready route too, which the driver's door reads with its address and no label", async () => {
      const route = ex.routes.ready
      const atTheDoor = await added(route.id, { propertyId: ex.properties.havnegade.id, wasteFractionId: ex.fractions.residual.id, note: "Re-collection of the missed bin" })
      assert.deepEqual([atTheDoor.containerId, atTheDoor.origin, atTheDoor.position, atTheDoor.propertyId, atTheDoor.wasteFractionId], [null, "office", 4, ex.properties.havnegade.id, ex.fractions.residual.id])
      const atThePoint = await added(route.id, { sharedCollectionPointId: point.id, wasteFractionId: ex.fractions.glass.id })
      assert.deepEqual([atThePoint.containerId, atThePoint.position, atThePoint.sharedCollectionPointId, atThePoint.propertyId], [null, 5, point.id, null])
      const response = await mads(`/driver/routes/${route.id}`)
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
      const driven = DriverRouteDetail.parse(await response.json())
      const seen = driven.pickups.find((pickup) => pickup.id === atTheDoor.id)
      assert.deepEqual([seen?.containerLabel, seen?.address, seen?.note], [null, "Havnegade 3, 1058 København K", "Re-collection of the missed bin"])
      assert.equal(driven.pickups.find((pickup) => pickup.id === atThePoint.id)?.address, "Parkvej 20, 2100 København Ø")
      assert.equal(driven.pickups.length, 5, "the generated three and the office's two")
    })

    test("refuses a route that has started (409), then a body that names no stop or names what is not the project's (400 at the field), then a container placed nowhere that day, one already a stop, or a place not served (409)", async () => {
      const active = await seedRoute(pool, a, fleet, ex, { status: "active", plannedDriverId: fleet.drivers.mads.id, plannedVehicleId: fleet.vehicles.wh24.id, deviceId: "device-111" })
      assert.equal((await refused(await add(active.id, { containerId: placed.id }), 409)).detail, activeAnd(active.label, ORDER_IS_FROZEN))
      assert.equal((await refused(await add(ex.routes.completed.id, { containerId: placed.id }), 409)).detail, doesNotChange(ex.routes.completed.label, "completed"))
      assert.equal((await refused(await add(ex.routes.planned.id, { containerId: placed.id }, other), 404)).status, 404, "another company's route is not there")
      // The contract's shape is the middleware's, judged before the route is read, as on every route here: a body naming no stop is a 400 on a started route too.
      assert.deepEqual((await refused(await add(active.id, {}), 400)).errors?.map((error) => error.path), ["containerId"])
      const planned = ex.routes.planned.id
      assert.deepEqual((await refused(await add(planned, {}), 400)).errors?.map((error) => error.path), ["containerId"])
      assert.deepEqual((await refused(await add(planned, { containerId: ex.containers.harborBin.id }), 400)).errors, [{ path: "containerId", message: NOT_A_CONTAINER }])
      assert.deepEqual((await refused(await add(planned, { propertyId: ex.properties.harbor.id, wasteFractionId: ex.fractions.residual.id }), 400)).errors, [{ path: "propertyId", message: "Not a property of this project" }])
      assert.deepEqual((await refused(await add(planned, { propertyId: ex.properties.parkvej.id, wasteFractionId: testId() }), 400)).errors?.map((error) => error.path), ["wasteFractionId"])
      assert.equal((await refused(await add(planned, { containerId: ex.containers.bin2.id }), 409)).detail, notPlacedOn("BIN-2"))
      assert.equal((await refused(await add(planned, { containerId: lapsed.id }), 409)).detail, notPlacedOn("BIN-8"), "its placement stands, its agreement does not: not in force, as generation judges a stop")
      assert.equal((await refused(await add(planned, { containerId: ex.containers.bin1.id }), 409)).detail, alreadyAStop("BIN-1", ex.routes.planned.label, "planned"), "a container is one stop of a route, generation's or the office's")
      assert.equal((await refused(await add(planned, { propertyId: inactive.id, wasteFractionId: ex.fractions.residual.id }), 409)).detail, "The property is inactive; a stop needs an active property")
      // Nothing written by any of them.
      assert.equal((await read(planned)).pickups.filter((pickup) => pickup.origin === "office").length, 1, "the one stop the first test added")
    })

    test("is a dispatcher's command: edit on route-studio.pickups is enough, and a second stop of one container is refused whoever adds it", async () => {
      const route = await made({})
      const stop = await added(route.id, { containerId: placed.id }, viewer)
      assert.deepEqual([stop.position, stop.origin], [1, "office"])
      assert.equal((await refused(await add(route.id, { containerId: placed.id }, viewer), 409)).detail, alreadyAStop(placed.label, route.label, "planned"))
      // Taken off again, it is still the route's one stop of that container, and the refusal says what it stands at.
      const removed = await olivia(`/pickups/${stop.id}/remove`, { method: "POST", body: { reason: "Added by mistake" } })
      assert.equal(removed.status, 200, JSON.stringify(await removed.clone().json()))
      assert.equal((await refused(await add(route.id, { containerId: placed.id }, viewer), 409)).detail, alreadyAStop(placed.label, route.label, "skipped"))
      // The ad-hoc route's service date is its day: the placement valid on Tuesday is the one read.
      assert.equal(stop.wasteFractionId, ex.fractions.glass.id)
    })
  })

  describe("POST /tickets/:id/complete with the re-collection's stop", () => {
    test("names the stop the office added beside the route it rides on, refuses a stop of another route at its field, and reopen clears both", async () => {
      const route = await made({ driverId: fleet.drivers.mads.id })
      const stop = await added(route.id, { propertyId: ex.properties.parkvej.id, wasteFractionId: ex.fractions.residual.id })
      const ticket = await created(olivia, "/tickets", await olivia("/tickets", { method: "POST", body: { projectId: a.projects.copenhagen.id, subject: "Bin not emptied", description: "The bin at Parkvej 18 was not emptied on Monday.", kind: "missed-collection" } }), Ticket)
      const complete = (values: Record<string, unknown>) => olivia(`/tickets/${ticket.id}/complete`, { method: "POST", body: { resolution: "recollected", note: "On Tuesday's extra stop", ...values } })
      assert.deepEqual((await refused(await complete({ recollectionRouteId: route.id, recollectionPickupId: ex.routes.planned.pickupIds[0] }), 400)).errors, [{ path: "recollectionPickupId", message: NOT_A_PICKUP }])
      assert.deepEqual((await refused(await complete({ recollectionPickupId: stop.id }), 400)).errors?.map((error) => error.path), ["recollectionPickupId"], "never without its route")
      // A stop that was missed is no re-collection: one taken off the route is refused after the 400s.
      const takenOff = await added(route.id, { propertyId: ex.properties.havnegade.id, wasteFractionId: ex.fractions.residual.id })
      assert.equal((await olivia(`/pickups/${takenOff.id}/remove`, { method: "POST", body: { reason: "Wrong address" } })).status, 200)
      assert.equal((await refused(await complete({ recollectionRouteId: route.id, recollectionPickupId: takenOff.id }), 409)).detail, stopWasMissed(takenOff.position, route.label, "skipped"))
      const response = await complete({ recollectionRouteId: route.id, recollectionPickupId: stop.id })
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
      const completed = Ticket.parse(await response.json())
      assert.deepEqual([completed.resolution, completed.recollectionRouteId, completed.recollectionPickupId], ["recollected", route.id, stop.id])
      const [event] = (await eventsAbout(ticket.id)).filter((row) => row.kind === "ticket-completed")
      assert.deepEqual(event?.payload, completed, "Finance reads the stop off the event")
      const reopened = Ticket.parse(await (await olivia(`/tickets/${ticket.id}/reopen`, { method: "POST", body: { note: "The customer called again" } })).json())
      assert.deepEqual([reopened.recollectionRouteId, reopened.recollectionPickupId], [null, null])
    })
  })
})
