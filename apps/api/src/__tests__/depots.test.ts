import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import type { Point } from "@waste/contracts/geojson"
import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { BOTH_HOURS_OR_NEITHER, Depot, PROVIDER_WITH_PROVIDER_OWNERSHIP } from "@waste/contracts/places"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { nextMillisecond } from "./clock"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const DepotPage = Page(Depot)

const MODULE = "resources.depots"

/** Nordhavn, where a yard of this file stands until it is moved. */
const nordhavn: Point = { type: "Point", coordinates: [12.5977, 55.7083] }
/** Sydhavn, for a depot that moves. */
const sydhavn: Point = { type: "Point", coordinates: [12.5445, 55.6491] }

describe("the depot endpoints", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  /** The company under test. */
  let a: Tenant
  /** The other company, written to once below and never again. */
  let b: Tenant
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted view, create and edit, with Project Access to Copenhagen Central only. */
  let viewer: Call
  /** The Service Provider Manager, granted view: a role that reaches no project of the company. */
  let lars: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call
  /** The other company's. */
  let theirDepot: Depot

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create", "edit"] }])
    await grantRole(pool, a.companyId, a.roles.providerManager.id, [{ moduleKey: MODULE, actions: ["view"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)

    theirDepot = await create(other, body(b.projects.copenhagen.id, "DEP-THEIRS"))
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  /** A depot body a caller may send: the fields with no default, on the project named. */
  const body = (projectId: string, code: string, values: Record<string, unknown> = {}) => ({
    projectId,
    code,
    name: `Depot ${code}`,
    address: `${code}, Sundkrogsgade 1, 2100 København Ø`,
    location: nordhavn,
    ...values,
  })

  const create = async (call: Call, values: unknown): Promise<Depot> => {
    const response = await call("/depots", { method: "POST", body: values })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return Depot.parse(await response.json())
  }
  const depot = (code: string, values: Record<string, unknown> = {}) => create(olivia, body(a.projects.copenhagen.id, code, values))
  const one = async (call: Call, id: string): Promise<Depot> => {
    const response = await call(`/depots/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Depot.parse(await response.json())
  }
  const patch = async (call: Call, id: string, values: unknown): Promise<Depot> => {
    const response = await call(`/depots/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Depot.parse(await response.json())
  }
  const page = async (call: Call, query = "") => {
    const response = await call(`/depots${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return DepotPage.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const paths = (problem: { errors?: { path: string }[] }) => problem.errors?.map((error) => error.path)

  describe("POST /depots", () => {
    test("mints the id, defaults the ownership to the company and the status to active, stands where the body puts it, and keeps no hours until told", async () => {
      const created = await depot("DEP-NORD", { name: "Nordhavn" })
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.equal(created.projectId, a.projects.copenhagen.id)
      assert.deepEqual([created.code, created.name], ["DEP-NORD", "Nordhavn"])
      assert.equal(created.ownership, "company", "a depot the company runs is the common case")
      assert.equal(created.serviceProviderId, null)
      assert.equal(created.status, "active", "a depot is registered because routes already leave from it")
      assert.deepEqual(created.location, nordhavn, "a route departs from a point")
      assert.deepEqual([created.opensAt, created.closesAt, created.vehicleCapacity, created.notes], [null, null, null, null])
      assert.deepEqual(await one(olivia, created.id), created)
    })

    test("takes the hours as HH:MM and reads them back without Postgres's seconds, an overnight window included, with the capacity and the notes", async () => {
      const created = await depot("DEP-HOURS", { opensAt: "05:30", closesAt: "18:00", vehicleCapacity: 24, notes: "Gate code 4711", status: "seasonal" })
      assert.deepEqual([created.opensAt, created.closesAt], ["05:30", "18:00"])
      assert.equal(created.vehicleCapacity, 24)
      assert.equal(created.notes, "Gate code 4711")
      assert.equal(created.status, "seasonal")
      assert.deepEqual(await one(olivia, created.id), created)
      const overnight = await depot("DEP-NIGHT", { opensAt: "22:00", closesAt: "05:00" })
      assert.deepEqual([overnight.opensAt, overnight.closesAt], ["22:00", "05:00"], "an overnight window is two times and allowed")
    })

    test("takes a provider's depot naming its provider, and refuses the ownership and the provider disagreeing in the contracts' words", async () => {
      const created = await depot("DEP-NORDREN", { ownership: "service-provider", serviceProviderId: a.serviceProviders.nordren.id })
      assert.equal(created.ownership, "service-provider")
      assert.equal(created.serviceProviderId, a.serviceProviders.nordren.id)

      const unnamed = await refused(await olivia("/depots", { method: "POST", body: body(a.projects.copenhagen.id, "DEP-SHAPE", { ownership: "service-provider" }) }), 400)
      assert.deepEqual(unnamed.errors, [{ path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP }])
      const owned = await refused(await olivia("/depots", { method: "POST", body: body(a.projects.copenhagen.id, "DEP-SHAPE", { serviceProviderId: a.serviceProviders.nordren.id }) }), 400)
      assert.deepEqual(owned.errors, [{ path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP }], "company ownership names no provider")
      const foreign = await refused(
        await olivia("/depots", { method: "POST", body: body(a.projects.copenhagen.id, "DEP-SHAPE", { ownership: "service-provider", serviceProviderId: b.serviceProviders.nordren.id }) }),
        400,
      )
      assert.deepEqual(foreign.errors, [{ path: "serviceProviderId", message: "Not a service provider of this company" }])
    })

    test("refuses one opening time without the other, a capacity of nothing, a missing place, one off the globe, and a member the server owns", async () => {
      const half = await refused(await olivia("/depots", { method: "POST", body: body(a.projects.copenhagen.id, "DEP-HALF", { opensAt: "06:00" }) }), 400)
      assert.deepEqual(half.errors, [{ path: "closesAt", message: BOTH_HOURS_OR_NEITHER }])
      assert.deepEqual(paths(await refused(await olivia("/depots", { method: "POST", body: body(a.projects.copenhagen.id, "DEP-HALF", { vehicleCapacity: 0 }) }), 400)), ["vehicleCapacity"])
      assert.deepEqual(paths(await refused(await olivia("/depots", { method: "POST", body: body(a.projects.copenhagen.id, "DEP-HALF", { location: undefined }) }), 400)), ["location"])
      const offTheGlobe = await refused(
        await olivia("/depots", { method: "POST", body: body(a.projects.copenhagen.id, "DEP-HALF", { location: { type: "Point", coordinates: [200, 55.7083] } }) }),
        400,
      )
      assert.deepEqual(paths(offTheGlobe), ["location.coordinates.0"])
      const owned = await refused(await olivia("/depots", { method: "POST", body: body(a.projects.copenhagen.id, "DEP-HALF", { id: testId() }) }), 400)
      assert.ok(owned.errors?.some((error) => /id/.test(error.message)), JSON.stringify(owned.errors))
      assert.equal((await page(olivia, "?limit=200")).items.some((row) => row.code === "DEP-HALF"), false, "nothing was written")
    })

    test("refuses a project the caller does not work in, naming the field", async () => {
      const foreign = await refused(await olivia("/depots", { method: "POST", body: body(b.projects.copenhagen.id, "DEP-FOREIGN") }), 400)
      assert.deepEqual(foreign.errors, [{ path: "projectId", message: "Not a project this account works in" }])
      const narrow = await refused(await viewer("/depots", { method: "POST", body: body(a.projects.harbor.id, "DEP-NARROW") }), 400)
      assert.deepEqual(narrow.errors, [{ path: "projectId", message: "Not a project this account works in" }])
      assert.equal((await create(viewer, body(a.projects.copenhagen.id, "DEP-VERA"))).projectId, a.projects.copenhagen.id)
    })

    test("refuses a code and a name the project already uses, each with its own sentence, and lets another project use them", async () => {
      await depot("DEP-EAST", { name: "Østhavn" })
      const code = await refused(await olivia("/depots", { method: "POST", body: body(a.projects.copenhagen.id, "DEP-EAST", { name: "Something else" }) }), 409)
      assert.equal(code.detail, 'This project already has a depot coded "DEP-EAST"')
      const name = await refused(await olivia("/depots", { method: "POST", body: body(a.projects.copenhagen.id, "DEP-EAST-2", { name: "Østhavn" }) }), 409)
      assert.equal(name.detail, 'This project already has a depot called "Østhavn"')
      assert.doesNotMatch(`${code.detail}${name.detail}`, /_key/)
      const harbor = await create(olivia, body(a.projects.harbor.id, "DEP-EAST", { name: "Østhavn" }))
      assert.equal(harbor.code, "DEP-EAST", "a code is one depot's inside a project, and free in the next")
    })

    test("refuses a role that may view but not create", async () => {
      const problem = await refused(await lars("/depots", { method: "POST", body: body(a.projects.copenhagen.id, "DEP-LARS") }), 403)
      assert.match(problem.detail ?? "", /create on resources\.depots/)
    })
  })

  describe("GET /depots", () => {
    test("answers the company's depots in id order and holds nothing of another company's", async () => {
      const mine = await depot("DEP-10")
      const ids = (await page(olivia, "?limit=200")).items.map((row) => row.id)
      assert.ok(ids.includes(mine.id))
      assert.deepEqual(ids, [...ids].sort(), "ascending by id")
      assert.ok(!ids.includes(theirDepot.id))
      assert.deepEqual((await page(other, "?limit=200")).items.map((row) => row.code), ["DEP-THEIRS"])
    })

    test("filters by project and by status", async () => {
      const harbor = await create(olivia, body(a.projects.harbor.id, "DEP-11", { status: "closed" }))
      const byProject = await page(olivia, `?limit=200&projectId=${a.projects.harbor.id}`)
      assert.ok(byProject.items.some((row) => row.id === harbor.id))
      for (const row of byProject.items) assert.equal(row.projectId, a.projects.harbor.id)

      const byStatus = await page(olivia, "?limit=200&status=closed")
      assert.ok(byStatus.items.some((row) => row.id === harbor.id))
      for (const row of byStatus.items) assert.equal(row.status, "closed")
      assert.deepEqual(paths(await refused(await olivia("/depots?status=open"), 400)), ["status"])
    })

    test("shows an account only the projects it works in, and answers an empty page to one that works in none", async () => {
      const here = await depot("DEP-12")
      const elsewhere = await create(olivia, body(a.projects.harbor.id, "DEP-12"))
      const seen = (await page(viewer, "?limit=200")).items
      assert.ok(seen.some((row) => row.id === here.id))
      assert.ok(!seen.some((row) => row.id === elsewhere.id))
      for (const row of seen) assert.equal(row.projectId, a.projects.copenhagen.id)

      assert.deepEqual(await page(lars, "?limit=200"), { items: [], nextCursor: null }, "a service provider's account works in no project and reads none of this")
      const problem = await refused(await viewer(`/depots?projectId=${a.projects.harbor.id}`), 400)
      assert.deepEqual(problem.errors, [{ path: "projectId", message: "Not a project this account works in" }])
    })

    test("refuses a role without resources.depots view, and a caller with no token", async () => {
      assert.match((await refused(await ungranted("/depots"), 403)).detail ?? "", /view on resources\.depots/)
      assert.equal((await app.request("/depots")).status, 401)
    })
  })

  describe("GET /depots/:id", () => {
    test("answers 404 for another company's, for one in a project the caller does not work in, and for an id nobody minted", async () => {
      const foreign = await refused(await olivia(`/depots/${theirDepot.id}`), 404)
      assert.match(foreign.detail ?? "", /depot/i)
      assert.deepEqual(await one(other, theirDepot.id), theirDepot, "still there for its own company")

      const elsewhere = await create(olivia, body(a.projects.harbor.id, "DEP-20"))
      await refused(await viewer(`/depots/${elsewhere.id}`), 404)
      await refused(await lars(`/depots/${elsewhere.id}`), 404)
      assert.equal((await one(olivia, elsewhere.id)).code, "DEP-20")
      await refused(await olivia(`/depots/${testId()}`), 404)
      assert.deepEqual(paths(await refused(await olivia("/depots/not-a-uuid"), 400)), ["id"])
    })
  })

  describe("PATCH /depots/:id", () => {
    test("changes what the body names, moves the place, leaves the code, and moves the stamp", async () => {
      const created = await depot("DEP-30", { opensAt: "06:00", closesAt: "16:00", vehicleCapacity: 12 })
      await nextMillisecond()
      const changed = await patch(olivia, created.id, { name: "Sydhavn", location: sydhavn, status: "seasonal", vehicleCapacity: 18, notes: "Summer only" })
      assert.deepEqual([changed.code, changed.name, changed.status, changed.vehicleCapacity, changed.notes], ["DEP-30", "Sydhavn", "seasonal", 18, "Summer only"])
      assert.deepEqual(changed.location, sydhavn, "the place moved")
      assert.deepEqual([changed.opensAt, changed.closesAt], ["06:00", "16:00"], "what the patch did not name it did not touch")
      assert.ok(changed.updatedAt > created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), changed)

      const cleared = await patch(olivia, created.id, { opensAt: null, closesAt: null, vehicleCapacity: null, notes: null })
      assert.deepEqual([cleared.opensAt, cleared.closesAt, cleared.vehicleCapacity, cleared.notes], [null, null, null, null], "both hours go together, and a null clears the rest")
      const reopened = await patch(olivia, created.id, { opensAt: "07:00", closesAt: "15:00" })
      assert.deepEqual([reopened.opensAt, reopened.closesAt], ["07:00", "15:00"], "and both come back together")
    })

    test("holds the patch against the stored row: half a pair is refused in the contracts' words, and the whole pair is taken", async () => {
      const created = await depot("DEP-31", { opensAt: "06:00", closesAt: "16:00" })
      const halfOff = await refused(await olivia(`/depots/${created.id}`, { method: "PATCH", body: { opensAt: null } }), 400)
      assert.deepEqual(halfOff.errors, [{ path: "closesAt", message: BOTH_HOURS_OR_NEITHER }], "taking one time off leaves the other alone")
      const unhoured = await depot("DEP-32")
      const halfOn = await refused(await olivia(`/depots/${unhoured.id}`, { method: "PATCH", body: { closesAt: "16:00" } }), 400)
      assert.deepEqual(halfOn.errors, [{ path: "closesAt", message: BOTH_HOURS_OR_NEITHER }], "giving one time gives the other none")
      assert.equal((await patch(olivia, unhoured.id, { opensAt: "06:00", closesAt: "16:00" })).opensAt, "06:00")
      assert.equal((await patch(olivia, created.id, { closesAt: "17:00" })).closesAt, "17:00", "moving one time of a pair the row already has is fine")

      const owned = await refused(await olivia(`/depots/${created.id}`, { method: "PATCH", body: { ownership: "service-provider" } }), 400)
      assert.deepEqual(owned.errors, [{ path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP }], "a company depot made a provider's names no provider")
      const named = await refused(await olivia(`/depots/${created.id}`, { method: "PATCH", body: { serviceProviderId: a.serviceProviders.nordren.id } }), 400)
      assert.deepEqual(named.errors, [{ path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP }], "a company depot naming a provider stays the company's")
      const handedOver = await patch(olivia, created.id, { ownership: "service-provider", serviceProviderId: a.serviceProviders.cityhaul.id })
      assert.deepEqual([handedOver.ownership, handedOver.serviceProviderId], ["service-provider", a.serviceProviders.cityhaul.id], "both halves together are taken")
      const takenBack = await refused(await olivia(`/depots/${created.id}`, { method: "PATCH", body: { ownership: "company" } }), 400)
      assert.deepEqual(takenBack.errors, [{ path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP }], "and taking the ownership back leaves the provider named")
      assert.equal((await patch(olivia, created.id, { ownership: "company", serviceProviderId: null })).serviceProviderId, null)
      const foreign = await refused(await olivia(`/depots/${created.id}`, { method: "PATCH", body: { ownership: "service-provider", serviceProviderId: b.serviceProviders.nordren.id } }), 400)
      assert.deepEqual(foreign.errors, [{ path: "serviceProviderId", message: "Not a service provider of this company" }])
    })

    test("lists every rule a patch breaks in one 400: the provider's existence, then the two shape rules", async () => {
      const created = await depot("DEP-37", { opensAt: "06:00", closesAt: "16:00" })
      const both = await refused(await olivia(`/depots/${created.id}`, { method: "PATCH", body: { ownership: "service-provider", opensAt: null } }), 400)
      assert.deepEqual(
        both.errors,
        [
          { path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP },
          { path: "closesAt", message: BOTH_HOURS_OR_NEITHER },
        ],
        "a client mending one is told about the other now, not on its next try",
      )
      const foreignAndHalf = await refused(
        await olivia(`/depots/${created.id}`, { method: "PATCH", body: { ownership: "service-provider", serviceProviderId: b.serviceProviders.nordren.id, opensAt: null } }),
        400,
      )
      assert.deepEqual(
        foreignAndHalf.errors,
        [
          { path: "serviceProviderId", message: "Not a service provider of this company" },
          { path: "closesAt", message: BOTH_HOURS_OR_NEITHER },
        ],
        "a foreign provider and broken hours are one round trip: the existence check is listed with the shape rules",
      )
      const unchanged = await one(olivia, created.id)
      assert.deepEqual([unchanged.ownership, unchanged.serviceProviderId, unchanged.opensAt, unchanged.closesAt], ["company", null, "06:00", "16:00"], "nothing written")
    })

    test("refuses clearing the place, the code, the project, an empty patch, and a point off the globe", async () => {
      const created = await depot("DEP-33")
      const unplaced = await refused(await olivia(`/depots/${created.id}`, { method: "PATCH", body: { location: null } }), 400)
      assert.deepEqual(paths(unplaced), ["location"], "a route departs from a point, so the place may move but not go")
      const code = await refused(await olivia(`/depots/${created.id}`, { method: "PATCH", body: { code: "DEP-34" } }), 400)
      assert.ok(code.errors?.some((error) => /code/.test(error.message)), JSON.stringify(code.errors))
      const moved = await refused(await olivia(`/depots/${created.id}`, { method: "PATCH", body: { projectId: a.projects.harbor.id } }), 400)
      assert.ok(moved.errors?.some((error) => /projectId/.test(error.message)), JSON.stringify(moved.errors))
      assert.deepEqual(paths(await refused(await olivia(`/depots/${created.id}`, { method: "PATCH", body: {} }), 400)), [""])
      assert.deepEqual(paths(await refused(await olivia(`/depots/${created.id}`, { method: "PATCH", body: { location: { type: "Point", coordinates: [12.5977, -91] } } }), 400)), ["location.coordinates.1"])
      assert.deepEqual(await one(olivia, created.id), created, "a refused patch changes nothing")
    })

    test("refuses a rename onto a name the project already uses, and changes nothing", async () => {
      await depot("DEP-35", { name: "Taken already" })
      const created = await depot("DEP-36", { name: "Free to rename" })
      const problem = await refused(await olivia(`/depots/${created.id}`, { method: "PATCH", body: { name: "Taken already" } }), 409)
      assert.equal(problem.detail, 'This project already has a depot called "Taken already"')
      assert.equal((await one(olivia, created.id)).name, "Free to rename")
    })

    test("refuses another company's depot, one out of the caller's projects, an id nobody minted, and a role that may view but not edit", async () => {
      await refused(await olivia(`/depots/${theirDepot.id}`, { method: "PATCH", body: { name: "Mine now" } }), 404)
      assert.equal((await one(other, theirDepot.id)).name, "Depot DEP-THEIRS")
      const elsewhere = await create(olivia, body(a.projects.harbor.id, "DEP-37"))
      await refused(await viewer(`/depots/${elsewhere.id}`, { method: "PATCH", body: { name: "Mine now" } }), 404)
      const unminted = await refused(await olivia(`/depots/${testId()}`, { method: "PATCH", body: { ownership: "service-provider" } }), 404)
      assert.match(unminted.detail ?? "", /depot/i, "the row is read before the patch is held against it, so an id nobody minted is the 404 it is everywhere else")
      assert.match((await refused(await lars(`/depots/${elsewhere.id}`, { method: "PATCH", body: { name: "x" } }), 403)).detail ?? "", /edit on resources\.depots/)
    })
  })
})
