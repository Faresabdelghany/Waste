import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { DriverCommandReceipt } from "@waste/contracts/driver-commands"
import { Page } from "@waste/contracts/pagination"
import { Route, RouteDetail } from "@waste/contracts/routes"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { driverCommand, outboxEvent, session } from "@waste/db/schema/execution"
import { unloadingStation, unloadingStationFraction } from "@waste/db/schema/places"
import { vehicle } from "@waste/db/schema/fleet"
import { withCompany } from "@waste/db/tenant"
import { and, asc, eq } from "drizzle-orm"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { nextMillisecond } from "./clock"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { at, seedExecution, seedRoute, TOWN_HALL, type ExecutionFixtures, type SeededRoute } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, SOFIE_LICENCE_EXPIRY, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the proofs the fixtures append and the receipt this suite writes, which `wms_api` may not delete. */
const owner = ownerUnderTest()
const RoutePage = Page(Route)
const ReceiptPage = Page(DriverCommandReceipt)

const MODULE = "route-studio.routes"

/** The request's clock, pinned: noon on the fixtures' Monday, so a command's stamp is known. */
const NOON = new Date("2026-10-05T12:00:00Z")

describe("the route endpoints", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  /** The company under test. */
  let a: Tenant
  /** The other company, seeded once and read from never again but to prove it is invisible. */
  let b: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let theirs: ExecutionFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted view and edit, with Project Access to Copenhagen Central only. */
  let viewer: Call
  /** The Service Provider Manager, whose charter grants route-studio view: a role that reaches no project of the company — the foreman. */
  let lars: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call
  /** A route of Harbor Commercial, which the viewer does not work in. */
  let harbors: SeededRoute

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    const theirFleet = await seedFleet(pool, b, await seedPlanning(pool, b))
    theirs = await seedExecution(pool, b, theirFleet)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "edit"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)
    harbors = await seedRoute(pool, a, fleet, ex, { project: "harbor", plannedDriverId: fleet.drivers.henrik.id, plannedVehicleId: fleet.vehicles.harborTruck.id })
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
  const read = async (id: string, call = olivia): Promise<RouteDetail> => {
    const response = await call(`/routes/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return RouteDetail.parse(await response.json())
  }
  const page = async (call: Call, query = "?limit=200") => RoutePage.parse(await (await call(`/routes${query}`)).json())
  const command = (id: string, action: string, values?: unknown, call = olivia) => call(`/routes/${id}/${action}`, { method: "POST", body: values })
  const commanded = async (id: string, action: string, values?: unknown, call = olivia): Promise<RouteDetail> => {
    const response = await command(id, action, values, call)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return RouteDetail.parse(await response.json())
  }
  /** The `Route` inside a detail: what an outbox payload carries. */
  const routeOf = ({ pickups: _pickups, session: _session, sessions: _sessions, unloads: _unloads, ...rest }: RouteDetail): Route => rest
  /** The outbox rows about one aggregate, oldest first, read as `wms_api` under the fence. */
  const eventsAbout = async (aggregateId: string, companyId = a.companyId) =>
    await withCompany(pool.db, companyId, async (tx: Tx) =>
      tx
        .select({ kind: outboxEvent.kind, aggregateKind: outboxEvent.aggregateKind, projectId: outboxEvent.projectId, occurredAt: outboxEvent.occurredAt, payload: outboxEvent.payload, publishedAt: outboxEvent.publishedAt })
        .from(outboxEvent)
        .where(and(eq(outboxEvent.companyId, companyId), eq(outboxEvent.aggregateId, aggregateId)))
        .orderBy(asc(outboxEvent.id)),
    )
  const fresh = (seed: Parameters<typeof seedRoute>[4] = {}) => seedRoute(pool, a, fleet, ex, seed)
  const mads = () => ({ plannedDriverId: fleet.drivers.mads.id, plannedVehicleId: fleet.vehicles.wh24.id })

  describe("GET /routes", () => {
    test("lists the caller's projects' routes in id order with their progress, filters them, and shows nothing to a foreman or across companies", async () => {
      const everything = await page(olivia)
      const ids = everything.items.map((row) => row.id)
      assert.deepEqual(ids.slice(0, 3), [ex.routes.ready.id, ex.routes.planned.id, ex.routes.completed.id], "the order they were made in")
      assert.ok(ids.includes(harbors.id), "Olivia works in every project")
      assert.ok(!ids.includes(theirs.routes.ready.id), "and sees no other company's")
      const ready = everything.items.find((row) => row.id === ex.routes.ready.id)
      assert.deepEqual(ready?.progress, { planned: 3, completed: 0, skipped: 0, failed: 0, total: 3, fraction: 0 })
      assert.deepEqual([ready?.label, ready?.status, ready?.planned.driverId, ready?.planned.vehicleId, ready?.plannedStartTime], [ex.routes.ready.label, "ready", fleet.drivers.mads.id, fleet.vehicles.wh24.id, "06:00"])
      const completed = everything.items.find((row) => row.id === ex.routes.completed.id)
      assert.deepEqual(completed?.progress, { planned: 0, completed: 1, skipped: 1, failed: 1, total: 3, fraction: 1 }, "done is every pickup with an outcome, the skipped counted")
      assert.deepEqual([completed?.actual.driverId, completed?.actual.vehicleId, completed?.actual.trailerId], [fleet.drivers.mads.id, fleet.vehicles.wh24.id, null], "the session's crew is the actual assignment")

      const filtered = async (query: string) => (await page(olivia, `?limit=200${query}`)).items.map((row) => row.id)
      assert.deepEqual(await filtered(`&projectId=${a.projects.harbor.id}`), [harbors.id])
      assert.deepEqual(await filtered(`&routeSchemeId=${ex.schemes.harbor.id}`), [harbors.id])
      assert.deepEqual(await filtered(`&collectionGroupId=${harbors.collectionGroupId}`), [harbors.id])
      assert.deepEqual(await filtered(`&collectionGroupId=${ex.routes.ready.collectionGroupId}`), [ex.routes.ready.id], "a group generates one route a day, so its routes are that route")
      assert.deepEqual(await filtered(`&status=completed`), [ex.routes.completed.id])
      assert.deepEqual(await filtered(`&plannedDriverId=${fleet.drivers.henrik.id}`), [harbors.id])
      assert.deepEqual(await filtered(`&plannedVehicleId=${fleet.vehicles.harborTruck.id}`), [harbors.id])
      assert.ok((await filtered(`&from=${ex.day}&to=${ex.day}`)).includes(ex.routes.ready.id))
      assert.deepEqual(await filtered(`&from=2026-10-06&to=2026-10-06`), [], "no route operates the day after")
      assert.deepEqual(await filtered(`&serviceDate=2026-10-06`), [])
      assert.ok((await filtered(`&serviceDate=${ex.day}`)).includes(ex.routes.planned.id))

      const first = await page(olivia, "?limit=1")
      assert.deepEqual(first.items.map((row) => row.id), [ex.routes.ready.id])
      assert.ok(first.nextCursor !== null)
      assert.deepEqual((await page(olivia, `?limit=2&cursor=${first.nextCursor}`)).items.map((row) => row.id), [ex.routes.planned.id, ex.routes.completed.id])

      const copenhagenOnly = await page(viewer)
      assert.ok(copenhagenOnly.items.some((row) => row.id === ex.routes.ready.id))
      assert.ok(!copenhagenOnly.items.some((row) => row.id === harbors.id), "the viewer works in Copenhagen only")
      assert.deepEqual(await page(lars), { items: [], nextCursor: null }, "a provider's foreman works in no project and lists nothing")
    })

    test("refuses a backwards window, a project out of reach, a bad cursor, and a role without view", async () => {
      const backwards = await refused(await olivia("/routes?from=2026-10-06&to=2026-10-05"), 400)
      assert.deepEqual(backwards.errors?.map((error) => error.path), ["to"])
      const project = await refused(await viewer(`/routes?projectId=${a.projects.harbor.id}`), 400)
      assert.deepEqual(project.errors, [{ path: "projectId", message: "Not a project this account works in" }])
      assert.deepEqual((await refused(await olivia("/routes?cursor=nope"), 400)).errors?.map((error) => error.path), ["cursor"])
      assert.match((await refused(await ungranted("/routes"), 403)).detail ?? "", /view on route-studio\.routes/)
      assert.equal((await app.request("/routes")).status, 401)
    })
  })

  describe("GET /routes/:id", () => {
    test("answers the route with its pickups by position, its sessions and its unloads", async () => {
      const detail = await read(ex.routes.completed.id)
      assert.deepEqual(detail.pickups.map((stop) => [stop.position, stop.status, stop.reason]), [[1, "completed", null], [2, "failed", "not-presented"], [3, "skipped", "route-ended"]])
      assert.deepEqual(detail.pickups.map((stop) => stop.id), ex.routes.completed.pickupIds)
      assert.equal(detail.session, null, "the session ended with the route")
      assert.equal(detail.sessions.length, 1)
      assert.deepEqual([detail.sessions[0].id, detail.sessions[0].driverId, detail.sessions[0].vehicleId, detail.sessions[0].endedAt], [ex.routes.completed.sessionId, fleet.drivers.mads.id, fleet.vehicles.wh24.id, at(ex.day, "13:00").toISOString()])
      assert.deepEqual(detail.unloads, [])
      assert.deepEqual([detail.dispatchedAt, detail.startedAt, detail.completedAt, detail.cancelledAt], [at(ex.day, "05:30").toISOString(), at(ex.day, "06:00").toISOString(), at(ex.day, "13:00").toISOString(), null])
      assert.equal(detail.generationRunId, null, "#97 B's column is not here yet")

      const active = await fresh({ status: "active", ...mads(), paused: true })
      const running = await read(active.id)
      assert.equal(running.session?.id, active.sessionId, "the open session")
      assert.notEqual(running.session?.pausedAt, null)
      assert.deepEqual(running.actual, { driverId: fleet.drivers.mads.id, vehicleId: fleet.vehicles.wh24.id, trailerId: null })
    })

    test("answers 404 for another company's, for one in a project the caller does not work in, and for an id nobody minted", async () => {
      await refused(await olivia(`/routes/${theirs.routes.ready.id}`), 404)
      assert.equal((await read(theirs.routes.ready.id, other)).id, theirs.routes.ready.id, "still there for its own company")
      await refused(await viewer(`/routes/${harbors.id}`), 404)
      await refused(await lars(`/routes/${harbors.id}`), 404)
      await refused(await olivia(`/routes/${testId()}`), 404)
      assert.deepEqual((await refused(await olivia("/routes/not-a-uuid"), 400)).errors?.map((error) => error.path), ["id"])
      assert.match((await refused(await ungranted(`/routes/${harbors.id}`), 403)).detail ?? "", /view on route-studio\.routes/)
    })
  })

  describe("POST /routes/:id/assign", () => {
    test("moves the planned assignment, writes route-reassigned when the driver or the vehicle moved and not otherwise, and a null clears", async () => {
      const seeded = await fresh()
      await nextMillisecond()
      const assigned = await commanded(seeded.id, "assign", {
        driverId: fleet.drivers.mads.id,
        vehicleId: fleet.vehicles.wh24.id,
        trailerId: fleet.vehicles.trailer.id,
        depotId: fleet.depots.nordhavn.id,
        unloadingStationId: fleet.stations.amager.id,
      })
      assert.deepEqual(assigned.planned, {
        driverId: fleet.drivers.mads.id,
        vehicleId: fleet.vehicles.wh24.id,
        trailerId: fleet.vehicles.trailer.id,
        serviceProviderId: null,
        depotId: fleet.depots.nordhavn.id,
        unloadingStationId: fleet.stations.amager.id,
      })
      assert.equal(assigned.status, "planned", "a planned route stays planned")
      assert.deepEqual(assigned.actual, { driverId: null, vehicleId: null, trailerId: null }, "the actual assignment is the session's, not a form's")
      const [reassigned, ...more] = await eventsAbout(seeded.id)
      assert.equal(more.length, 0)
      assert.deepEqual([reassigned.kind, reassigned.aggregateKind, reassigned.projectId, reassigned.occurredAt.toISOString(), reassigned.publishedAt], ["route-reassigned", "route", seeded.projectId, NOON.toISOString(), null])
      assert.deepEqual(Route.parse(reassigned.payload), routeOf(assigned), "the payload is the route as answered")

      const towed = await commanded(seeded.id, "assign", { trailerId: null })
      assert.equal(towed.planned.trailerId, null)
      assert.equal((await eventsAbout(seeded.id)).length, 1, "a trailer moving is no reassignment")
      assert.deepEqual(await read(seeded.id), towed)

      const ready = await commanded(ex.routes.ready.id, "assign", { vehicleId: fleet.vehicles.wh25.id })
      assert.equal(ready.status, "ready", "a ready route stays ready")
      assert.equal((await eventsAbout(ex.routes.ready.id)).at(-1)?.kind, "route-reassigned")
      await commanded(ex.routes.ready.id, "assign", { vehicleId: fleet.vehicles.wh24.id })
    })

    test("holds what the body names to the route's project and its kind (400), the pair to the licence on the operating date (400), then what is named afresh to its status (409)", async () => {
      const seeded = await fresh()
      const asVehicle = await refused(await command(seeded.id, "assign", { vehicleId: fleet.vehicles.trailer.id }), 400)
      assert.deepEqual(asVehicle.errors, [{ path: "vehicleId", message: "Not a powered vehicle of this project" }])
      const elsewhere = await refused(await command(seeded.id, "assign", { vehicleId: fleet.vehicles.harborTruck.id }), 400)
      assert.deepEqual(elsewhere.errors, [{ path: "vehicleId", message: "Not a powered vehicle of this project" }], "Harbor Commercial's truck is not Copenhagen's")
      const asTrailer = await refused(await command(seeded.id, "assign", { trailerId: fleet.vehicles.wh25.id }), 400)
      assert.deepEqual(asTrailer.errors, [{ path: "trailerId", message: "Not a trailer of this project" }])
      const driver = await refused(await command(seeded.id, "assign", { driverId: fleet.drivers.henrik.id }), 400)
      assert.deepEqual(driver.errors, [{ path: "driverId", message: "Not a driver of this project" }])
      const depot = await refused(await command(seeded.id, "assign", { depotId: fleet.depots.harbor.id }), 400)
      assert.deepEqual(depot.errors, [{ path: "depotId", message: "Not a depot of this project" }])
      const station = await refused(await command(seeded.id, "assign", { unloadingStationId: testId() }), 400)
      assert.deepEqual(station.errors, [{ path: "unloadingStationId", message: "Not an unloading station of this company" }])

      // A station of the company that takes glass and nothing else: the route collects residual waste.
      const glassworks = testId()
      await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        await tx.insert(unloadingStation).values({ id: glassworks, companyId: a.companyId, code: "GLASS", name: "Glassworks", address: "Glasvej 1", location: TOWN_HALL, ownership: "external", status: "active" })
        await tx.insert(unloadingStationFraction).values({ id: testId(), companyId: a.companyId, unloadingStationId: glassworks, wasteFractionId: ex.fractions.glass.id })
      })
      const acceptsNone = await refused(await command(seeded.id, "assign", { unloadingStationId: glassworks }), 400)
      assert.deepEqual(acceptsNone.errors, [{ path: "unloadingStationId", message: "Glassworks accepts none of this route's waste fractions" }])
      const empty = await fresh({ pickups: [] })
      assert.equal((await commanded(empty.id, "assign", { unloadingStationId: glassworks })).planned.unloadingStationId, glassworks, "a route with no pickups yet collects nothing a station could refuse")

      const noClass = await refused(await command(seeded.id, "assign", { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.jonas.id }), 400)
      assert.deepEqual(noClass.errors, [{ path: "driverId", message: "Jonas Lind holds no licence class on record" }])
      const tooLow = await refused(await command(seeded.id, "assign", { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.freja.id }), 400)
      assert.deepEqual(tooLow.errors, [{ path: "driverId", message: "Freja Holm needs a C licence for WH-24" }])
      const expired = await refused(await command(seeded.id, "assign", { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.sofie.id }), 400)
      assert.deepEqual(expired.errors, [{ path: "driverId", message: `Sofie Nielsen's licence expires on ${SOFIE_LICENCE_EXPIRY}, before the operating date` }], "the operating date is a day already")
      await commanded(seeded.id, "assign", { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.mads.id })
      const swapped = await refused(await command(seeded.id, "assign", { vehicleId: fleet.vehicles.wh25.id, driverId: fleet.drivers.freja.id }), 400)
      assert.deepEqual(swapped.errors, [{ path: "driverId", message: "Freja Holm needs a CE licence for WH-25" }], "judged against the vehicle the route ends up with")
      const soloTruck = await refused(await command(seeded.id, "assign", { driverId: fleet.drivers.freja.id }), 400)
      assert.deepEqual(soloTruck.errors, [{ path: "driverId", message: "Freja Holm needs a C licence for WH-24" }], "a driver moving alone is judged against the stored vehicle")

      const retired = await refused(await command(seeded.id, "assign", { vehicleId: fleet.vehicles.retired.id }), 409)
      assert.equal(retired.detail, "WH-99 is retired; a route needs a vehicle in service")
      // A truck in the workshop today: an allocation for next month takes it (routes/statuses.ts), a route going out does not.
      const shop = testId()
      await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        const [{ vehicleTypeId }] = await tx.select({ vehicleTypeId: vehicle.vehicleTypeId }).from(vehicle).where(eq(vehicle.id, fleet.vehicles.wh24.id))
        await tx.insert(vehicle).values({ id: shop, companyId: a.companyId, projectId: a.projects.copenhagen.id, registration: "CN 42 555", callsign: "WH-55", kind: "powered-vehicle", vehicleTypeId, ownership: "company", status: "maintenance", requiredLicenceClass: "c" })
      })
      const inTheShop = await refused(await command(seeded.id, "assign", { vehicleId: shop }), 409)
      assert.equal(inTheShop.detail, "WH-55 is maintenance; a route needs a vehicle in service", "a route goes out with a vehicle in service: the rule its start holds")
      const retiredTrailer = await refused(await command(seeded.id, "assign", { trailerId: fleet.vehicles.retiredTrailer.id }), 409)
      assert.equal(retiredTrailer.detail, "WH-T99 is retired; a route needs a trailer in service")
      const inactive = await refused(await command(seeded.id, "assign", { driverId: fleet.drivers.karen.id }), 409)
      assert.equal(inactive.detail, "Karen Holt is inactive; a route needs an active driver", "the licence, which Karen holds, passes, and the status refuses")
      const suspended = await refused(await command(seeded.id, "assign", { driverId: fleet.drivers.peter.id }), 409)
      assert.equal(suspended.detail, "Peter Lund is suspended; a route needs an active driver")
      const elsewhereFirst = await refused(await command(seeded.id, "assign", { vehicleId: fleet.vehicles.retired.id, driverId: fleet.drivers.henrik.id }), 400)
      assert.deepEqual(elsewhereFirst.errors, [{ path: "driverId", message: "Not a driver of this project" }], "every 400 comes before the status 409")
      const nothing = await refused(await command(seeded.id, "assign", {}), 400)
      assert.deepEqual(nothing.errors?.map((error) => error.path), [""], "a body must move something")
      const member = await refused(await command(seeded.id, "assign", { status: "ready" }), 400)
      assert.ok(member.errors?.some((error) => /status/.test(error.message)), "the status moves through dispatch, never a form")
      assert.deepEqual((await read(seeded.id)).planned.vehicleId, fleet.vehicles.wh24.id, "no refused body wrote anything")
      assert.equal((await eventsAbout(seeded.id)).length, 1, "one reassignment went through")
    })

    test("keeps a ready route's driver: clearing it is refused (409), while moving it, and clearing a planned route's, are not", async () => {
      const kept = await refused(await command(ex.routes.ready.id, "assign", { driverId: null }), 409)
      assert.equal(kept.detail, `Route ${ex.routes.ready.label} is dispatched; assign another driver or cancel it`)
      assert.equal((await read(ex.routes.ready.id)).planned.driverId, fleet.drivers.mads.id, "the driver stands: a dispatched route without one would reach no device")
      assert.equal((await commanded(ex.routes.ready.id, "assign", { driverId: fleet.drivers.mads.id })).planned.driverId, fleet.drivers.mads.id, "moving the driver is not clearing it")
      const seeded = await fresh(mads())
      assert.equal((await commanded(seeded.id, "assign", { driverId: null })).planned.driverId, null, "a planned route may lose its driver; dispatch asks for one")
    })

    test("refuses a route that runs, one that has ended, one another company or project owns, and a role without edit", async () => {
      const active = await fresh({ status: "active" })
      const running = await refused(await command(active.id, "assign", { trailerId: fleet.vehicles.trailer.id }), 409)
      assert.equal(running.detail, `Route ${active.label} is active; the session's driver and vehicle are its actual assignment`)
      const done = await refused(await command(ex.routes.completed.id, "assign", { trailerId: fleet.vehicles.trailer.id }), 409)
      assert.equal(done.detail, `Route ${ex.routes.completed.label} is completed and does not change`)
      const cancelled = await fresh({ status: "cancelled" })
      const gone = await refused(await command(cancelled.id, "assign", { trailerId: fleet.vehicles.trailer.id }), 409)
      assert.equal(gone.detail, `Route ${cancelled.label} is cancelled and does not change`)
      await refused(await command(theirs.routes.planned.id, "assign", { driverId: fleet.drivers.mads.id }), 404)
      await refused(await command(harbors.id, "assign", { driverId: fleet.drivers.henrik.id }, viewer), 404)
      assert.match((await refused(await command(harbors.id, "assign", { driverId: fleet.drivers.henrik.id }, lars), 403)).detail ?? "", /edit on route-studio\.routes/, "the provider manager's charter grants route-studio view, not edit")
      assert.match((await refused(await command(harbors.id, "assign", { driverId: fleet.drivers.henrik.id }, ungranted), 403)).detail ?? "", /edit on route-studio\.routes/)
    })
  })

  describe("POST /routes/:id/dispatch", () => {
    test("needs a planned driver, moves planned to ready with the stamp and the event, and answers a ready route as it stands without a write", async () => {
      const seeded = await fresh()
      const nobody = await refused(await command(seeded.id, "dispatch"), 409)
      assert.equal(nobody.detail, `Route ${seeded.label} has no planned driver; assign one first`)
      assert.equal((await read(seeded.id)).status, "planned")
      await commanded(seeded.id, "assign", { driverId: fleet.drivers.mads.id, vehicleId: fleet.vehicles.wh24.id })
      await nextMillisecond()
      const dispatched = await commanded(seeded.id, "dispatch")
      assert.deepEqual([dispatched.status, dispatched.dispatchedAt], ["ready", NOON.toISOString()])
      const events = await eventsAbout(seeded.id)
      assert.deepEqual(events.map((event) => event.kind), ["route-reassigned", "route-dispatched"])
      assert.deepEqual(Route.parse(events[1].payload), routeOf(dispatched))
      assert.equal(events[1].occurredAt.toISOString(), NOON.toISOString(), "the command's instant")

      const again = await commanded(seeded.id, "dispatch")
      assert.deepEqual(again, dispatched, "idempotent: the same row, the same stamp")
      assert.equal((await eventsAbout(seeded.id)).length, 2, "and no second event")
    })

    test("refuses an active, a completed and a cancelled route in the machine's words", async () => {
      const active = await fresh({ status: "active" })
      assert.equal((await refused(await command(active.id, "dispatch"), 409)).detail, `Route ${active.label} is already active`)
      assert.equal((await refused(await command(ex.routes.completed.id, "dispatch"), 409)).detail, `Route ${ex.routes.completed.label} is completed and does not change`)
      const cancelled = await fresh({ status: "cancelled" })
      assert.equal((await refused(await command(cancelled.id, "dispatch"), 409)).detail, `Route ${cancelled.label} is cancelled and does not change`)
      await refused(await command(theirs.routes.planned.id, "dispatch"), 404)
      await refused(await command(harbors.id, "dispatch", undefined, viewer), 404)
      assert.match((await refused(await command(harbors.id, "dispatch", undefined, ungranted), 403)).detail ?? "", /edit on route-studio\.routes/)
    })
  })

  describe("POST /routes/:id/reschedule", () => {
    test("moves the operating date and the start and never the service date, judging the licence on the new day where both are planned", async () => {
      const seeded = await fresh({ ...mads() })
      const moved = await commanded(seeded.id, "reschedule", { operatingDate: "2026-10-06", plannedStartTime: "07:15" })
      assert.deepEqual([moved.operatingDate, moved.serviceDate, moved.plannedStartTime], ["2026-10-06", ex.day, "07:15"])
      const cleared = await commanded(seeded.id, "reschedule", { plannedStartTime: null })
      assert.deepEqual([cleared.operatingDate, cleared.plannedStartTime], ["2026-10-06", null])

      // Sofie's licence holds through 2026-09-05: a route she is planned for on the 1st may not move past it.
      const sofies = await fresh({ operatingDate: "2026-09-01", plannedDriverId: fleet.drivers.sofie.id, plannedVehicleId: fleet.vehicles.wh24.id })
      const past = await refused(await command(sofies.id, "reschedule", { operatingDate: "2026-09-10" }), 400)
      assert.deepEqual(past.errors, [{ path: "operatingDate", message: `Sofie Nielsen's licence expires on ${SOFIE_LICENCE_EXPIRY}, before the operating date` }])
      assert.equal((await commanded(sofies.id, "reschedule", { operatingDate: SOFIE_LICENCE_EXPIRY })).operatingDate, SOFIE_LICENCE_EXPIRY, "her last day holds")
      const nothing = await refused(await command(seeded.id, "reschedule", {}), 400)
      assert.deepEqual(nothing.errors?.map((error) => error.path), [""])
      const identity = await refused(await command(seeded.id, "reschedule", { serviceDate: "2026-10-06" }), 400)
      assert.ok(identity.errors?.some((error) => /serviceDate/.test(error.message)), "the service date is the identity and no body moves it")
      assert.equal((await eventsAbout(seeded.id)).length, 0, "a reschedule is nobody else's news")
    })

    test("refuses a route that runs or has ended", async () => {
      const active = await fresh({ status: "active" })
      assert.equal((await refused(await command(active.id, "reschedule", { operatingDate: "2026-10-06" }), 409)).detail, `Route ${active.label} is active; the day it runs is fixed`)
      assert.equal((await refused(await command(ex.routes.completed.id, "reschedule", { operatingDate: "2026-10-06" }), 409)).detail, `Route ${ex.routes.completed.label} is completed and does not change`)
      await refused(await command(harbors.id, "reschedule", { operatingDate: "2026-10-06" }, viewer), 404)
    })
  })

  describe("POST /routes/:id/cancel", () => {
    test("cancels a ready route with the reason as its note, closes every open pickup as skipped · route-cancelled, and writes one event per row it touched", async () => {
      const seeded = await fresh({ status: "ready", ...mads() })
      await nextMillisecond()
      const cancelled = await commanded(seeded.id, "cancel", { reason: "Snow: no collection today" })
      assert.deepEqual([cancelled.status, cancelled.note, cancelled.cancelledAt, cancelled.dispatchedAt], ["cancelled", "Snow: no collection today", NOON.toISOString(), at(ex.day, "05:30").toISOString()], "cancelling keeps what the route had done")
      assert.deepEqual(cancelled.pickups.map((stop) => [stop.status, stop.reason, stop.outcomeAt]), Array(3).fill(["skipped", "route-cancelled", NOON.toISOString()]))
      assert.deepEqual(cancelled.progress, { planned: 0, completed: 0, skipped: 3, failed: 0, total: 3, fraction: 1 })
      const events = await eventsAbout(seeded.id)
      assert.deepEqual(events.map((event) => event.kind), ["route-cancelled"])
      assert.deepEqual(Route.parse(events[0].payload), routeOf(cancelled))
      for (const stop of cancelled.pickups) {
        const [skipped, ...more] = await eventsAbout(stop.id)
        assert.equal(more.length, 0)
        assert.deepEqual([skipped.kind, skipped.aggregateKind, skipped.occurredAt.toISOString()], ["pickup-skipped", "pickup", NOON.toISOString()])
        assert.deepEqual(skipped.payload, stop, "the pickup as the cancellation left it")
      }
      const again = await commanded(seeded.id, "cancel", { reason: "Once more" })
      assert.deepEqual(again, cancelled, "idempotent, the first reason kept")
      assert.equal((await eventsAbout(seeded.id)).length, 1)
    })

    test("cancels an active route: ends its open session, closes the open pickups and leaves the decided ones as they are", async () => {
      const active = await fresh({
        status: "active",
        pickups: [
          { containerId: ex.containers.bin1.id, propertyId: ex.properties.parkvej.id, status: "completed", arrivedAt: at(ex.day, "06:40"), outcomeAt: at(ex.day, "06:45") },
          { containerId: ex.containers.bin2.id, propertyId: ex.properties.havnegade.id },
          { containerId: ex.containers.bin3.id, propertyId: ex.properties.norrebrogade.id },
        ],
      })
      const cancelled = await commanded(active.id, "cancel", { reason: "Truck broke down" })
      assert.deepEqual([cancelled.status, cancelled.startedAt, cancelled.completedAt], ["cancelled", at(ex.day, "06:00").toISOString(), null])
      assert.deepEqual(cancelled.pickups.map((stop) => [stop.status, stop.reason]), [["completed", null], ["skipped", "route-cancelled"], ["skipped", "route-cancelled"]])
      assert.equal(cancelled.session, null, "no open session any more")
      assert.deepEqual([cancelled.sessions[0].id, cancelled.sessions[0].endedAt], [active.sessionId, NOON.toISOString()])
      const [row] = await withCompany(pool.db, a.companyId, async (tx: Tx) => tx.select({ endedAt: session.endedAt }).from(session).where(eq(session.id, active.sessionId ?? "")))
      assert.equal(row.endedAt?.toISOString(), NOON.toISOString())
      assert.equal((await eventsAbout(cancelled.pickups[0].id)).length, 0, "a decided pickup was not touched and is nobody's news")
      assert.equal((await eventsAbout(cancelled.pickups[1].id)).length, 1)
    })

    test("refuses a completed route, a body without a reason, and a route out of reach", async () => {
      assert.equal((await refused(await command(ex.routes.completed.id, "cancel", { reason: "Too late" }), 409)).detail, `Route ${ex.routes.completed.label} is completed and does not change`)
      assert.deepEqual((await refused(await command(ex.routes.planned.id, "cancel", {}), 400)).errors?.map((error) => error.path), ["reason"])
      await refused(await command(theirs.routes.planned.id, "cancel", { reason: "Mine" }), 404)
      await refused(await command(harbors.id, "cancel", { reason: "Mine" }, viewer), 404)
      assert.match((await refused(await command(harbors.id, "cancel", { reason: "Mine" }, ungranted), 403)).detail ?? "", /edit on route-studio\.routes/)
      assert.equal((await read(ex.routes.planned.id)).status, "planned", "untouched")
    })
  })

  describe("PUT /routes/:id/pickup-order", () => {
    const put = (id: string, pickupIds: unknown, call = olivia) => call(`/routes/${id}/pickup-order`, { method: "PUT", body: { pickupIds } })

    test("rewrites positions 1..n in body order, moves the route's stamp, and leaves a decided pickup's position alone", async () => {
      const seeded = await fresh()
      const [first, second, third] = seeded.pickupIds
      const before = await read(seeded.id)
      await nextMillisecond()
      const response = await put(seeded.id, [third, first, second])
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
      const reordered = RouteDetail.parse(await response.json())
      assert.deepEqual(reordered.pickups.map((stop) => [stop.position, stop.id]), [[1, third], [2, first], [3, second]])
      assert.ok(reordered.updatedAt > before.updatedAt, "the order is part of the route on the wire")
      assert.ok(reordered.pickups.every((stop) => stop.updatedAt > before.pickups.find((was) => was.id === stop.id)!.updatedAt), "every stop was rewritten")
      assert.deepEqual(await read(seeded.id), reordered)

      // Remove the stop now at position 2 through its own command, then reorder the two that are open: the skipped one keeps its position.
      const removed = await olivia(`/pickups/${first}/remove`, { method: "POST", body: { reason: "Moved out" } })
      assert.equal(removed.status, 200, JSON.stringify(await removed.clone().json()))
      const rest = RouteDetail.parse(await (await put(seeded.id, [second, third])).json())
      const byId = new Map(rest.pickups.map((stop) => [stop.id, [stop.position, stop.status]] as const))
      assert.deepEqual([byId.get(second), byId.get(first), byId.get(third)], [[1, "planned"], [2, "skipped"], [2, "planned"]], "1..n over the open stops; the skipped one keeps the 2 it had")
    })

    test("refuses an order that is not exactly the route's open pickups, counting what is left out and what is a stranger", async () => {
      const seeded = await fresh()
      const [first, second, third] = seeded.pickupIds
      const short = await refused(await put(seeded.id, [first, second]), 400)
      assert.deepEqual(short.errors, [{ path: "pickupIds", message: "The order names every open pickup of the route once: 1 open pickup left out, 0 ids not an open pickup of this route" }])
      const stranger = await refused(await put(seeded.id, [first, second, third, ex.routes.planned.pickupIds[0]]), 400)
      assert.deepEqual(stranger.errors, [{ path: "pickupIds", message: "The order names every open pickup of the route once: 0 open pickups left out, 1 id not an open pickup of this route" }])
      const both = await refused(await put(seeded.id, [first, testId(), testId()]), 400)
      assert.deepEqual(both.errors, [{ path: "pickupIds", message: "The order names every open pickup of the route once: 2 open pickups left out, 2 ids not an open pickup of this route" }])
      const twice = await refused(await put(seeded.id, [first, first, second]), 400)
      assert.deepEqual(twice.errors?.map((error) => error.path), ["pickupIds"], "the contracts refuse a pickup named twice")
      assert.deepEqual((await refused(await put(seeded.id, []), 400)).errors?.map((error) => error.path), ["pickupIds"])
      assert.deepEqual((await read(seeded.id)).pickups.map((stop) => stop.position), [1, 2, 3], "nothing written")
    })

    test("refuses a route that runs or has ended, one out of reach, and a role without edit", async () => {
      const active = await fresh({ status: "active" })
      const [x, y, z] = active.pickupIds
      assert.equal((await refused(await put(active.id, [z, y, x]), 409)).detail, `Route ${active.label} is active; its order is frozen`)
      assert.equal((await refused(await put(ex.routes.completed.id, ex.routes.completed.pickupIds), 409)).detail, `Route ${ex.routes.completed.label} is completed and does not change`)
      await refused(await put(theirs.routes.planned.id, theirs.routes.planned.pickupIds), 404)
      await refused(await put(harbors.id, [testId()], viewer), 404)
      assert.match((await refused(await put(harbors.id, [testId()], ungranted), 403)).detail ?? "", /edit on route-studio\.routes/)
    })
  })

  describe("GET /routes/:id/commands", () => {
    test("is the route's receipts oldest first, the command as sent and what became of it, and empty for a route the device never spoke about", async () => {
      const receipts = async (id: string, query = "", call = olivia) => {
        const response = await call(`/routes/${id}/commands${query}`)
        assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
        return ReceiptPage.parse(await response.json())
      }
      assert.deepEqual(await receipts(ex.routes.planned.id), { items: [], nextCursor: null })
      // The receipts the driver door will write (slice 4), written here as `wms_api` the way it does: one applied, one rejected with its problem.
      // Two ids a millisecond apart, so the log's id order is the order they were received in.
      const minted = Date.now()
      const started = testId(minted)
      const rejected = testId(minted + 1)
      const problem = { type: "about:blank", title: "Conflict", status: 409, detail: `Route ${ex.routes.completed.label} is not active` }
      await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        const receipt = { companyId: a.companyId, projectId: ex.routes.completed.projectId, routeId: ex.routes.completed.id, driverId: fleet.drivers.mads.id, deviceId: "device-mads-1" }
        await tx.insert(driverCommand).values([
          { ...receipt, id: started, sessionId: ex.routes.completed.sessionId, kind: "start-route", occurredAt: at(ex.day, "06:00"), body: { vehicleId: fleet.vehicles.wh24.id }, outcome: "applied", problem: null },
          { ...receipt, id: rejected, sessionId: ex.routes.completed.sessionId, pickupId: ex.routes.completed.pickupIds[0], kind: "complete-pickup", occurredAt: at(ex.day, "13:30"), body: { pickupId: ex.routes.completed.pickupIds[0] }, outcome: "rejected", problem },
        ])
      })
      const { items, nextCursor } = await receipts(ex.routes.completed.id)
      assert.equal(nextCursor, null)
      assert.deepEqual(items.map((receipt) => [receipt.id, receipt.kind, receipt.outcome, receipt.problem]), [[started, "start-route", "applied", null], [rejected, "complete-pickup", "rejected", problem]])
      assert.deepEqual(items[0].body, { vehicleId: fleet.vehicles.wh24.id }, "verbatim")
      assert.deepEqual([items[1].pickupId, items[1].sessionId, items[1].driverId, items[1].deviceId, items[1].occurredAt], [ex.routes.completed.pickupIds[0], ex.routes.completed.sessionId, fleet.drivers.mads.id, "device-mads-1", at(ex.day, "13:30").toISOString()])
      const first = await receipts(ex.routes.completed.id, "?limit=1")
      assert.deepEqual(first.items.map((receipt) => receipt.id), [started])
      assert.ok(first.nextCursor !== null)
      assert.deepEqual((await receipts(ex.routes.completed.id, `?limit=1&cursor=${first.nextCursor}`)).items.map((receipt) => receipt.id), [rejected])
      await refused(await olivia(`/routes/${theirs.routes.completed.id}/commands`), 404)
      await refused(await viewer(`/routes/${harbors.id}/commands`), 404)
      assert.match((await refused(await ungranted(`/routes/${harbors.id}/commands`), 403)).detail ?? "", /view on route-studio\.routes/)
    })
  })
})
