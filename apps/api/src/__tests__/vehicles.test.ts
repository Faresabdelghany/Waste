import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { WasteFraction } from "@waste/contracts/catalogue"
import { A_POWERED_VEHICLE_HAS_A_COMPARTMENT, Vehicle } from "@waste/contracts/fleet"
import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { PROVIDER_WITH_PROVIDER_OWNERSHIP } from "@waste/contracts/places"
import { RouteScheme } from "@waste/contracts/route-schemes"
import { createDb, type Database } from "@waste/db/client"
import { vehicleAllocation } from "@waste/db/schema/allocations"
import { withCompany } from "@waste/db/tenant"
import { and, eq } from "drizzle-orm"

import { createApp } from "../app"
import { ProblemError } from "../problem"
import { NOT_A_POWERED_VEHICLE, NOT_A_TRAILER, NOT_A_VEHICLE, requireVehicle } from "../routes/references"
import { callingAs, type Call } from "./calls"
import { nextMillisecond } from "./clock"
import { databaseUnderTest } from "./database"
import { seedFleet, type FleetFixtures } from "./fleet-fixtures"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const VehiclePage = Page(Vehicle)

const MODULE = "fleet.vehicles"

const HOUR = 3_600_000

describe("the vehicle endpoints", { skip: database.skip }, () => {
  let pool: Database
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
  /** The Service Provider Manager, whose charter grants the fleet in full: a role that reaches no project of the company. */
  let lars: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call

  /** What a compartment carries. */
  let residual: WasteFraction
  let glass: WasteFraction
  /** The other company's. */
  let theirFraction: WasteFraction
  let theirVehicle: Vehicle

  /** Every registration is one vehicle's across the company, so each test takes the next plate. */
  let plates = 0
  const plate = () => `CN 42 ${String(++plates).padStart(3, "0")}`

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a)
    theirFleet = await seedFleet(pool, b)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create", "edit"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)

    residual = await create(olivia, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    glass = await create(olivia, "/waste-fractions", { key: "glass", name: "Glass" }, WasteFraction)
    theirFraction = await create(other, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    theirVehicle = await create(
      other,
      "/vehicles",
      {
        projectId: b.projects.copenhagen.id,
        registration: "XX 99 999",
        kind: "powered-vehicle",
        vehicleTypeId: theirFleet.vehicleTypes.rearLoader.id,
        requiredLicenceClass: "c",
        compartments: [{ wasteFractionIds: [theirFraction.id] }],
      },
      Vehicle,
    )
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }

  /** A vehicle body a caller may send: the fields with no default, a powered rear loader in Copenhagen Central with one compartment for residual waste. */
  const body = (values: Record<string, unknown> = {}) => ({
    projectId: a.projects.copenhagen.id,
    registration: plate(),
    kind: "powered-vehicle",
    vehicleTypeId: fleet.vehicleTypes.rearLoader.id,
    requiredLicenceClass: "c",
    compartments: [{ name: "Body", wasteFractionIds: [residual.id] }],
    ...values,
  })

  const create = async <T>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> => {
    const response = await call(path, { method: "POST", body: values })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  const vehicle = (values: Record<string, unknown> = {}) => create(olivia, "/vehicles", body(values), Vehicle)
  const one = async (call: Call, id: string): Promise<Vehicle> => {
    const response = await call(`/vehicles/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Vehicle.parse(await response.json())
  }
  const patch = async (call: Call, id: string, values: unknown): Promise<Vehicle> => {
    const response = await call(`/vehicles/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Vehicle.parse(await response.json())
  }
  const putCompartments = async (call: Call, id: string, compartments: unknown): Promise<Vehicle> => {
    const response = await call(`/vehicles/${id}/compartments`, { method: "PUT", body: { compartments } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Vehicle.parse(await response.json())
  }
  const page = async (call: Call, query = "") => VehiclePage.parse(await (await call(`/vehicles${query}`)).json())
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const post = (values: unknown) => olivia("/vehicles", { method: "POST", body: values })

  describe("POST /vehicles", () => {
    test("mints the id, takes the defaults, and writes the compartments 1..n in the body's order with each one's fractions as given", async () => {
      const created = await vehicle({
        callsign: "WH-24",
        capacityKg: 12_000,
        fuel: "diesel",
        compartments: [
          { name: "Left", capacityKg: 6_000, wasteFractionIds: [glass.id, residual.id] },
          { name: "Right", volumeLitres: 9_000, wasteFractionIds: [residual.id] },
        ],
      })
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.equal(created.projectId, a.projects.copenhagen.id)
      assert.deepEqual(
        [created.ownership, created.status, created.serviceProviderId, created.homeDepotId, created.telematicsDeviceId, created.notes],
        ["company", "active", null, null, null, null],
        "the defaults: the company's, active, based nowhere yet",
      )
      assert.deepEqual([created.callsign, created.capacityKg, created.fuel, created.requiredLicenceClass], ["WH-24", 12_000, "diesel", "c"])
      assert.deepEqual(created.compartments, [
        { position: 1, name: "Left", capacityKg: 6_000, volumeLitres: null, wasteFractionIds: [glass.id, residual.id] },
        { position: 2, name: "Right", capacityKg: null, volumeLitres: 9_000, wasteFractionIds: [residual.id] },
      ])
      assert.deepEqual(await one(olivia, created.id), created, "what the write answered is what the next read says")
    })

    test("takes a trailer with no compartment, and refuses a powered vehicle without one before anything is written", async () => {
      const trailer = await vehicle({ kind: "trailer", requiredLicenceClass: "ce", compartments: [] })
      assert.deepEqual([trailer.kind, trailer.compartments], ["trailer", []])
      const bare = await vehicle({ kind: "trailer", requiredLicenceClass: "ce", compartments: undefined })
      assert.deepEqual(bare.compartments, [], "absent is none")

      const registration = plate()
      const problem = await refused(await post(body({ registration, compartments: [] })), 400)
      assert.deepEqual(problem.errors, [{ path: "compartments", message: A_POWERED_VEHICLE_HAS_A_COMPARTMENT }])
      assert.deepEqual((await page(olivia, "?limit=200")).items.filter((row) => row.registration === registration), [], "and nothing was written")
    })

    test("holds every compartment's fractions to this company, naming the entry, and writes nothing", async () => {
      const registration = plate()
      const foreign = await refused(
        await post(body({ registration, compartments: [{ wasteFractionIds: [residual.id] }, { wasteFractionIds: [glass.id, theirFraction.id] }] })),
        400,
      )
      assert.deepEqual(foreign.errors, [{ path: "compartments.1.wasteFractionIds.1", message: "Not a waste fraction of this company" }])
      const unminted = await refused(await post(body({ registration, compartments: [{ wasteFractionIds: [testId()] }] })), 400)
      assert.deepEqual(unminted.errors, [{ path: "compartments.0.wasteFractionIds.0", message: "Not a waste fraction of this company" }])
      assert.deepEqual((await page(olivia, "?limit=200")).items.filter((row) => row.registration === registration), [], "and nothing was written")

      const twice = await refused(await post(body({ compartments: [{ wasteFractionIds: [residual.id, residual.id] }] })), 400)
      assert.deepEqual(twice.errors?.map((error) => error.path), ["compartments.0.wasteFractionIds"], "a fraction is named once per compartment")
    })

    test("holds the vehicle type, the home depot and the provider to the scope their keys allow, and the provider to the ownership", async () => {
      const type = await refused(await post(body({ vehicleTypeId: theirFleet.vehicleTypes.rearLoader.id })), 400)
      assert.deepEqual(type.errors, [{ path: "vehicleTypeId", message: "Not a vehicle type of this company" }])
      const depot = await refused(await post(body({ homeDepotId: fleet.depots.harbor.id })), 400)
      assert.deepEqual(depot.errors, [{ path: "homeDepotId", message: "Not a depot of this project" }])
      const based = await vehicle({ homeDepotId: fleet.depots.nordhavn.id })
      assert.equal(based.homeDepotId, fleet.depots.nordhavn.id)

      const foreign = await refused(await post(body({ ownership: "service-provider", serviceProviderId: b.serviceProviders.nordren.id })), 400)
      assert.deepEqual(foreign.errors, [{ path: "serviceProviderId", message: "Not a service provider of this company" }])
      const unowned = await refused(await post(body({ ownership: "service-provider" })), 400)
      assert.deepEqual(unowned.errors, [{ path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP }])
      const owned = await refused(await post(body({ serviceProviderId: a.serviceProviders.nordren.id })), 400)
      assert.deepEqual(owned.errors, [{ path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP }], "company ownership names no provider")
      const provided = await vehicle({ ownership: "service-provider", serviceProviderId: a.serviceProviders.nordren.id })
      assert.deepEqual([provided.ownership, provided.serviceProviderId], ["service-provider", a.serviceProviders.nordren.id])
    })

    test("refuses a registration the company already holds, whatever project it is in, and a callsign likewise; vehicles without a callsign do not collide", async () => {
      const registration = plate()
      await vehicle({ registration })
      const taken = await refused(await post(body({ registration, projectId: a.projects.harbor.id })), 409)
      assert.equal(taken.detail, `This company already has a vehicle registered ${registration}`)
      assert.doesNotMatch(taken.detail ?? "", /_key/)

      await vehicle({ callsign: "WH-1" })
      const callsign = await refused(await post(body({ callsign: "WH-1", projectId: a.projects.harbor.id })), 409)
      assert.equal(callsign.detail, "This company already has a vehicle with the callsign WH-1")
      assert.doesNotMatch(callsign.detail ?? "", /_idx/)
      const first = await vehicle()
      const second = await vehicle()
      assert.deepEqual([first.callsign, second.callsign], [null, null], "a null is not a duplicate of another null")
    })

    test("refuses a project the caller does not work in, and a member the server owns", async () => {
      const foreign = await refused(await post(body({ projectId: b.projects.copenhagen.id })), 400)
      assert.deepEqual(foreign.errors, [{ path: "projectId", message: "Not a project this account works in" }])
      const provider = await refused(await lars("/vehicles", { method: "POST", body: body() }), 400)
      assert.deepEqual(provider.errors, [{ path: "projectId", message: "Not a project this account works in" }], "a service provider's account works in no project, whatever its charter grants")
      const owned = await refused(await post(body({ id: testId() })), 400)
      assert.ok(owned.errors?.some((error) => /id/.test(error.message)), JSON.stringify(owned.errors))
    })

    test("refuses a role without create on the module", async () => {
      const problem = await refused(await ungranted("/vehicles", { method: "POST", body: body() }), 403)
      assert.match(problem.detail ?? "", /create on fleet\.vehicles/)
    })
  })

  describe("GET /vehicles", () => {
    test("answers the company's vehicles with their compartments in id order and holds nothing of another company's", async () => {
      const mine = await vehicle({ compartments: [{ name: "Body", wasteFractionIds: [glass.id, residual.id] }] })
      const { items } = await page(olivia, "?limit=200")
      const ids = items.map((row) => row.id)
      assert.ok(ids.includes(mine.id))
      assert.deepEqual(ids, [...ids].sort(), "ascending by id")
      assert.ok(!ids.includes(theirVehicle.id))
      assert.deepEqual(items.find((row) => row.id === mine.id), mine, "a page carries the compartments a single read does")
      assert.deepEqual((await page(other, "?limit=200")).items.map((row) => row.registration), ["XX 99 999"])
    })

    test("filters by project, kind, type, status and home depot", async () => {
      const harbor = await vehicle({ projectId: a.projects.harbor.id, homeDepotId: fleet.depots.harbor.id, vehicleTypeId: fleet.vehicleTypes.glassCrane.id })
      const trailer = await vehicle({ kind: "trailer", requiredLicenceClass: "ce", compartments: [], status: "unavailable" })

      const byProject = await page(olivia, `?limit=200&projectId=${a.projects.harbor.id}`)
      assert.ok(byProject.items.some((row) => row.id === harbor.id))
      for (const row of byProject.items) assert.equal(row.projectId, a.projects.harbor.id)
      const trailers = (await page(olivia, "?limit=200&kind=trailer")).items
      assert.ok(trailers.some((row) => row.id === trailer.id))
      for (const row of trailers) assert.equal(row.kind, "trailer")
      const cranes = (await page(olivia, `?limit=200&vehicleTypeId=${fleet.vehicleTypes.glassCrane.id}`)).items
      assert.ok(cranes.some((row) => row.id === harbor.id))
      for (const row of cranes) assert.equal(row.vehicleTypeId, fleet.vehicleTypes.glassCrane.id)
      const unavailable = (await page(olivia, "?limit=200&status=unavailable")).items
      assert.ok(unavailable.some((row) => row.id === trailer.id))
      for (const row of unavailable) assert.equal(row.status, "unavailable")
      const based = (await page(olivia, `?limit=200&homeDepotId=${fleet.depots.harbor.id}`)).items
      assert.ok(based.some((row) => row.id === harbor.id))
      for (const row of based) assert.equal(row.homeDepotId, fleet.depots.harbor.id)
      const bad = await refused(await olivia("/vehicles?kind=bicycle"), 400)
      assert.deepEqual(bad.errors?.map((error) => error.path), ["kind"])
    })

    test("shows an account only the projects it works in, and answers an empty page to one that works in none", async () => {
      const here = await vehicle()
      const elsewhere = await vehicle({ projectId: a.projects.harbor.id })
      const seen = (await page(viewer, "?limit=200")).items
      assert.ok(seen.some((row) => row.id === here.id))
      assert.ok(!seen.some((row) => row.id === elsewhere.id))
      for (const row of seen) assert.equal(row.projectId, a.projects.copenhagen.id)

      assert.deepEqual(await page(lars, "?limit=200"), { items: [], nextCursor: null })
      await refused(await lars(`/vehicles/${here.id}`), 404)

      const problem = await refused(await viewer(`/vehicles?projectId=${a.projects.harbor.id}`), 400)
      assert.equal(problem.detail, "The request query is invalid")
      assert.deepEqual(problem.errors, [{ path: "projectId", message: "Not a project this account works in" }])
    })

    test("walks the pages with the cursor, each item carrying its own compartments and none of the next vehicle's", async () => {
      const all = (await page(olivia, "?limit=200")).items
      assert.ok(all.length >= 2)
      assert.ok(all.some((row) => row.compartments.length > 0), "and at least one of them has compartments to carry")
      const first = await page(olivia, "?limit=1")
      assert.deepEqual(first.items, all.slice(0, 1), "one item, with its own compartments: the surplus row that proved there is a next page is not one of them")
      assert.ok(first.nextCursor !== null)
      const rest = await page(olivia, `?limit=200&cursor=${first.nextCursor}`)
      assert.deepEqual(rest.items, all.slice(1))
      assert.equal(rest.nextCursor, null)
    })

    test("refuses a role without fleet.vehicles view, and a caller with no token", async () => {
      assert.match((await refused(await ungranted("/vehicles"), 403)).detail ?? "", /view on fleet\.vehicles/)
      assert.equal((await app.request("/vehicles")).status, 401)
    })
  })

  describe("GET /vehicles/:id", () => {
    test("answers 404 for another company's vehicle, for one in a project the caller does not work in, and for an id nobody minted", async () => {
      const foreign = await refused(await olivia(`/vehicles/${theirVehicle.id}`), 404)
      assert.match(foreign.detail ?? "", /vehicle/i)
      assert.equal((await one(other, theirVehicle.id)).registration, "XX 99 999", "still there for its own company")

      const elsewhere = await vehicle({ projectId: a.projects.harbor.id })
      await refused(await viewer(`/vehicles/${elsewhere.id}`), 404)
      assert.equal((await one(olivia, elsewhere.id)).id, elsewhere.id)
      await refused(await olivia(`/vehicles/${testId()}`), 404)
      assert.deepEqual((await refused(await olivia("/vehicles/not-a-uuid"), 400)).errors?.map((error) => error.path), ["id"])
    })
  })

  describe("PATCH /vehicles/:id", () => {
    test("changes what the body names, leaves the rest and the compartments, and moves the stamp", async () => {
      const created = await vehicle({ homeDepotId: fleet.depots.nordhavn.id })
      await nextMillisecond()
      const changed = await patch(olivia, created.id, { callsign: "WH-99", status: "maintenance", capacityKg: 9_000, notes: "Gearbox", telematicsDeviceId: "TLM-1" })
      assert.deepEqual([changed.callsign, changed.status, changed.capacityKg, changed.notes, changed.telematicsDeviceId], ["WH-99", "maintenance", 9_000, "Gearbox", "TLM-1"])
      assert.deepEqual([changed.registration, changed.homeDepotId, changed.kind], [created.registration, fleet.depots.nordhavn.id, "powered-vehicle"], "what the patch did not name it did not touch")
      assert.deepEqual(changed.compartments, created.compartments, "a vehicle's patch never touches its compartments")
      assert.ok(changed.updatedAt > created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), changed)

      const cleared = await patch(olivia, created.id, { callsign: null, homeDepotId: null, capacityKg: null, notes: null, telematicsDeviceId: null, fuel: null })
      assert.deepEqual([cleared.callsign, cleared.homeDepotId, cleared.capacityKg, cleared.notes, cleared.telematicsDeviceId, cleared.fuel], [null, null, null, null, null, null], "a null takes each back")
      const retyped = await patch(olivia, created.id, { vehicleTypeId: fleet.vehicleTypes.glassCrane.id, requiredLicenceClass: "ce", fuel: "electric" })
      assert.deepEqual([retyped.vehicleTypeId, retyped.requiredLicenceClass, retyped.fuel], [fleet.vehicleTypes.glassCrane.id, "ce", "electric"])
    })

    test("holds the provider rule against the merged row, in the contracts' words", async () => {
      const created = await vehicle()
      const unowned = await refused(await olivia(`/vehicles/${created.id}`, { method: "PATCH", body: { ownership: "service-provider" } }), 400)
      assert.deepEqual(unowned.errors, [{ path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP }], "the stored row names no provider")
      const owned = await refused(await olivia(`/vehicles/${created.id}`, { method: "PATCH", body: { serviceProviderId: a.serviceProviders.nordren.id } }), 400)
      assert.deepEqual(owned.errors, [{ path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP }], "the stored row is the company's")
      const provided = await patch(olivia, created.id, { ownership: "service-provider", serviceProviderId: a.serviceProviders.nordren.id })
      assert.deepEqual([provided.ownership, provided.serviceProviderId], ["service-provider", a.serviceProviders.nordren.id])
      const kept = await refused(await olivia(`/vehicles/${created.id}`, { method: "PATCH", body: { ownership: "leased" } }), 400)
      assert.deepEqual(kept.errors?.map((error) => error.path), ["serviceProviderId"], "the stored provider now has no ownership to belong to")
      const leased = await patch(olivia, created.id, { ownership: "leased", serviceProviderId: null })
      assert.deepEqual([leased.ownership, leased.serviceProviderId], ["leased", null])
    })

    test("holds a new vehicle type, home depot and provider to the scope their keys allow", async () => {
      const created = await vehicle()
      const type = await refused(await olivia(`/vehicles/${created.id}`, { method: "PATCH", body: { vehicleTypeId: theirFleet.vehicleTypes.glassCrane.id } }), 400)
      assert.deepEqual(type.errors, [{ path: "vehicleTypeId", message: "Not a vehicle type of this company" }])
      const depot = await refused(await olivia(`/vehicles/${created.id}`, { method: "PATCH", body: { homeDepotId: fleet.depots.harbor.id } }), 400)
      assert.deepEqual(depot.errors, [{ path: "homeDepotId", message: "Not a depot of this project" }])
      const provider = await refused(
        await olivia(`/vehicles/${created.id}`, { method: "PATCH", body: { ownership: "service-provider", serviceProviderId: b.serviceProviders.nordren.id } }),
        400,
      )
      assert.deepEqual(provider.errors, [{ path: "serviceProviderId", message: "Not a service provider of this company" }])
      assert.deepEqual(await one(olivia, created.id), created, "and nothing moved")
    })

    test("refuses retiring under live allocations, counting them, and retires once they are released", async () => {
      const truck = await vehicle()
      const trailer = await vehicle({ kind: "trailer", requiredLicenceClass: "ce", compartments: [] })
      const now = Date.now()
      const tenant = { companyId: a.companyId, projectId: a.projects.copenhagen.id }
      const planned = testId()
      const confirmed = testId()
      // Four rows: two live ones over disjoint windows (the constraint refuses
      // two live windows of one vehicle that overlap), a released one over a
      // live window, and one already over. The two live ones count.
      await withCompany(pool.db, a.companyId, async (tx) => {
        await tx.insert(vehicleAllocation).values([
          { id: planned, ...tenant, vehicleId: truck.id, plannedFrom: new Date(now + HOUR), plannedTo: new Date(now + 2 * HOUR), status: "planned" },
          { id: confirmed, ...tenant, vehicleId: truck.id, trailerId: trailer.id, plannedFrom: new Date(now + 2 * HOUR), plannedTo: new Date(now + 3 * HOUR), status: "confirmed" },
          { id: testId(), ...tenant, vehicleId: truck.id, plannedFrom: new Date(now + HOUR), plannedTo: new Date(now + 3 * HOUR), status: "released" },
          { id: testId(), ...tenant, vehicleId: truck.id, plannedFrom: new Date(now - 3 * HOUR), plannedTo: new Date(now - 2 * HOUR), status: "confirmed" },
        ])
      })
      const two = await refused(await olivia(`/vehicles/${truck.id}`, { method: "PATCH", body: { status: "retired" } }), 409)
      assert.equal(two.detail, "2 live allocations name this vehicle; release them first")
      assert.equal((await one(olivia, truck.id)).status, "active", "and the refused patch wrote nothing")
      const towed = await refused(await olivia(`/vehicles/${trailer.id}`, { method: "PATCH", body: { status: "retired" } }), 409)
      assert.equal(towed.detail, "1 live allocation names this vehicle; release it first", "an allocation names a trailer as its trailer, and a trailer is a vehicle")
      const parked = await patch(olivia, truck.id, { status: "unavailable" })
      assert.equal(parked.status, "unavailable", "every other status is a plain patch")

      const release = (id: string) =>
        withCompany(pool.db, a.companyId, async (tx) => {
          await tx.update(vehicleAllocation).set({ status: "released" }).where(and(eq(vehicleAllocation.companyId, a.companyId), eq(vehicleAllocation.id, id)))
        })
      await release(planned)
      const one_ = await refused(await olivia(`/vehicles/${truck.id}`, { method: "PATCH", body: { status: "retired" } }), 409)
      assert.equal(one_.detail, "1 live allocation names this vehicle; release it first")
      await release(confirmed)
      const retired = await patch(olivia, truck.id, { status: "retired" })
      assert.equal(retired.status, "retired", "a released allocation and one already over stand in nobody's way")
      const trailerRetired = await patch(olivia, trailer.id, { status: "retired" })
      assert.equal(trailerRetired.status, "retired")
      const again = await patch(olivia, truck.id, { status: "retired", notes: "Sold" })
      assert.deepEqual([again.status, again.notes], ["retired", "Sold"], "a vehicle already retired is not asked again")
    })

    test("refuses retiring under collection groups of schemes in force today, counting them whatever the scheme's status, after the allocations; an ended or a future scheme counts for nothing", async () => {
      const truck = await vehicle()
      /** A draft scheme whose one rule group runs with the truck, over the period given. */
      const naming = (name: string, validFrom: string, validTo?: string) => ({
        projectId: a.projects.copenhagen.id,
        name,
        serviceType: "container-collection",
        frequency: "weekly",
        serviceDays: ["monday"],
        validFrom,
        ...(validTo === undefined ? {} : { validTo }),
        collectionGroups: [{ name: "North", days: ["monday"], stopSource: "rule", rule: { wasteFractionIds: [residual.id], containerTypeIds: [], vehicleTypeId: null }, vehicleId: truck.id }],
      })
      const retire = () => olivia(`/vehicles/${truck.id}`, { method: "PATCH", body: { status: "retired" } })
      const running = await create(olivia, "/route-schemes", naming("Running", "2026-01-01"), RouteScheme)
      await create(olivia, "/route-schemes", naming("Ended", "2025-01-01", "2025-07-01"), RouteScheme)
      await create(olivia, "/route-schemes", naming("Not yet", "2030-01-05"), RouteScheme)
      const one_ = await refused(await retire(), 409)
      assert.equal(one_.detail, "1 collection group names this vehicle; reassign it first", "a draft scheme in force counts; the ended one and the future one do not")
      const alsoRunning = await create(olivia, "/route-schemes", naming("Running too", "2026-06-01"), RouteScheme)
      const two = await refused(await retire(), 409)
      assert.equal(two.detail, "2 collection groups name this vehicle; reassign them first")
      assert.equal((await one(olivia, truck.id)).status, "active", "and the refused patches wrote nothing")

      // A parked group — one with no days — runs on nothing and plans nothing with the truck, so it counts for nothing.
      const parked = await olivia(`/collection-groups/${alsoRunning.collectionGroups[0].id}`, { method: "PATCH", body: { days: [] } })
      assert.equal(parked.status, 200, JSON.stringify(await parked.clone().json()))
      assert.equal((await refused(await retire(), 409)).detail, "1 collection group names this vehicle; reassign it first", "the parked group still names the truck and does not count; the running one does")

      // A live allocation is counted first, in its own sentence.
      const allocation = testId()
      await withCompany(pool.db, a.companyId, async (tx) => {
        await tx.insert(vehicleAllocation).values({ id: allocation, companyId: a.companyId, projectId: a.projects.copenhagen.id, vehicleId: truck.id, plannedFrom: new Date(Date.now() + HOUR), plannedTo: new Date(Date.now() + 2 * HOUR), status: "planned" })
      })
      assert.equal((await refused(await retire(), 409)).detail, "1 live allocation names this vehicle; release it first", "the allocations are counted before the groups")
      await withCompany(pool.db, a.companyId, async (tx) => {
        await tx.update(vehicleAllocation).set({ status: "released" }).where(and(eq(vehicleAllocation.companyId, a.companyId), eq(vehicleAllocation.id, allocation)))
      })
      for (const scheme of [running, alsoRunning]) {
        const reassigned = await olivia(`/collection-groups/${scheme.collectionGroups[0].id}`, { method: "PATCH", body: { vehicleId: null } })
        assert.equal(reassigned.status, 200, JSON.stringify(await reassigned.clone().json()))
      }
      const retired = await patch(olivia, truck.id, { status: "retired" })
      assert.equal(retired.status, "retired", "released and reassigned, the vehicle retires")
    })

    test("refuses a registration or a callsign another vehicle holds", async () => {
      const held = await vehicle({ callsign: "WH-7" })
      const created = await vehicle()
      const registration = await refused(await olivia(`/vehicles/${created.id}`, { method: "PATCH", body: { registration: held.registration } }), 409)
      assert.equal(registration.detail, `This company already has a vehicle registered ${held.registration}`)
      const callsign = await refused(await olivia(`/vehicles/${created.id}`, { method: "PATCH", body: { callsign: "WH-7" } }), 409)
      assert.equal(callsign.detail, "This company already has a vehicle with the callsign WH-7")
      assert.deepEqual(await one(olivia, created.id), created)
    })

    test("refuses the kind, the project, the compartments, an empty patch, another company's vehicle, one out of the caller's projects, and a role without edit on the module", async () => {
      const created = await vehicle()
      for (const [field, value] of [
        ["kind", "trailer"],
        ["projectId", a.projects.harbor.id],
        ["compartments", []],
      ] as const) {
        const problem = await refused(await olivia(`/vehicles/${created.id}`, { method: "PATCH", body: { [field]: value } }), 400)
        assert.ok(problem.errors?.some((error) => error.message.includes(field)), `${field}: ${JSON.stringify(problem.errors)}`)
      }
      assert.deepEqual((await refused(await olivia(`/vehicles/${created.id}`, { method: "PATCH", body: {} }), 400)).errors?.map((error) => error.path), [""])

      await refused(await olivia(`/vehicles/${theirVehicle.id}`, { method: "PATCH", body: { status: "retired" } }), 404)
      assert.equal((await one(other, theirVehicle.id)).status, "active")
      const elsewhere = await vehicle({ projectId: a.projects.harbor.id })
      await refused(await viewer(`/vehicles/${elsewhere.id}`, { method: "PATCH", body: { status: "retired" } }), 404)
      assert.match((await refused(await ungranted(`/vehicles/${created.id}`, { method: "PATCH", body: { status: "retired" } }), 403)).detail ?? "", /edit on fleet\.vehicles/)
    })
  })

  describe("PUT /vehicles/:id/compartments", () => {
    test("replaces the whole set, positions 1..n in the body's order, and moves the stamp", async () => {
      const created = await vehicle({
        compartments: [
          { name: "Left", wasteFractionIds: [residual.id] },
          { name: "Right", wasteFractionIds: [glass.id] },
        ],
      })
      await nextMillisecond()
      const replaced = await putCompartments(olivia, created.id, [{ name: "Body", capacityKg: 11_000, wasteFractionIds: [glass.id, residual.id] }])
      assert.deepEqual(replaced.compartments, [{ position: 1, name: "Body", capacityKg: 11_000, volumeLitres: null, wasteFractionIds: [glass.id, residual.id] }])
      assert.ok(replaced.updatedAt > created.updatedAt, "the record the set belongs to moved")
      assert.deepEqual([replaced.registration, replaced.status], [created.registration, created.status], "and nothing else did")
      assert.deepEqual(await one(olivia, created.id), replaced)

      const three = await putCompartments(olivia, created.id, [{ wasteFractionIds: [residual.id] }, { wasteFractionIds: [glass.id] }, { name: "Rear", wasteFractionIds: [residual.id] }])
      assert.deepEqual(
        three.compartments.map((compartment) => [compartment.position, compartment.name]),
        [
          [1, null],
          [2, null],
          [3, "Rear"],
        ],
        "renumbered from one in the body's order",
      )
    })

    test("holds the list to the stored kind: a powered vehicle keeps a compartment, a trailer may have none", async () => {
      const truck = await vehicle()
      const problem = await refused(await olivia(`/vehicles/${truck.id}/compartments`, { method: "PUT", body: { compartments: [] } }), 400)
      assert.deepEqual(problem.errors, [{ path: "compartments", message: A_POWERED_VEHICLE_HAS_A_COMPARTMENT }])
      const unchanged = await one(olivia, truck.id)
      assert.deepEqual(unchanged.compartments, truck.compartments, "the set it had is the set it has")
      assert.equal(unchanged.updatedAt, truck.updatedAt, "and the stamp the replacement took rolled back with the rest of it")

      const trailer = await vehicle({ kind: "trailer", requiredLicenceClass: "ce", compartments: [{ wasteFractionIds: [glass.id] }] })
      assert.equal(trailer.compartments.length, 1, "a trailer may carry a compartment")
      const bare = await putCompartments(olivia, trailer.id, [])
      assert.deepEqual(bare.compartments, [], "and may be a bare trailer again")
    })

    test("refuses a fraction of another company at the indexed path, and writes nothing", async () => {
      const created = await vehicle()
      const problem = await refused(
        await olivia(`/vehicles/${created.id}/compartments`, {
          method: "PUT",
          body: { compartments: [{ wasteFractionIds: [residual.id] }, { wasteFractionIds: [theirFraction.id] }] },
        }),
        400,
      )
      assert.deepEqual(problem.errors, [{ path: "compartments.1.wasteFractionIds.0", message: "Not a waste fraction of this company" }])
      const unchanged = await one(olivia, created.id)
      assert.deepEqual(unchanged.compartments, created.compartments)
      assert.equal(unchanged.updatedAt, created.updatedAt)
    })

    test("refuses the same fraction twice in one compartment, a body naming no list, a compartment naming no fraction, and more than twenty", async () => {
      const created = await vehicle()
      const twice = await refused(
        await olivia(`/vehicles/${created.id}/compartments`, { method: "PUT", body: { compartments: [{ wasteFractionIds: [residual.id, residual.id] }] } }),
        400,
      )
      assert.deepEqual(twice.errors?.map((error) => error.path), ["compartments.0.wasteFractionIds"])
      assert.deepEqual(
        (await refused(await olivia(`/vehicles/${created.id}/compartments`, { method: "PUT", body: {} }), 400)).errors?.map((error) => error.path),
        ["compartments"],
      )
      const empty = await refused(await olivia(`/vehicles/${created.id}/compartments`, { method: "PUT", body: { compartments: [{ name: "Empty", wasteFractionIds: [] }] } }), 400)
      assert.deepEqual(empty.errors?.map((error) => error.path), ["compartments.0.wasteFractionIds"], "a compartment carries at least one fraction")
      const many = await refused(
        await olivia(`/vehicles/${created.id}/compartments`, { method: "PUT", body: { compartments: Array.from({ length: 21 }, () => ({ wasteFractionIds: [residual.id] })) } }),
        400,
      )
      assert.deepEqual(many.errors?.map((error) => error.path), ["compartments"])
    })

    test("answers 404 for another company's vehicle and one in a project the caller does not work in, and refuses a role that may view but not edit", async () => {
      await refused(await olivia(`/vehicles/${theirVehicle.id}/compartments`, { method: "PUT", body: { compartments: [] } }), 404)
      assert.equal((await one(other, theirVehicle.id)).compartments.length, 1)
      const elsewhere = await vehicle({ projectId: a.projects.harbor.id })
      await refused(await viewer(`/vehicles/${elsewhere.id}/compartments`, { method: "PUT", body: { compartments: [] } }), 404)
      const created = await vehicle()
      assert.match((await refused(await ungranted(`/vehicles/${created.id}/compartments`, { method: "PUT", body: { compartments: [] } }), 403)).detail ?? "", /edit on fleet\.vehicles/)
    })
  })

  describe("requireVehicle", () => {
    /** What the helper refuses with: a 400 on the body, one error at the path given. */
    const refusal = (path: string, message: string) => (error: unknown) => {
      assert.ok(error instanceof ProblemError, String(error))
      assert.equal(error.body.status, 400)
      assert.deepEqual(error.body.errors, [{ path, message }])
      return true
    }

    test("holds a vehicle to the project and, when one is demanded, to the kind, each with its own sentence, and answers the row's status", async () => {
      const truck = await vehicle()
      const trailer = await vehicle({ kind: "trailer", requiredLicenceClass: "ce", compartments: [] })
      const elsewhere = await vehicle({ projectId: a.projects.harbor.id })
      const retired = await vehicle({ status: "retired" })
      const scope = { companyId: a.companyId, projectId: a.projects.copenhagen.id }
      await withCompany(pool.db, a.companyId, async (tx) => {
        assert.equal(await requireVehicle(tx, scope, truck.id), "active", "the status, for the doors that gate a new reference on it")
        assert.equal(await requireVehicle(tx, scope, retired.id), "retired", "found, and retired: whether that will do is the caller's rule")
        await requireVehicle(tx, scope, truck.id, { kind: "powered-vehicle" })
        await requireVehicle(tx, scope, trailer.id, { path: "trailerId" })
        assert.equal(await requireVehicle(tx, scope, trailer.id, { kind: "trailer", path: "trailerId" }), "active")
        assert.equal(await requireVehicle(tx, scope, null, { kind: "trailer" }), undefined, "nothing named, nothing to answer")
        assert.equal(await requireVehicle(tx, scope, undefined), undefined)

        await assert.rejects(requireVehicle(tx, scope, trailer.id, { kind: "powered-vehicle" }), refusal("vehicleId", NOT_A_POWERED_VEHICLE), "a trailer offered where a powered vehicle is required")
        await assert.rejects(requireVehicle(tx, scope, truck.id, { kind: "trailer", path: "trailerId" }), refusal("trailerId", NOT_A_TRAILER), "a powered vehicle offered as a trailer")
        await assert.rejects(requireVehicle(tx, scope, elsewhere.id), refusal("vehicleId", NOT_A_VEHICLE), "another project's")
        await assert.rejects(requireVehicle(tx, scope, elsewhere.id, { kind: "powered-vehicle" }), refusal("vehicleId", NOT_A_POWERED_VEHICLE), "another project's, asked for by kind")
        await assert.rejects(requireVehicle(tx, scope, theirVehicle.id), refusal("vehicleId", NOT_A_VEHICLE), "another company's")
        await assert.rejects(requireVehicle(tx, scope, testId(), { path: "collectionGroups.0.vehicleId" }), refusal("collectionGroups.0.vehicleId", NOT_A_VEHICLE), "nobody's, at the path given")
      })
    })
  })
})
