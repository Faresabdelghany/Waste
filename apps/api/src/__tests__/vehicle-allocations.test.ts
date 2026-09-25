import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { BOTH_ENDS_OF_THE_WINDOW, OVERLAPPING_WINDOW_ORDERED, VehicleAllocation, VehicleAllocationEvent, WINDOW_ENDS_AFTER_IT_STARTS } from "@waste/contracts/allocations"
import { WasteFraction } from "@waste/contracts/catalogue"
import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { vehicleAllocation } from "@waste/db/schema/allocations"
import { driver, vehicle } from "@waste/db/schema/fleet"
import { withCompany } from "@waste/db/tenant"
import { and, eq } from "drizzle-orm"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { nextMillisecond } from "./clock"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, SOFIE_LICENCE_EXPIRY, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the allocation events this suite appends, which `wms_api` may not delete (#101 §6.24). */
const owner = ownerUnderTest()
const AllocationPage = Page(VehicleAllocation)
const EventPage = Page(VehicleAllocationEvent)

const MODULE = "fleet.vehicle-planning"

/** An instant on Copenhagen's clock in October 2026 (CEST, +02:00); every test takes a day of its own, so its windows meet nobody else's. */
const at = (day: string, time: string) => `${day}T${time}:00+02:00`
/** What the wire spells the same instant as: the server answers UTC. */
const utc = (instant: string) => new Date(instant).toISOString()

describe("the vehicle allocation endpoints", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  /** The company under test. */
  let a: Tenant
  /** The other company, written to once below and never again. */
  let b: Tenant
  let fleet: FleetFixtures
  let theirFleet: FleetFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted view, create and edit, with Project Access to Copenhagen Central only. */
  let viewer: Call
  /** The Service Provider Manager, whose charter grants fleet view and edit: a role that reaches no project of the company. */
  let lars: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call

  let residual: WasteFraction
  let theirFraction: WasteFraction
  /** The other company's allocation, and one of Harbor Commercial, which the viewer does not work in. */
  let theirs: VehicleAllocation
  let harbors: VehicleAllocation

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    theirFleet = await seedFleet(pool, b, await seedPlanning(pool, b))
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create", "edit"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)

    residual = await create(olivia, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    theirFraction = await create(other, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    theirs = await create(
      other,
      "/vehicle-allocations",
      { projectId: b.projects.copenhagen.id, vehicleId: theirFleet.vehicles.wh24.id, driverId: theirFleet.drivers.mads.id, plannedFrom: at("2026-10-01", "06:00"), plannedTo: at("2026-10-01", "14:00") },
      VehicleAllocation,
    )
    harbors = await create(
      olivia,
      "/vehicle-allocations",
      { projectId: a.projects.harbor.id, vehicleId: fleet.vehicles.harborTruck.id, driverId: fleet.drivers.henrik.id, plannedFrom: at("2026-10-01", "06:00"), plannedTo: at("2026-10-01", "14:00") },
      VehicleAllocation,
    )
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }

  const create = async <T>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> => {
    const response = await call(path, { method: "POST", body: values })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  /** A body on Copenhagen Central for WH-24 over the hours of a day, with whatever else the test says. */
  const body = (day: string, from: string, to: string, values: Record<string, unknown> = {}) => ({
    projectId: a.projects.copenhagen.id,
    vehicleId: fleet.vehicles.wh24.id,
    plannedFrom: at(day, from),
    plannedTo: at(day, to),
    ...values,
  })
  const allocate = (values: unknown) => create(olivia, "/vehicle-allocations", values, VehicleAllocation)
  const post = (values: unknown, call = olivia) => call("/vehicle-allocations", { method: "POST", body: values })
  const one = async (call: Call, id: string): Promise<VehicleAllocation> => {
    const response = await call(`/vehicle-allocations/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return VehicleAllocation.parse(await response.json())
  }
  const command = (id: string, action: "change" | "confirm" | "release", values: unknown, call = olivia) =>
    call(`/vehicle-allocations/${id}/${action}`, { method: "POST", body: values })
  const commanded = async (id: string, action: "change" | "confirm" | "release", values: unknown): Promise<VehicleAllocation> => {
    const response = await command(id, action, values)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return VehicleAllocation.parse(await response.json())
  }
  const events = async (id: string, query = "?limit=200", call = olivia) => {
    const response = await call(`/vehicle-allocations/${id}/events${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return EventPage.parse(await response.json())
  }
  const page = async (call: Call, query = "") => AllocationPage.parse(await (await call(`/vehicle-allocations${query}`)).json())
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  /** The snapshot an event carries, as the allocation it was taken from spells it. */
  const snapshotOf = (allocation: VehicleAllocation) => ({
    vehicleId: allocation.vehicleId,
    driverId: allocation.driverId,
    trailerId: allocation.trailerId,
    depotId: allocation.depotId,
    plannedFrom: allocation.plannedFrom,
    plannedTo: allocation.plannedTo,
  })
  const snapshotOfEvent = (event: VehicleAllocationEvent) => ({
    vehicleId: event.vehicleId,
    driverId: event.driverId,
    trailerId: event.trailerId,
    depotId: event.depotId,
    plannedFrom: event.plannedFrom,
    plannedTo: event.plannedTo,
  })

  describe("POST /vehicle-allocations", () => {
    test("allocates a vehicle with its driver, trailer, depot and fraction over a window, appends the allocate event with the snapshot, and reads it back", async () => {
      const created = await allocate(
        body("2026-10-05", "06:00", "14:00", {
          driverId: fleet.drivers.mads.id,
          trailerId: fleet.vehicles.trailer.id,
          depotId: fleet.depots.nordhavn.id,
          wasteFractionId: residual.id,
          requiredCapacityKg: 9000,
          note: "Residual, north",
        }),
      )
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.equal(created.projectId, a.projects.copenhagen.id)
      assert.deepEqual(
        [created.vehicleId, created.driverId, created.trailerId, created.depotId, created.wasteFractionId, created.requiredCapacityKg, created.note],
        [fleet.vehicles.wh24.id, fleet.drivers.mads.id, fleet.vehicles.trailer.id, fleet.depots.nordhavn.id, residual.id, 9000, "Residual, north"],
      )
      assert.deepEqual([created.plannedFrom, created.plannedTo], [utc(at("2026-10-05", "06:00")), utc(at("2026-10-05", "14:00"))], "instants, answered in UTC")
      assert.equal(created.status, "planned", "the default")
      assert.deepEqual(await one(olivia, created.id), created)

      const { items, nextCursor } = await events(created.id)
      assert.equal(nextCursor, null)
      assert.equal(items.length, 1)
      const [allocated] = items
      assert.deepEqual([allocated.action, allocated.status, allocated.reason, allocated.recordedBy, allocated.vehicleAllocationId, allocated.projectId], ["allocate", "planned", null, a.users.olivia.id, created.id, created.projectId])
      assert.deepEqual(snapshotOfEvent(allocated), snapshotOf(created), "the snapshot after the action")
      assert.equal(Id.parse(allocated.id), allocated.id)

      const confirmed = await allocate(body("2026-10-05", "14:00", "18:00", { status: "confirmed" }))
      assert.equal(confirmed.status, "confirmed", "a body may confirm straight away")
      assert.deepEqual([confirmed.driverId, confirmed.trailerId, confirmed.depotId, confirmed.wasteFractionId, confirmed.requiredCapacityKg, confirmed.note], [null, null, null, null, null, null])
      const released = await refused(await post(body("2026-10-05", "18:00", "20:00", { status: "released" })), 400)
      assert.deepEqual(released.errors?.map((error) => error.path), ["status"], "released is a command, not a status a body may ask for")
    })

    test("holds the vehicle to a powered vehicle of the project, the trailer to a trailer, the driver to one of the project's, and the rest to its scope (400), then what is named afresh to its status (409)", async () => {
      const day = "2026-10-06"
      const asVehicle = await refused(await post(body(day, "06:00", "10:00", { vehicleId: fleet.vehicles.trailer.id })), 400)
      assert.deepEqual(asVehicle.errors, [{ path: "vehicleId", message: "Not a powered vehicle of this project" }])
      const elsewhere = await refused(await post(body(day, "06:00", "10:00", { vehicleId: fleet.vehicles.harborTruck.id })), 400)
      assert.deepEqual(elsewhere.errors, [{ path: "vehicleId", message: "Not a powered vehicle of this project" }], "Harbor Commercial's truck is not Copenhagen's")
      const theirsToo = await refused(await post(body(day, "06:00", "10:00", { vehicleId: theirFleet.vehicles.wh24.id })), 400)
      assert.deepEqual(theirsToo.errors, [{ path: "vehicleId", message: "Not a powered vehicle of this project" }])
      const retired = await refused(await post(body(day, "06:00", "10:00", { vehicleId: fleet.vehicles.retired.id })), 409)
      assert.equal(retired.detail, "WH-99 is retired; an allocation needs a vehicle in service", "the row is there and its status refuses: a 409 naming it, not the 400 a missing id earns")
      const retiredTrailer = await refused(await post(body(day, "06:00", "10:00", { trailerId: fleet.vehicles.retiredTrailer.id })), 409)
      assert.equal(retiredTrailer.detail, "WH-T99 is retired; an allocation needs a trailer in service", "a retired trailer is refused like a retired vehicle")
      const inactive = await refused(await post(body(day, "06:00", "10:00", { driverId: fleet.drivers.karen.id })), 409)
      assert.equal(inactive.detail, "Karen Holt is inactive; an allocation needs an active driver", "the licence, which Karen holds, passes, and the status refuses")
      const suspended = await refused(await post(body(day, "06:00", "10:00", { driverId: fleet.drivers.peter.id })), 409)
      assert.equal(suspended.detail, "Peter Lund is suspended; an allocation needs an active driver")
      const elsewhereFirst = await refused(await post(body(day, "06:00", "10:00", { vehicleId: fleet.vehicles.retired.id, driverId: fleet.drivers.henrik.id })), 400)
      assert.deepEqual(elsewhereFirst.errors, [{ path: "driverId", message: "Not a driver of this project" }], "every 400 comes before the status 409: a driver who is not here is told first, retired vehicle or not")
      const asTrailer = await refused(await post(body(day, "06:00", "10:00", { trailerId: fleet.vehicles.wh25.id })), 400)
      assert.deepEqual(asTrailer.errors, [{ path: "trailerId", message: "Not a trailer of this project" }])
      const noTrailer = await refused(await post(body(day, "06:00", "10:00", { trailerId: testId() })), 400)
      assert.deepEqual(noTrailer.errors, [{ path: "trailerId", message: "Not a trailer of this project" }])
      const driver = await refused(await post(body(day, "06:00", "10:00", { driverId: fleet.drivers.henrik.id })), 400)
      assert.deepEqual(driver.errors, [{ path: "driverId", message: "Not a driver of this project" }])
      const depot = await refused(await post(body(day, "06:00", "10:00", { depotId: fleet.depots.harbor.id })), 400)
      assert.deepEqual(depot.errors, [{ path: "depotId", message: "Not a depot of this project" }])
      const fraction = await refused(await post(body(day, "06:00", "10:00", { wasteFractionId: theirFraction.id })), 400)
      assert.deepEqual(fraction.errors, [{ path: "wasteFractionId", message: "Not a waste fraction of this company" }])
      const project = await refused(await post(body(day, "06:00", "10:00", { projectId: b.projects.copenhagen.id })), 400)
      assert.deepEqual(project.errors, [{ path: "projectId", message: "Not a project this account works in" }])
      const harbor = await refused(await post(body(day, "06:00", "10:00", { projectId: a.projects.harbor.id, vehicleId: fleet.vehicles.harborTruck.id }), viewer), 400)
      assert.deepEqual(harbor.errors, [{ path: "projectId", message: "Not a project this account works in" }], "the viewer works in Copenhagen only")
      const backwards = await refused(await post(body(day, "10:00", "06:00")), 400)
      assert.deepEqual(backwards.errors, [{ path: "plannedTo", message: WINDOW_ENDS_AFTER_IT_STARTS }])
      assert.equal((await page(olivia, `?vehicleId=${fleet.vehicles.wh24.id}&overlappingFrom=${encodeURIComponent(at(day, "00:00"))}&overlappingTo=${encodeURIComponent(at(day, "23:59"))}`)).items.length, 0, "nothing written")
    })

    test("refuses a driver who may not take the vehicle on the window's last day, in the licence rule's words", async () => {
      const day = "2026-10-07"
      const noClass = await refused(await post(body(day, "06:00", "10:00", { driverId: fleet.drivers.jonas.id })), 400)
      assert.deepEqual(noClass.errors, [{ path: "driverId", message: "Jonas Lind holds no licence class on record" }])
      const tooLow = await refused(await post(body(day, "06:00", "10:00", { driverId: fleet.drivers.freja.id })), 400)
      assert.deepEqual(tooLow.errors, [{ path: "driverId", message: "Freja Holm needs a C licence for WH-24" }])
      const expired = await refused(await post(body(day, "06:00", "10:00", { driverId: fleet.drivers.sofie.id })), 400)
      assert.deepEqual(expired.errors, [{ path: "driverId", message: `Sofie Nielsen's licence expires on ${SOFIE_LICENCE_EXPIRY}, before the window ends` }])
      const ce = await allocate(body(day, "06:00", "10:00", { vehicleId: fleet.vehicles.wh25.id, driverId: fleet.drivers.mads.id }))
      assert.equal(ce.driverId, fleet.drivers.mads.id, "CE takes a CE truck")
      const higher = await allocate(body(day, "10:00", "14:00", { driverId: fleet.drivers.mads.id }))
      assert.equal(higher.driverId, fleet.drivers.mads.id, "CE covers C")
    })

    test("judges the licence on the window's last day in the project's timezone: a window ending at midnight in Copenhagen is judged on the day before, one reaching past it on the day after", async () => {
      // Sofie's licence holds through 2026-09-05. Every window here ends on the 5th in UTC; in Copenhagen (CEST, +02:00) 22:00Z is midnight, the first instant of the 6th.
      const sofieUntil = (plannedFrom: string, plannedTo: string) => ({
        projectId: a.projects.copenhagen.id,
        vehicleId: fleet.vehicles.wh24.id,
        driverId: fleet.drivers.sofie.id,
        plannedFrom: `${SOFIE_LICENCE_EXPIRY}T${plannedFrom}Z`,
        plannedTo: `${SOFIE_LICENCE_EXPIRY}T${plannedTo}Z`,
      })
      const expired = [{ path: "driverId", message: `Sofie Nielsen's licence expires on ${SOFIE_LICENCE_EXPIRY}, before the window ends` }]
      const holds = await allocate(sofieUntil("20:00:00", "21:30:00"))
      assert.equal(holds.driverId, fleet.drivers.sofie.id, "ends 23:30 on the 5th, on the project's clock")
      const midnight = await allocate(sofieUntil("21:30:00", "22:00:00"))
      assert.equal(midnight.driverId, fleet.drivers.sofie.id, "ends at midnight: the window is half-open, so its last instant is 23:59:59.999 on the 5th and the licence holds")
      const pastMidnight = await refused(await post(sofieUntil("22:00:00", "22:00:01")), 400)
      assert.deepEqual(pastMidnight.errors, expired, "one second past midnight, the window reaches into the 6th")
      const ranOut = await refused(await post(sofieUntil("22:00:00", "22:30:00")), 400)
      assert.deepEqual(ranOut.errors, expired, "00:30 on the 6th in Copenhagen, though still the 5th in UTC")
    })

    test("refuses a window touching another live allocation's, saying whose, and takes one starting when the other ends or once it is released", async () => {
      const day = "2026-10-08"
      const first = await allocate(body(day, "06:00", "10:00", { driverId: fleet.drivers.mads.id, trailerId: fleet.vehicles.trailer.id }))
      const vehicle = await refused(await post(body(day, "08:00", "12:00")), 409)
      assert.equal(vehicle.detail, "WH-24 is already allocated over part of that window")
      assert.doesNotMatch(vehicle.detail ?? "", /no_overlap/)
      const driver = await refused(await post(body(day, "08:00", "12:00", { vehicleId: fleet.vehicles.wh25.id, driverId: fleet.drivers.mads.id })), 409)
      assert.equal(driver.detail, "Mads Jensen is already allocated over part of that window")
      const trailer = await refused(await post(body(day, "08:00", "12:00", { vehicleId: fleet.vehicles.wh25.id, trailerId: fleet.vehicles.trailer.id })), 409)
      assert.equal(trailer.detail, "WH-T12 is already allocated over part of that window")
      const adjacent = await allocate(body(day, "10:00", "14:00", { driverId: fleet.drivers.mads.id, trailerId: fleet.vehicles.trailer.id }))
      assert.equal(adjacent.plannedFrom, first.plannedTo, "half-open windows: one may start the instant the other ends")

      await commanded(first.id, "release", { reason: "Truck to the workshop" })
      const again = await allocate(body(day, "06:00", "10:00", { driverId: fleet.drivers.mads.id, trailerId: fleet.vehicles.trailer.id }))
      assert.notEqual(again.id, first.id, "a released allocation reserves nothing, so the window is free")
    })

    test("refuses a trailer standing as another live allocation's vehicle over the window: the one case the kinds cannot see", async () => {
      // The API never writes a trailer into `vehicle_id`; a row an import wrote can carry one, and the database's kind is the API's rule.
      const day = "2026-10-09"
      const odd = testId()
      await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        await tx.insert(vehicleAllocation).values({
          id: odd,
          companyId: a.companyId,
          projectId: a.projects.copenhagen.id,
          vehicleId: fleet.vehicles.trailer.id,
          plannedFrom: new Date(at(day, "06:00")),
          plannedTo: new Date(at(day, "10:00")),
          status: "planned",
        })
      })
      const clash = await refused(await post(body(day, "08:00", "12:00", { trailerId: fleet.vehicles.trailer.id })), 400)
      assert.deepEqual(clash.errors, [{ path: "trailerId", message: "WH-T12 is the vehicle of another allocation over part of that window" }])
      const later = await allocate(body(day, "10:00", "14:00", { trailerId: fleet.vehicles.trailer.id }))
      assert.equal(later.trailerId, fleet.vehicles.trailer.id, "free once the odd row's window has ended")
      await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        await tx.update(vehicleAllocation).set({ status: "released" }).where(eq(vehicleAllocation.id, odd))
      })
      const released = await allocate(body(day, "06:00", "08:00", { trailerId: fleet.vehicles.trailer.id }))
      assert.equal(released.trailerId, fleet.vehicles.trailer.id, "a released row reserves nothing, on this side either")
    })

    test("answers 403 for a role that may not create, and 401 without a token", async () => {
      assert.match((await refused(await post(body("2026-10-10", "06:00", "10:00"), ungranted), 403)).detail ?? "", /create on fleet\.vehicle-planning/)
      assert.match((await refused(await post(body("2026-10-10", "06:00", "10:00"), lars), 403)).detail ?? "", /create on fleet\.vehicle-planning/, "the provider manager's charter grants fleet view and edit, not create")
      assert.equal((await app.request("/vehicle-allocations", { method: "POST", body: JSON.stringify(body("2026-10-10", "06:00", "10:00")), headers: { "content-type": "application/json" } })).status, 401)
    })
  })

  describe("GET /vehicle-allocations", () => {
    test("lists the caller's projects' allocations in id order, filters them, and answers exactly the windows that touch", async () => {
      const day = "2026-10-11"
      const morning = await allocate(body(day, "06:00", "10:00"))
      const midday = await allocate(body(day, "10:00", "14:00", { driverId: fleet.drivers.mads.id }))
      const afternoon = await allocate(body(day, "14:00", "18:00", { trailerId: fleet.vehicles.trailer.id }))
      const window = (from: string, to: string) => `&overlappingFrom=${encodeURIComponent(at(day, from))}&overlappingTo=${encodeURIComponent(at(day, to))}`
      const ids = async (query: string) => (await page(olivia, `?limit=200${query}`)).items.map((row) => row.id)

      assert.deepEqual(await ids(window("06:00", "18:00")), [morning.id, midday.id, afternoon.id], "in id order, the order they were made in")
      assert.deepEqual(await ids(window("09:00", "10:00")), [morning.id], "a window ending when the next starts does not touch it")
      assert.deepEqual(await ids(window("10:00", "10:01")), [midday.id], "a window starting when the first ends does not touch it")
      assert.deepEqual(await ids(window("09:59", "10:01")), [morning.id, midday.id])
      assert.deepEqual(await ids(window("18:00", "20:00")), [])
      assert.deepEqual(await ids(`${window("06:00", "18:00")}&driverId=${fleet.drivers.mads.id}`), [midday.id])
      assert.deepEqual(await ids(`${window("06:00", "18:00")}&trailerId=${fleet.vehicles.trailer.id}`), [afternoon.id])
      assert.deepEqual(await ids(`${window("06:00", "18:00")}&vehicleId=${fleet.vehicles.wh25.id}`), [])
      assert.deepEqual(await ids(`${window("06:00", "18:00")}&status=planned`), [morning.id, midday.id, afternoon.id])
      assert.deepEqual(await ids(`${window("06:00", "18:00")}&status=released`), [])
      assert.deepEqual(await ids(`${window("06:00", "18:00")}&projectId=${a.projects.copenhagen.id}`), [morning.id, midday.id, afternoon.id])
      assert.deepEqual(await ids(`${window("06:00", "18:00")}&projectId=${a.projects.harbor.id}`), [])

      const first = await page(olivia, `?limit=1${window("06:00", "18:00")}`)
      assert.deepEqual(first.items.map((row) => row.id), [morning.id])
      assert.ok(first.nextCursor !== null)
      assert.deepEqual((await page(olivia, `?limit=2&cursor=${first.nextCursor}${window("06:00", "18:00")}`)).items.map((row) => row.id), [midday.id, afternoon.id])

      const everything = await page(olivia, "?limit=200")
      assert.ok(everything.items.some((row) => row.id === harbors.id), "Olivia works in every project")
      assert.ok(!everything.items.some((row) => row.id === theirs.id), "and sees no other company's")
      const copenhagenOnly = await page(viewer, "?limit=200")
      assert.ok(copenhagenOnly.items.some((row) => row.id === morning.id))
      assert.ok(!copenhagenOnly.items.some((row) => row.id === harbors.id), "the viewer works in Copenhagen only")
      assert.deepEqual(await page(lars, "?limit=200"), { items: [], nextCursor: null }, "an account that works in no project reads an empty page")
    })

    test("refuses one end of the overlapping window without the other, a backwards one, a project out of reach, and a role without view", async () => {
      const oneEnd = await refused(await olivia(`/vehicle-allocations?overlappingFrom=${encodeURIComponent(at("2026-10-11", "06:00"))}`), 400)
      assert.deepEqual(oneEnd.errors, [{ path: "overlappingTo", message: BOTH_ENDS_OF_THE_WINDOW }])
      const backwards = await refused(await olivia(`/vehicle-allocations?overlappingFrom=${encodeURIComponent(at("2026-10-11", "10:00"))}&overlappingTo=${encodeURIComponent(at("2026-10-11", "06:00"))}`), 400)
      assert.deepEqual(backwards.errors, [{ path: "overlappingTo", message: OVERLAPPING_WINDOW_ORDERED }])
      const project = await refused(await viewer(`/vehicle-allocations?projectId=${a.projects.harbor.id}`), 400)
      assert.deepEqual(project.errors, [{ path: "projectId", message: "Not a project this account works in" }])
      assert.deepEqual((await refused(await olivia("/vehicle-allocations?cursor=nope"), 400)).errors?.map((error) => error.path), ["cursor"])
      assert.match((await refused(await ungranted("/vehicle-allocations"), 403)).detail ?? "", /view on fleet\.vehicle-planning/)
    })
  })

  describe("GET /vehicle-allocations/:id", () => {
    test("answers 404 for another company's, for one in a project the caller does not work in, and for an id nobody minted", async () => {
      await refused(await olivia(`/vehicle-allocations/${theirs.id}`), 404)
      assert.equal((await one(other, theirs.id)).id, theirs.id, "still there for its own company")
      await refused(await viewer(`/vehicle-allocations/${harbors.id}`), 404)
      assert.equal((await one(olivia, harbors.id)).id, harbors.id)
      await refused(await lars(`/vehicle-allocations/${harbors.id}`), 404)
      await refused(await olivia(`/vehicle-allocations/${testId()}`), 404)
      assert.deepEqual((await refused(await olivia("/vehicle-allocations/not-a-uuid"), 400)).errors?.map((error) => error.path), ["id"])
      assert.equal((await app.request(`/vehicle-allocations/${testId()}`)).status, 401)
      assert.match((await refused(await ungranted(`/vehicle-allocations/${harbors.id}`), 403)).detail ?? "", /view on fleet\.vehicle-planning/)
    })
  })

  describe("POST /vehicle-allocations/:id/change", () => {
    test("moves the window, the driver, the trailer and the depot with a reason, appends the change event, and leaves the status alone", async () => {
      const day = "2026-10-12"
      const created = await allocate(body(day, "06:00", "10:00", { driverId: fleet.drivers.mads.id, status: "confirmed" }))
      await nextMillisecond()
      const changed = await commanded(created.id, "change", {
        plannedTo: at(day, "12:00"),
        trailerId: fleet.vehicles.trailer.id,
        depotId: fleet.depots.nordhavn.id,
        wasteFractionId: residual.id,
        requiredCapacityKg: 7500,
        note: "Longer run",
        reason: "Two more streets",
      })
      assert.deepEqual(
        [changed.plannedFrom, changed.plannedTo, changed.driverId, changed.trailerId, changed.depotId, changed.wasteFractionId, changed.requiredCapacityKg, changed.note, changed.status],
        [created.plannedFrom, utc(at(day, "12:00")), fleet.drivers.mads.id, fleet.vehicles.trailer.id, fleet.depots.nordhavn.id, residual.id, 7500, "Longer run", "confirmed"],
        "what the body did not name it did not touch, and the status does not move",
      )
      assert.ok(changed.updatedAt > created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), changed)
      const { items } = await events(created.id)
      assert.deepEqual(items.map((event) => [event.action, event.status, event.reason]), [["allocate", "confirmed", null], ["change", "confirmed", "Two more streets"]])
      assert.deepEqual(snapshotOfEvent(items[1]), snapshotOf(changed), "the snapshot after the change")
      assert.deepEqual(snapshotOfEvent(items[0]), snapshotOf(created), "the earlier event is what it was")

      const cleared = await commanded(created.id, "change", { driverId: null, trailerId: null, reason: "Driver off sick" })
      assert.deepEqual([cleared.driverId, cleared.trailerId, cleared.depotId], [null, null, fleet.depots.nordhavn.id], "a null clears, an absent field keeps")
    })

    test("holds the row the change leaves behind to every rule of the create, naming the field", async () => {
      const day = "2026-10-13"
      const created = await allocate(body(day, "06:00", "10:00", { driverId: fleet.drivers.mads.id }))
      const noClass = await refused(await command(created.id, "change", { driverId: fleet.drivers.jonas.id, reason: "Swap" }), 400)
      assert.deepEqual(noClass.errors, [{ path: "driverId", message: "Jonas Lind holds no licence class on record" }])
      const tooLow = await refused(await command(created.id, "change", { driverId: fleet.drivers.freja.id, reason: "Swap" }), 400)
      assert.deepEqual(tooLow.errors, [{ path: "driverId", message: "Freja Holm needs a C licence for WH-24" }])
      const bigger = await commanded(created.id, "change", { vehicleId: fleet.vehicles.wh25.id, reason: "Bigger truck" })
      assert.equal(bigger.vehicleId, fleet.vehicles.wh25.id, "Mads holds CE, so the CE truck is fine: the licence is judged against the new vehicle")
      const back = await commanded(created.id, "change", { vehicleId: fleet.vehicles.wh24.id, reason: "Smaller truck after all" })
      assert.equal(back.vehicleId, fleet.vehicles.wh24.id)
      const expires = await refused(await command(created.id, "change", { driverId: fleet.drivers.sofie.id, reason: "Swap" }), 400)
      assert.deepEqual(expires.errors, [{ path: "driverId", message: `Sofie Nielsen's licence expires on ${SOFIE_LICENCE_EXPIRY}, before the window ends` }], "the licence is judged against the new end, the stored one here")
      const backwards = await refused(await command(created.id, "change", { plannedTo: at(day, "05:00"), reason: "Earlier" }), 400)
      assert.deepEqual(backwards.errors, [{ path: "plannedTo", message: WINDOW_ENDS_AFTER_IT_STARTS }], "the body gave one bound; the merged pair is held in the contracts' words")
      const asVehicle = await refused(await command(created.id, "change", { vehicleId: fleet.vehicles.trailer.id, reason: "Oops" }), 400)
      assert.deepEqual(asVehicle.errors, [{ path: "vehicleId", message: "Not a powered vehicle of this project" }])
      const depot = await refused(await command(created.id, "change", { depotId: fleet.depots.harbor.id, reason: "Oops" }), 400)
      assert.deepEqual(depot.errors, [{ path: "depotId", message: "Not a depot of this project" }])
      const nothing = await refused(await command(created.id, "change", { reason: "Nothing" }), 400)
      assert.deepEqual(nothing.errors?.map((error) => error.path), [""], "a reason alone changes nothing")
      const noReason = await refused(await command(created.id, "change", { note: "x" }), 400)
      assert.deepEqual(noReason.errors?.map((error) => error.path), ["reason"])
      const status = await refused(await command(created.id, "change", { status: "confirmed", reason: "Confirm" }), 400)
      assert.ok(status.errors?.some((error) => /status/.test(error.message)), "the status moves through confirm and release, never a change")
      assert.equal((await one(olivia, created.id)).driverId, fleet.drivers.mads.id, "a refused change writes nothing")
      assert.deepEqual((await events(created.id)).items.map((event) => event.action), ["allocate", "change", "change"], "the two changes that went through appended an event each; no refused one did")
    })

    test("holds only what the body moved: a stored vehicle or driver is not asked its status, a new one is, and the licence is judged again only when the driver, the vehicle or the window moved", async () => {
      const day = "2026-10-19"
      // A driver of this test's own, so drifting the licence touches nobody else's fixture.
      const worn = { id: testId(), name: "Worn Licence" }
      await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        await tx.insert(driver).values({ id: worn.id, companyId: a.companyId, projectId: a.projects.copenhagen.id, name: worn.name, employment: "employee", licenceClass: "ce", licenceExpiry: "2030-12-31", status: "active" })
      })
      const created = await allocate(body(day, "06:00", "10:00", { vehicleId: fleet.vehicles.drifting.id, driverId: worn.id, trailerId: fleet.vehicles.trailer.id }))
      // The row drifts under the allocation — the vehicle retires, the licence runs out — as the fleet routes would refuse under a live allocation and an import or a correction would not.
      await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        await tx.update(vehicle).set({ status: "retired" }).where(and(eq(vehicle.companyId, a.companyId), eq(vehicle.id, fleet.vehicles.drifting.id)))
        await tx.update(driver).set({ licenceExpiry: "2026-01-01" }).where(and(eq(driver.companyId, a.companyId), eq(driver.id, worn.id)))
      })
      const wornOut = [{ path: "driverId", message: `${worn.name}'s licence expires on 2026-01-01, before the window ends` }]

      const noted = await commanded(created.id, "change", { note: "Still going", reason: "A note" })
      assert.deepEqual([noted.note, noted.vehicleId, noted.driverId], ["Still going", fleet.vehicles.drifting.id, worn.id], "a note-only change asks nothing of the retired vehicle or the worn licence")
      const based = await commanded(created.id, "change", { depotId: fleet.depots.nordhavn.id, reason: "From Nordhavn" })
      assert.equal(based.depotId, fleet.depots.nordhavn.id, "nor does a depot")
      const longer = await refused(await command(created.id, "change", { plannedTo: at(day, "12:00"), reason: "Longer" }), 400)
      assert.deepEqual(longer.errors, wornOut, "moving the window judges the stored driver's licence again, on the new last day")
      const otherTruck = await refused(await command(created.id, "change", { vehicleId: fleet.vehicles.wh25.id, reason: "Swap" }), 400)
      assert.deepEqual(otherTruck.errors, wornOut, "moving the vehicle judges the stored driver against it")
      const backToRetired = await refused(await command(created.id, "change", { vehicleId: fleet.vehicles.retired.id, driverId: fleet.drivers.mads.id, reason: "Back" }), 409)
      assert.equal(backToRetired.detail, "WH-99 is retired; an allocation needs a vehicle in service", "named afresh, a retired vehicle is refused, a 409 naming its status")
      const retiredTrailer = await refused(await command(created.id, "change", { trailerId: fleet.vehicles.retiredTrailer.id, reason: "Tow" }), 409)
      assert.equal(retiredTrailer.detail, "WH-T99 is retired; an allocation needs a trailer in service")
      const inactive = await refused(await command(created.id, "change", { driverId: fleet.drivers.karen.id, reason: "Swap" }), 409)
      assert.equal(inactive.detail, "Karen Holt is inactive; an allocation needs an active driver")
      const swapped = await commanded(created.id, "change", { vehicleId: fleet.vehicles.wh25.id, driverId: fleet.drivers.mads.id, reason: "New crew" })
      assert.deepEqual([swapped.vehicleId, swapped.driverId, swapped.trailerId], [fleet.vehicles.wh25.id, fleet.drivers.mads.id, fleet.vehicles.trailer.id], "a new vehicle and a new driver are held and taken; the stored trailer is not asked")
      const solo = await commanded(created.id, "change", { driverId: null, reason: "Solo" })
      assert.equal(solo.driverId, null, "a driver cleared is judged on nothing")
      assert.deepEqual((await events(created.id)).items.map((event) => event.action), ["allocate", "change", "change", "change", "change"], "the four changes that went through appended an event each; no refused one did")
    })

    test("refuses a new window touching another live allocation's, and any change to a released allocation", async () => {
      const day = "2026-10-14"
      const first = await allocate(body(day, "06:00", "10:00"))
      const second = await allocate(body(day, "10:00", "14:00"))
      const overlap = await refused(await command(second.id, "change", { plannedFrom: at(day, "09:00"), reason: "Earlier start" }), 409)
      assert.equal(overlap.detail, "WH-24 is already allocated over part of that window")
      assert.equal((await one(olivia, second.id)).plannedFrom, second.plannedFrom, "nothing written")
      const moved = await commanded(second.id, "change", { plannedFrom: at(day, "11:00"), reason: "Later start" })
      assert.equal(moved.plannedFrom, utc(at(day, "11:00")), "a window that stays clear of the other is taken")

      await commanded(first.id, "release", { reason: "Cancelled" })
      const released = await refused(await command(first.id, "change", { plannedTo: at(day, "12:00"), reason: "Longer" }), 409)
      assert.equal(released.detail, "Released allocations do not change; allocate anew")
      const confirm = await refused(await command(first.id, "confirm", {}), 409)
      assert.equal(confirm.detail, "Released allocations do not change; allocate anew")
      assert.deepEqual((await events(first.id)).items.map((event) => event.action), ["allocate", "release"], "neither refusal appended an event")
    })

    test("answers 404 outside the caller's scope, and 403 for a role without edit", async () => {
      await refused(await command(theirs.id, "change", { note: "Mine", reason: "Because" }), 404)
      await refused(await command(harbors.id, "change", { note: "Mine", reason: "Because" }, viewer), 404)
      await refused(await command(harbors.id, "change", { note: "Mine", reason: "Because" }, lars), 404)
      assert.match((await refused(await command(harbors.id, "change", { note: "Mine", reason: "Because" }, ungranted), 403)).detail ?? "", /edit on fleet\.vehicle-planning/)
      assert.equal((await one(olivia, harbors.id)).note, null, "untouched")
    })
  })

  describe("POST /vehicle-allocations/:id/confirm and /release", () => {
    test("confirm moves planned to confirmed with an event, and a second confirm answers 200 without a write or an event", async () => {
      const created = await allocate(body("2026-10-15", "06:00", "10:00", { driverId: fleet.drivers.mads.id }))
      await nextMillisecond()
      const confirmed = await commanded(created.id, "confirm", {})
      assert.equal(confirmed.status, "confirmed")
      assert.ok(confirmed.updatedAt > created.updatedAt)
      const again = await commanded(created.id, "confirm", {})
      assert.deepEqual(again, confirmed, "idempotent: the same row, the same stamp")
      const { items } = await events(created.id)
      assert.deepEqual(items.map((event) => [event.action, event.status, event.reason]), [["allocate", "planned", null], ["confirm", "confirmed", null]], "one confirm event, not two")
      assert.deepEqual(snapshotOfEvent(items[1]), snapshotOf(confirmed))
      const member = await refused(await command(created.id, "confirm", { reason: "Sure" }), 400)
      assert.ok(member.errors?.some((error) => /reason/.test(error.message)), "the confirm's body is empty; a member is refused")
    })

    test("release frees the window with a reason, keeps the row and its history, and a second release answers 200 without a write or an event", async () => {
      const day = "2026-10-16"
      const created = await allocate(body(day, "06:00", "10:00", { driverId: fleet.drivers.mads.id, trailerId: fleet.vehicles.trailer.id, status: "confirmed" }))
      await nextMillisecond()
      const released = await commanded(created.id, "release", { reason: "Truck in the workshop" })
      assert.equal(released.status, "released")
      assert.deepEqual([released.vehicleId, released.driverId, released.trailerId, released.plannedFrom, released.plannedTo], [created.vehicleId, created.driverId, created.trailerId, created.plannedFrom, created.plannedTo], "the row keeps what it reserved")
      assert.ok(released.updatedAt > created.updatedAt)
      const again = await commanded(created.id, "release", { reason: "Once more" })
      assert.deepEqual(again, released, "idempotent")
      const { items } = await events(created.id)
      assert.deepEqual(items.map((event) => [event.action, event.status, event.reason]), [["allocate", "confirmed", null], ["release", "released", "Truck in the workshop"]], "one release event, with the first reason")
      assert.deepEqual(snapshotOfEvent(items[1]), snapshotOf(released))

      const freed = await allocate(body(day, "06:00", "10:00", { driverId: fleet.drivers.mads.id, trailerId: fleet.vehicles.trailer.id }))
      assert.notEqual(freed.id, created.id, "the vehicle, the driver and the trailer are free over the window again")
      assert.deepEqual((await refused(await command(freed.id, "release", {}), 400)).errors?.map((error) => error.path), ["reason"])
      assert.deepEqual((await refused(await command(freed.id, "release", { reason: "x", note: "y" }), 400)).errors?.map((error) => error.path), [""], "a member the command does not take")
      assert.equal((await one(olivia, freed.id)).status, "planned", "nothing written by the refused bodies")
    })

    test("answers 404 outside the caller's scope, and 403 for a role without edit", async () => {
      await refused(await command(theirs.id, "confirm", {}), 404)
      await refused(await command(theirs.id, "release", { reason: "Mine" }), 404)
      await refused(await command(harbors.id, "confirm", {}, viewer), 404)
      await refused(await command(harbors.id, "release", { reason: "Mine" }, lars), 404)
      assert.match((await refused(await command(harbors.id, "confirm", {}, ungranted), 403)).detail ?? "", /edit on fleet\.vehicle-planning/)
      assert.match((await refused(await command(harbors.id, "release", { reason: "Mine" }, ungranted), 403)).detail ?? "", /edit on fleet\.vehicle-planning/)
      assert.equal((await one(olivia, harbors.id)).status, "planned", "untouched")
    })
  })

  describe("GET /vehicle-allocations/:id/events", () => {
    test("is the history oldest first, every event carrying the snapshot after its action, the reason where the command took one, and who did it", async () => {
      const day = "2026-10-17"
      const created = await allocate(body(day, "06:00", "10:00", { driverId: fleet.drivers.mads.id, trailerId: fleet.vehicles.trailer.id, depotId: fleet.depots.nordhavn.id }))
      const changed = await commanded(created.id, "change", { driverId: null, trailerId: null, plannedTo: at(day, "12:00"), reason: "Solo run, longer" })
      const confirmed = await commanded(created.id, "confirm", {})
      const released = await commanded(created.id, "release", { reason: "Rained off" })

      const { items, nextCursor } = await events(created.id)
      assert.equal(nextCursor, null)
      assert.deepEqual(
        items.map((event) => [event.action, event.status, event.reason]),
        [["allocate", "planned", null], ["change", "planned", "Solo run, longer"], ["confirm", "confirmed", null], ["release", "released", "Rained off"]],
      )
      assert.deepEqual(items.map(snapshotOfEvent), [snapshotOf(created), snapshotOf(changed), snapshotOf(confirmed), snapshotOf(released)], "each event is the row as its action left it")
      assert.deepEqual(snapshotOf(confirmed), snapshotOf(changed), "confirm and release move the status and nothing of what is reserved")
      assert.ok(items.every((event) => event.recordedBy === a.users.olivia.id && event.vehicleAllocationId === created.id && event.projectId === created.projectId))
      assert.ok(items.every((event, n) => n === 0 || (event.id > items[n - 1].id && event.recordedAt >= items[n - 1].recordedAt)), "ids in recording order")

      const first = await events(created.id, "?limit=2")
      assert.deepEqual(first.items.map((event) => event.action), ["allocate", "change"])
      assert.ok(first.nextCursor !== null)
      assert.deepEqual((await events(created.id, `?limit=2&cursor=${first.nextCursor}`)).items.map((event) => event.action), ["confirm", "release"])
    })

    test("answers 404 outside the caller's scope and 403 for a role without view; the viewer reads Copenhagen's", async () => {
      await refused(await olivia(`/vehicle-allocations/${theirs.id}/events`), 404)
      await refused(await viewer(`/vehicle-allocations/${harbors.id}/events`), 404)
      await refused(await lars(`/vehicle-allocations/${harbors.id}/events`), 404)
      await refused(await olivia(`/vehicle-allocations/${testId()}/events`), 404)
      assert.match((await refused(await ungranted(`/vehicle-allocations/${harbors.id}/events`), 403)).detail ?? "", /view on fleet\.vehicle-planning/)
      const created = await allocate(body("2026-10-18", "06:00", "10:00"))
      assert.equal((await events(created.id, "?limit=200", viewer)).items.length, 1)
      assert.equal((await events(harbors.id)).items.length, 1, "the harbor allocation has its allocate event and nothing else")
    })
  })
})
