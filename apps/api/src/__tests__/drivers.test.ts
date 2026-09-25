import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { WasteFraction } from "@waste/contracts/catalogue"
import { Driver, PROVIDER_WITH_PROVIDER_EMPLOYMENT, Vehicle } from "@waste/contracts/fleet"
import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { RouteScheme } from "@waste/contracts/route-schemes"
import { createDb, type Database } from "@waste/db/client"
import { vehicleAllocation } from "@waste/db/schema/allocations"
import { collectionGroup } from "@waste/db/schema/route-schemes"
import { withCompany } from "@waste/db/tenant"
import { and, eq } from "drizzle-orm"

import { createApp } from "../app"
import { ProblemError } from "../problem"
import { NOT_A_DRIVER, NOT_A_USER_ACCOUNT, requireDriver } from "../routes/references"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { nextMillisecond } from "./clock"
import { databaseUnderTest } from "./database"
import { seedFleet, type FleetFixtures } from "./fleet-fixtures"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const DriverPage = Page(Driver)

const MODULE = "fleet.drivers"

describe("the driver endpoints", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  /** The company under test. */
  let a: Tenant
  /** The other company, written to once below and never again. */
  let b: Tenant
  let fleet: FleetFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted view, create and edit, with Project Access to Copenhagen Central only. */
  let viewer: Call
  /** The Service Provider Manager, whose charter grants the fleet in full: a role that reaches no project of the company. */
  let lars: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call

  /** The other company's. */
  let theirDriver: Driver

  /** Every workforce reference is one driver's across the company, so each test that gives one takes the next. */
  let references = 0
  const reference = () => `EMP-${String(++references).padStart(4, "0")}`

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create", "edit"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)

    theirDriver = await create(other, "/drivers", { projectId: b.projects.copenhagen.id, name: "Someone Else", employment: "employee", userAccountId: b.users.lars.id }, Driver)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }

  /** A driver body a caller may send: the fields with no default, an employee of Copenhagen Central. */
  const body = (name: string, values: Record<string, unknown> = {}) => ({
    projectId: a.projects.copenhagen.id,
    name,
    employment: "employee",
    ...values,
  })

  const create = async <T extends { id: string }>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> =>
    created(call, path, await call(path, { method: "POST", body: values }), schema)
  const driver = (name: string, values: Record<string, unknown> = {}) => create(olivia, "/drivers", body(name, values), Driver)
  const one = async (call: Call, id: string): Promise<Driver> => {
    const response = await call(`/drivers/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Driver.parse(await response.json())
  }
  const patch = async (call: Call, id: string, values: unknown): Promise<Driver> => {
    const response = await call(`/drivers/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Driver.parse(await response.json())
  }
  const page = async (call: Call, query = "") => DriverPage.parse(await (await call(`/drivers${query}`)).json())
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const post = (values: unknown) => olivia("/drivers", { method: "POST", body: values })

  describe("POST /drivers", () => {
    test("mints the id, defaults the status to active, and leaves everything else null until it is told otherwise", async () => {
      const created = await driver("Jonas Lind")
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.equal(created.projectId, a.projects.copenhagen.id)
      assert.deepEqual([created.name, created.employment, created.status], ["Jonas Lind", "employee", "active"])
      assert.deepEqual(
        [created.workforceReference, created.serviceProviderId, created.homeDepotId, created.licenceClass, created.licenceNumber, created.licenceExpiry, created.userAccountId, created.notes],
        [null, null, null, null, null, null, null, null],
        "no reference, no provider, no depot, no licence on record — eligible for nothing — no login, no notes",
      )
      assert.deepEqual(await one(olivia, created.id), created, "what the write answered is what the next read says")
    })

    test("takes the licence as a class, a number and the last day it holds, and the login as an account of this company", async () => {
      const created = await driver("Mads Jensen", {
        workforceReference: reference(),
        homeDepotId: fleet.depots.nordhavn.id,
        licenceClass: "ce",
        licenceNumber: "DK-1234567",
        licenceExpiry: "2031-05-17",
        userAccountId: a.users.viewer.id,
        status: "suspended",
        notes: "Crane certified",
      })
      assert.deepEqual([created.licenceClass, created.licenceNumber, created.licenceExpiry], ["ce", "DK-1234567", "2031-05-17"])
      assert.deepEqual([created.homeDepotId, created.userAccountId, created.status, created.notes], [fleet.depots.nordhavn.id, a.users.viewer.id, "suspended", "Crane certified"])
      const invited = await driver("New Colleague", { userAccountId: a.users.invited.id })
      assert.equal(invited.userAccountId, a.users.invited.id, "an account that has not signed in yet is still a login to register")
    })

    test("refuses a class outside the vocabulary and an expiry that is not a calendar day", async () => {
      const cls = await refused(await post(body("Class", { licenceClass: "CE" })), 400)
      assert.deepEqual(cls.errors?.map((error) => error.path), ["licenceClass"], "the token is lowercase; the display spelling is the adapter's")
      const day = await refused(await post(body("Day", { licenceExpiry: "2031-5-17" })), 400)
      assert.deepEqual(day.errors?.map((error) => error.path), ["licenceExpiry"])
      const instant = await refused(await post(body("Instant", { licenceExpiry: "2031-05-17T00:00:00Z" })), 400)
      assert.deepEqual(instant.errors?.map((error) => error.path), ["licenceExpiry"], "a day, not an instant")
    })

    test("holds the provider to the employment, in the driver's words, and to this company", async () => {
      const unemployed = await refused(await post(body("Unemployed", { employment: "service-provider" })), 400)
      assert.deepEqual(unemployed.errors, [{ path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_EMPLOYMENT }])
      const employed = await refused(await post(body("Employed", { serviceProviderId: a.serviceProviders.nordren.id })), 400)
      assert.deepEqual(employed.errors, [{ path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_EMPLOYMENT }], "an employee has no employing provider")
      const foreign = await refused(await post(body("Foreign", { employment: "service-provider", serviceProviderId: b.serviceProviders.nordren.id })), 400)
      assert.deepEqual(foreign.errors, [{ path: "serviceProviderId", message: "Not a service provider of this company" }])
      const contracted = await driver("Contracted", { employment: "service-provider", serviceProviderId: a.serviceProviders.nordren.id })
      assert.deepEqual([contracted.employment, contracted.serviceProviderId], ["service-provider", a.serviceProviders.nordren.id])
    })

    test("holds the home depot to the project and the login to an account of this company that is not deactivated", async () => {
      const depot = await refused(await post(body("Elsewhere", { homeDepotId: fleet.depots.harbor.id })), 400)
      assert.deepEqual(depot.errors, [{ path: "homeDepotId", message: "Not a depot of this project" }])
      const theirs = await refused(await post(body("Their login", { userAccountId: b.users.olivia.id })), 400)
      assert.deepEqual(theirs.errors, [{ path: "userAccountId", message: NOT_A_USER_ACCOUNT }])
      const gone = await refused(await post(body("Former", { userAccountId: a.users.deactivated.id })), 400)
      assert.deepEqual(gone.errors, [{ path: "userAccountId", message: NOT_A_USER_ACCOUNT }], "a deactivated account is no login to drive under")
      const nobody = await refused(await post(body("Nobody", { userAccountId: testId() })), 400)
      assert.deepEqual(nobody.errors, [{ path: "userAccountId", message: NOT_A_USER_ACCOUNT }])
    })

    test("refuses a second driver on one login, and a workforce reference the company already holds, whatever project it is in", async () => {
      await driver("Olivia driving", { userAccountId: a.users.olivia.id })
      const twice = await refused(await post(body("Olivia again", { userAccountId: a.users.olivia.id, projectId: a.projects.harbor.id })), 409)
      assert.equal(twice.detail, "That login already has a driver profile")
      assert.doesNotMatch(twice.detail ?? "", /_idx/)

      const held = reference()
      await driver("Referenced", { workforceReference: held })
      const taken = await refused(await post(body("Referenced again", { workforceReference: held, projectId: a.projects.harbor.id })), 409)
      assert.equal(taken.detail, `This company already has a driver with the workforce reference ${held}`)
      assert.doesNotMatch(taken.detail ?? "", /_idx/)
      const first = await driver("Unreferenced")
      const second = await driver("Unreferenced too")
      assert.deepEqual([first.workforceReference, second.workforceReference], [null, null], "a null is not a duplicate of another null")
    })

    test("refuses a project the caller does not work in, and a member the server owns", async () => {
      const foreign = await refused(await post(body("Theirs", { projectId: b.projects.copenhagen.id })), 400)
      assert.deepEqual(foreign.errors, [{ path: "projectId", message: "Not a project this account works in" }])
      const provider = await refused(await lars("/drivers", { method: "POST", body: body("Lars's hire") }), 400)
      assert.deepEqual(provider.errors, [{ path: "projectId", message: "Not a project this account works in" }], "a service provider's account works in no project, whatever its charter grants")
      const owned = await refused(await post(body("Client minted", { id: testId() })), 400)
      assert.ok(owned.errors?.some((error) => /id/.test(error.message)), JSON.stringify(owned.errors))
    })

    test("refuses a role without create on the module", async () => {
      const problem = await refused(await ungranted("/drivers", { method: "POST", body: body("Not mine") }), 403)
      assert.match(problem.detail ?? "", /create on fleet\.drivers/)
    })
  })

  describe("GET /drivers", () => {
    test("answers the company's drivers in id order and holds nothing of another company's", async () => {
      const mine = await driver("Listed")
      const { items } = await page(olivia, "?limit=200")
      const ids = items.map((row) => row.id)
      assert.ok(ids.includes(mine.id))
      assert.deepEqual(ids, [...ids].sort(), "ascending by id")
      assert.ok(!ids.includes(theirDriver.id))
      assert.deepEqual(items.find((row) => row.id === mine.id), mine)
      assert.deepEqual((await page(other, "?limit=200")).items.map((row) => row.name), ["Someone Else"])
    })

    test("filters by project, status, licence class and home depot", async () => {
      const harbor = await driver("Harbor hand", { projectId: a.projects.harbor.id, homeDepotId: fleet.depots.harbor.id, licenceClass: "b" })
      const inactive = await driver("Left", { status: "inactive", licenceClass: "c" })

      const byProject = await page(olivia, `?limit=200&projectId=${a.projects.harbor.id}`)
      assert.ok(byProject.items.some((row) => row.id === harbor.id))
      for (const row of byProject.items) assert.equal(row.projectId, a.projects.harbor.id)
      const left = (await page(olivia, "?limit=200&status=inactive")).items
      assert.ok(left.some((row) => row.id === inactive.id))
      for (const row of left) assert.equal(row.status, "inactive")
      const classB = (await page(olivia, "?limit=200&licenceClass=b")).items
      assert.ok(classB.some((row) => row.id === harbor.id))
      assert.ok(!classB.some((row) => row.id === inactive.id), "exactly that class, not the ones that cover it")
      for (const row of classB) assert.equal(row.licenceClass, "b")
      const based = (await page(olivia, `?limit=200&homeDepotId=${fleet.depots.harbor.id}`)).items
      assert.ok(based.some((row) => row.id === harbor.id))
      for (const row of based) assert.equal(row.homeDepotId, fleet.depots.harbor.id)
      const bad = await refused(await olivia("/drivers?licenceClass=CE"), 400)
      assert.deepEqual(bad.errors?.map((error) => error.path), ["licenceClass"])
    })

    test("shows an account only the projects it works in, and answers an empty page to one that works in none", async () => {
      const here = await driver("Seen")
      const elsewhere = await driver("Unseen", { projectId: a.projects.harbor.id })
      const seen = (await page(viewer, "?limit=200")).items
      assert.ok(seen.some((row) => row.id === here.id))
      assert.ok(!seen.some((row) => row.id === elsewhere.id))
      for (const row of seen) assert.equal(row.projectId, a.projects.copenhagen.id)

      assert.deepEqual(await page(lars, "?limit=200"), { items: [], nextCursor: null })
      await refused(await lars(`/drivers/${here.id}`), 404)

      const problem = await refused(await viewer(`/drivers?projectId=${a.projects.harbor.id}`), 400)
      assert.deepEqual(problem.errors, [{ path: "projectId", message: "Not a project this account works in" }])
    })

    test("pages by cursor without repeating or skipping a driver", async () => {
      const made = [await driver("Paged 1"), await driver("Paged 2"), await driver("Paged 3")].map((row) => row.id)
      const all = (await page(olivia, "?limit=200")).items.map((row) => row.id)
      const seen: string[] = []
      let cursor: string | null = null
      do {
        const current: Awaited<ReturnType<typeof page>> = await page(olivia, `?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`)
        assert.ok(current.items.length <= 2)
        seen.push(...current.items.map((row) => row.id))
        cursor = current.nextCursor
      } while (cursor !== null)
      assert.deepEqual(seen, all, "walking the pages visits every driver once, in id order")
      for (const id of made) assert.ok(seen.includes(id))
    })

    test("refuses a role without fleet.drivers view, and a caller with no token", async () => {
      assert.match((await refused(await ungranted("/drivers"), 403)).detail ?? "", /view on fleet\.drivers/)
      assert.equal((await app.request("/drivers")).status, 401)
    })
  })

  describe("GET /drivers/:id", () => {
    test("answers 404 for another company's driver, for one in a project the caller does not work in, and for an id nobody minted", async () => {
      const foreign = await refused(await olivia(`/drivers/${theirDriver.id}`), 404)
      assert.match(foreign.detail ?? "", /driver/i)
      assert.equal((await one(other, theirDriver.id)).name, "Someone Else", "still there for its own company")

      const elsewhere = await driver("Harbor only", { projectId: a.projects.harbor.id })
      await refused(await viewer(`/drivers/${elsewhere.id}`), 404)
      assert.equal((await one(olivia, elsewhere.id)).name, "Harbor only")
      await refused(await olivia(`/drivers/${testId()}`), 404)
      assert.deepEqual((await refused(await olivia("/drivers/not-a-uuid"), 400)).errors?.map((error) => error.path), ["id"])
    })
  })

  describe("PATCH /drivers/:id", () => {
    test("changes what the body names, leaves the rest, and moves the stamp; a licence renewal is an edit", async () => {
      const created = await driver("Renewed", { licenceClass: "c", licenceExpiry: "2026-12-31", homeDepotId: fleet.depots.nordhavn.id })
      await nextMillisecond()
      const changed = await patch(olivia, created.id, { licenceClass: "ce", licenceExpiry: "2031-12-31", licenceNumber: "DK-7654321", status: "suspended", notes: "Retraining" })
      assert.deepEqual([changed.licenceClass, changed.licenceExpiry, changed.licenceNumber, changed.status, changed.notes], ["ce", "2031-12-31", "DK-7654321", "suspended", "Retraining"])
      assert.deepEqual([changed.name, changed.homeDepotId, changed.employment], ["Renewed", fleet.depots.nordhavn.id, "employee"], "what the patch did not name it did not touch")
      assert.ok(changed.updatedAt > created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), changed)

      const cleared = await patch(olivia, created.id, { licenceClass: null, licenceExpiry: null, licenceNumber: null, homeDepotId: null, notes: null })
      assert.deepEqual([cleared.licenceClass, cleared.licenceExpiry, cleared.licenceNumber, cleared.homeDepotId, cleared.notes], [null, null, null, null, null], "a null takes each back; no class on record is eligible for nothing")
    })

    test("holds the provider rule against the merged row, in the driver's words", async () => {
      const created = await driver("Moving")
      const unemployed = await refused(await olivia(`/drivers/${created.id}`, { method: "PATCH", body: { employment: "service-provider" } }), 400)
      assert.deepEqual(unemployed.errors, [{ path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_EMPLOYMENT }], "the stored row names no provider")
      const employed = await refused(await olivia(`/drivers/${created.id}`, { method: "PATCH", body: { serviceProviderId: a.serviceProviders.nordren.id } }), 400)
      assert.deepEqual(employed.errors, [{ path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_EMPLOYMENT }], "the stored row is an employee's")
      const contracted = await patch(olivia, created.id, { employment: "service-provider", serviceProviderId: a.serviceProviders.nordren.id })
      assert.deepEqual([contracted.employment, contracted.serviceProviderId], ["service-provider", a.serviceProviders.nordren.id])
      const kept = await refused(await olivia(`/drivers/${created.id}`, { method: "PATCH", body: { employment: "temporary" } }), 400)
      assert.deepEqual(kept.errors?.map((error) => error.path), ["serviceProviderId"], "the stored provider now has no employment to belong to")
      const temporary = await patch(olivia, created.id, { employment: "temporary", serviceProviderId: null })
      assert.deepEqual([temporary.employment, temporary.serviceProviderId], ["temporary", null])
    })

    test("holds a new provider, depot and login to the scope their keys allow, and one login to one profile", async () => {
      const created = await driver("Rebound")
      const provider = await refused(
        await olivia(`/drivers/${created.id}`, { method: "PATCH", body: { employment: "service-provider", serviceProviderId: b.serviceProviders.nordren.id } }),
        400,
      )
      assert.deepEqual(provider.errors, [{ path: "serviceProviderId", message: "Not a service provider of this company" }])
      const depot = await refused(await olivia(`/drivers/${created.id}`, { method: "PATCH", body: { homeDepotId: fleet.depots.harbor.id } }), 400)
      assert.deepEqual(depot.errors, [{ path: "homeDepotId", message: "Not a depot of this project" }])
      const gone = await refused(await olivia(`/drivers/${created.id}`, { method: "PATCH", body: { userAccountId: a.users.deactivated.id } }), 400)
      assert.deepEqual(gone.errors, [{ path: "userAccountId", message: NOT_A_USER_ACCOUNT }])

      const holder = await driver("Holder", { userAccountId: a.users.lars.id })
      const taken = await refused(await olivia(`/drivers/${created.id}`, { method: "PATCH", body: { userAccountId: a.users.lars.id } }), 409)
      assert.equal(taken.detail, "That login already has a driver profile")
      const released = await patch(olivia, holder.id, { userAccountId: null })
      assert.equal(released.userAccountId, null)
      const bound = await patch(olivia, created.id, { userAccountId: a.users.lars.id })
      assert.equal(bound.userAccountId, a.users.lars.id, "free again once the other profile let it go")
    })

    test("refuses inactive or suspended under live allocations or under collection groups of schemes in force, counting them, and takes either once they are released or reassigned", async () => {
      const held = await driver("Held Back", { licenceClass: "ce", licenceExpiry: "2031-12-31" })
      const residual = await create(olivia, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
      const scheme = await create(
        olivia,
        "/route-schemes",
        {
          projectId: a.projects.copenhagen.id,
          name: "Held's run",
          serviceType: "container-collection",
          frequency: "weekly",
          serviceDays: ["monday"],
          validFrom: "2026-01-01",
          collectionGroups: [{ name: "North", days: ["monday"], stopSource: "rule", rule: { wasteFractionIds: [residual.id], containerTypeIds: [], vehicleTypeId: null }, driverId: held.id }],
        },
        RouteScheme,
      )
      const [group] = scheme.collectionGroups
      const setStatus = (status: string) => olivia(`/drivers/${held.id}`, { method: "PATCH", body: { status } })
      const inactive = await refused(await setStatus("inactive"), 409)
      assert.equal(inactive.detail, "1 collection group names this driver; reassign it first", "a draft scheme in force counts")
      const suspended = await refused(await setStatus("suspended"), 409)
      assert.equal(suspended.detail, "1 collection group names this driver; reassign it first", "the same rule for both statuses")

      // A live allocation is counted first, in its own sentence; a vehicle of this test's own to hang it on.
      const truck = await create(
        olivia,
        "/vehicles",
        { projectId: a.projects.copenhagen.id, registration: "CN 77 001", kind: "powered-vehicle", vehicleTypeId: fleet.vehicleTypes.rearLoader.id, requiredLicenceClass: "c", compartments: [{ wasteFractionIds: [residual.id] }] },
        Vehicle,
      )
      const allocation = testId()
      const hour = 3_600_000
      await withCompany(pool.db, a.companyId, async (tx) => {
        await tx.insert(vehicleAllocation).values({ id: allocation, companyId: a.companyId, projectId: a.projects.copenhagen.id, vehicleId: truck.id, driverId: held.id, plannedFrom: new Date(Date.now() + hour), plannedTo: new Date(Date.now() + 2 * hour), status: "confirmed" })
      })
      assert.equal((await refused(await setStatus("inactive"), 409)).detail, "1 live allocation names this driver; release it first", "the allocations are counted before the groups")
      assert.equal((await one(olivia, held.id)).status, "active", "and the refused patches wrote nothing")
      await withCompany(pool.db, a.companyId, async (tx) => {
        await tx.update(vehicleAllocation).set({ status: "released" }).where(and(eq(vehicleAllocation.companyId, a.companyId), eq(vehicleAllocation.id, allocation)))
      })
      const reassigned = await olivia(`/collection-groups/${group.id}`, { method: "PATCH", body: { driverId: null } })
      assert.equal(reassigned.status, 200, JSON.stringify(await reassigned.clone().json()))
      const left = await patch(olivia, held.id, { status: "inactive" })
      assert.equal(left.status, "inactive", "released and reassigned, the driver leaves")

      // A driver already out of service is not asked again when moved between the two statuses, whatever names them by then.
      await withCompany(pool.db, a.companyId, async (tx) => {
        await tx.update(collectionGroup).set({ driverId: held.id }).where(and(eq(collectionGroup.companyId, a.companyId), eq(collectionGroup.id, group.id)))
      })
      assert.equal((await patch(olivia, held.id, { status: "suspended" })).status, "suspended")
      assert.equal((await patch(olivia, held.id, { status: "active" })).status, "active", "and coming back into service is a plain patch")
    })

    test("refuses a workforce reference another driver holds", async () => {
      const held = reference()
      await driver("Holding", { workforceReference: held })
      const created = await driver("Wanting")
      const problem = await refused(await olivia(`/drivers/${created.id}`, { method: "PATCH", body: { workforceReference: held } }), 409)
      assert.equal(problem.detail, `This company already has a driver with the workforce reference ${held}`)
      assert.equal((await one(olivia, created.id)).workforceReference, null)
    })

    test("refuses an empty patch, the project, another company's driver, one out of the caller's projects, and a role without edit on the module", async () => {
      const created = await driver("Untouched")
      assert.deepEqual((await refused(await olivia(`/drivers/${created.id}`, { method: "PATCH", body: {} }), 400)).errors?.map((error) => error.path), [""])
      const moved = await refused(await olivia(`/drivers/${created.id}`, { method: "PATCH", body: { projectId: a.projects.harbor.id } }), 400)
      assert.ok(moved.errors?.some((error) => /projectId/.test(error.message)), JSON.stringify(moved.errors))

      await refused(await olivia(`/drivers/${theirDriver.id}`, { method: "PATCH", body: { status: "inactive" } }), 404)
      assert.equal((await one(other, theirDriver.id)).status, "active")
      const elsewhere = await driver("Harbor's", { projectId: a.projects.harbor.id })
      await refused(await viewer(`/drivers/${elsewhere.id}`, { method: "PATCH", body: { status: "inactive" } }), 404)
      assert.match((await refused(await ungranted(`/drivers/${created.id}`, { method: "PATCH", body: { status: "inactive" } }), 403)).detail ?? "", /edit on fleet\.drivers/)
    })
  })

  describe("requireDriver", () => {
    test("holds a driver to the project, with its sentence, at the path given, and answers the row's status", async () => {
      const here = await driver("Here")
      const elsewhere = await driver("Elsewhere", { projectId: a.projects.harbor.id })
      const gone = await driver("Gone", { status: "inactive" })
      const scope = { companyId: a.companyId, projectId: a.projects.copenhagen.id }
      const refusal = (path: string) => (error: unknown) => {
        assert.ok(error instanceof ProblemError, String(error))
        assert.equal(error.body.status, 400)
        assert.deepEqual(error.body.errors, [{ path, message: NOT_A_DRIVER }])
        return true
      }
      await withCompany(pool.db, a.companyId, async (tx) => {
        assert.equal(await requireDriver(tx, scope, here.id), "active", "the status, for the doors that gate a new reference on it")
        assert.equal(await requireDriver(tx, scope, gone.id), "inactive", "found, and inactive: whether that will do is the caller's rule")
        assert.equal(await requireDriver(tx, scope, null), undefined, "nothing named, nothing to answer")
        await assert.rejects(requireDriver(tx, scope, elsewhere.id), refusal("driverId"), "another project's")
        await assert.rejects(requireDriver(tx, scope, theirDriver.id), refusal("driverId"), "another company's")
        await assert.rejects(requireDriver(tx, scope, testId(), "collectionGroups.0.driverId"), refusal("collectionGroups.0.driverId"), "nobody's, at the path given")
      })
    })
  })
})
