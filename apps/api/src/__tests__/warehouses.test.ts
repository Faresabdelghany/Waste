import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import type { Point } from "@waste/contracts/geojson"
import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { Depot, Warehouse } from "@waste/contracts/places"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { nextMillisecond } from "./clock"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const WarehousePage = Page(Warehouse)

const MODULE = "resources.warehouses"

/** Nordhavn, where a yard of this file stands until it is moved. */
const nordhavn: Point = { type: "Point", coordinates: [12.5977, 55.7083] }
/** Sydhavn, for a warehouse that moves. */
const sydhavn: Point = { type: "Point", coordinates: [12.5445, 55.6491] }

describe("the warehouse endpoints", { skip: database.skip }, () => {
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

  /** A depot of Copenhagen Central, which a warehouse of that project may share a yard with. */
  let nordhavnDepot: Depot
  /** A depot of this company in another project: not a Copenhagen warehouse's to name. */
  let pierDepot: Depot
  /** The other company's. */
  let theirDepot: Depot
  let theirWarehouse: Warehouse

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

    nordhavnDepot = await create(olivia, "/depots", depotBody(a.projects.copenhagen.id, "DEP-NORD"), Depot)
    pierDepot = await create(olivia, "/depots", depotBody(a.projects.harbor.id, "DEP-PIER"), Depot)
    theirDepot = await create(other, "/depots", depotBody(b.projects.copenhagen.id, "DEP-THEIRS"), Depot)
    theirWarehouse = await create(other, "/warehouses", body(b.projects.copenhagen.id, "WH-THEIRS"), Warehouse)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }

  /** A warehouse body a caller may send: the fields with no default, on the project named. */
  const body = (projectId: string, code: string, values: Record<string, unknown> = {}) => ({
    projectId,
    code,
    name: `Warehouse ${code}`,
    address: `${code}, Sundkrogsgade 1, 2100 København Ø`,
    ...values,
  })
  const depotBody = (projectId: string, code: string) => ({ projectId, code, name: `Depot ${code}`, address: `${code}, 2100 København Ø`, location: nordhavn })

  const create = async <T extends { id: string }>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> =>
    created(call, path, await call(path, { method: "POST", body: values }), schema)
  const warehouse = (code: string, values: Record<string, unknown> = {}) => create(olivia, "/warehouses", body(a.projects.copenhagen.id, code, values), Warehouse)
  const one = async (call: Call, id: string): Promise<Warehouse> => {
    const response = await call(`/warehouses/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Warehouse.parse(await response.json())
  }
  const patch = async (call: Call, id: string, values: unknown): Promise<Warehouse> => {
    const response = await call(`/warehouses/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Warehouse.parse(await response.json())
  }
  const page = async (call: Call, query = "") => {
    const response = await call(`/warehouses${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return WarehousePage.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const paths = (problem: { errors?: { path: string }[] }) => problem.errors?.map((error) => error.path)

  describe("POST /warehouses", () => {
    test("mints the id, defaults the status to active, and stands nowhere in particular until it is geocoded", async () => {
      const created = await warehouse("WH-WEST", { name: "Warehouse West" })
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.equal(created.projectId, a.projects.copenhagen.id)
      assert.deepEqual([created.code, created.name], ["WH-WEST", "Warehouse West"])
      assert.equal(created.status, "active", "a warehouse is registered because stock already moves through it")
      assert.equal(created.location, null, "registered before it is geocoded")
      assert.equal(created.depotId, null, "no yard shared until the body says so")
      assert.equal(created.notes, null)
      assert.deepEqual(await one(olivia, created.id), created)
    })

    test("takes the location as GeoJSON, the depot it shares a yard with, the status and the notes, and reads them back", async () => {
      const created = await warehouse("WH-NORD", { location: nordhavn, depotId: nordhavnDepot.id, status: "draft", notes: "Shares the Nordhavn yard" })
      assert.deepEqual(created.location, nordhavn, "the point reads back as the GeoJSON it was written as")
      assert.equal(created.depotId, nordhavnDepot.id, "colocation is one pointer")
      assert.equal(created.status, "draft")
      assert.equal(created.notes, "Shares the Nordhavn yard")
      assert.deepEqual(await one(olivia, created.id), created)
    })

    test("refuses a depot of another project, of another company, and one nobody minted, naming the field, and writes nothing", async () => {
      const elsewhere = await refused(await olivia("/warehouses", { method: "POST", body: body(a.projects.copenhagen.id, "WH-REACH", { depotId: pierDepot.id }) }), 400)
      assert.deepEqual(elsewhere.errors, [{ path: "depotId", message: "Not a depot of this project" }])
      const foreign = await refused(await olivia("/warehouses", { method: "POST", body: body(a.projects.copenhagen.id, "WH-REACH", { depotId: theirDepot.id }) }), 400)
      assert.deepEqual(foreign.errors, [{ path: "depotId", message: "Not a depot of this project" }])
      const unminted = await refused(await olivia("/warehouses", { method: "POST", body: body(a.projects.copenhagen.id, "WH-REACH", { depotId: testId() }) }), 400)
      assert.deepEqual(unminted.errors, [{ path: "depotId", message: "Not a depot of this project" }])
      assert.equal((await page(olivia, "?limit=200")).items.some((row) => row.code === "WH-REACH"), false)
      const pier = await create(olivia, "/warehouses", body(a.projects.harbor.id, "WH-PIER", { depotId: pierDepot.id }), Warehouse)
      assert.equal(pier.depotId, pierDepot.id, "and the same depot is fine for a warehouse of its own project")
    })

    test("refuses a point off the globe before the database sees it, a status outside the four, and a member the server owns", async () => {
      const offTheGlobe = await refused(
        await olivia("/warehouses", { method: "POST", body: body(a.projects.copenhagen.id, "WH-OFF", { location: { type: "Point", coordinates: [12.5977, 91] } }) }),
        400,
      )
      assert.deepEqual(paths(offTheGlobe), ["location.coordinates.1"])
      const lifted = await refused(
        await olivia("/warehouses", { method: "POST", body: body(a.projects.copenhagen.id, "WH-OFF", { location: { type: "Point", coordinates: [12.5977, 55.7083, 10] } }) }),
        400,
      )
      assert.deepEqual(paths(lifted), ["location.coordinates"], "a third ordinate: the column is flat, and the refusal is the contracts' and never PostGIS's 22023")
      assert.deepEqual(paths(await refused(await olivia("/warehouses", { method: "POST", body: body(a.projects.copenhagen.id, "WH-OFF", { status: "open" }) }), 400)), ["status"])
      const owned = await refused(await olivia("/warehouses", { method: "POST", body: body(a.projects.copenhagen.id, "WH-OFF", { id: testId() }) }), 400)
      assert.ok(owned.errors?.some((error) => /id/.test(error.message)), JSON.stringify(owned.errors))
      assert.deepEqual(paths(await refused(await olivia("/warehouses", { method: "POST", body: { ...body(a.projects.copenhagen.id, "WH-OFF"), address: undefined } }), 400)), ["address"])
    })

    test("refuses a project the caller does not work in, naming the field", async () => {
      const foreign = await refused(await olivia("/warehouses", { method: "POST", body: body(b.projects.copenhagen.id, "WH-FOREIGN") }), 400)
      assert.deepEqual(foreign.errors, [{ path: "projectId", message: "Not a project this account works in" }])
      const narrow = await refused(await viewer("/warehouses", { method: "POST", body: body(a.projects.harbor.id, "WH-NARROW") }), 400)
      assert.deepEqual(narrow.errors, [{ path: "projectId", message: "Not a project this account works in" }])
      assert.equal((await create(viewer, "/warehouses", body(a.projects.copenhagen.id, "WH-VERA"), Warehouse)).projectId, a.projects.copenhagen.id)
    })

    test("refuses a code and a name the project already uses, each with its own sentence, and lets another project use them", async () => {
      await warehouse("WH-EAST", { name: "Warehouse East" })
      const code = await refused(await olivia("/warehouses", { method: "POST", body: body(a.projects.copenhagen.id, "WH-EAST", { name: "Something else" }) }), 409)
      assert.equal(code.detail, 'This project already has a warehouse coded "WH-EAST"')
      const name = await refused(await olivia("/warehouses", { method: "POST", body: body(a.projects.copenhagen.id, "WH-EAST-2", { name: "Warehouse East" }) }), 409)
      assert.equal(name.detail, 'This project already has a warehouse called "Warehouse East"')
      assert.doesNotMatch(`${code.detail}${name.detail}`, /_key/)
      const harbor = await create(olivia, "/warehouses", body(a.projects.harbor.id, "WH-EAST", { name: "Warehouse East" }), Warehouse)
      assert.equal(harbor.code, "WH-EAST", "a code is one warehouse's inside a project, and free in the next")
    })

    test("refuses a role that may view but not create", async () => {
      const problem = await refused(await lars("/warehouses", { method: "POST", body: body(a.projects.copenhagen.id, "WH-LARS") }), 403)
      assert.match(problem.detail ?? "", /create on resources\.warehouses/)
    })
  })

  describe("GET /warehouses", () => {
    test("answers the company's warehouses in id order and holds nothing of another company's", async () => {
      const mine = await warehouse("WH-10")
      const ids = (await page(olivia, "?limit=200")).items.map((row) => row.id)
      assert.ok(ids.includes(mine.id))
      assert.deepEqual(ids, [...ids].sort(), "ascending by id")
      assert.ok(!ids.includes(theirWarehouse.id))
      assert.deepEqual((await page(other, "?limit=200")).items.map((row) => row.code), ["WH-THEIRS"])
    })

    test("filters by project and by status", async () => {
      const harbor = await create(olivia, "/warehouses", body(a.projects.harbor.id, "WH-11", { status: "restricted" }), Warehouse)
      const byProject = await page(olivia, `?limit=200&projectId=${a.projects.harbor.id}`)
      assert.ok(byProject.items.some((row) => row.id === harbor.id))
      for (const row of byProject.items) assert.equal(row.projectId, a.projects.harbor.id)

      const byStatus = await page(olivia, "?limit=200&status=restricted")
      assert.ok(byStatus.items.some((row) => row.id === harbor.id))
      for (const row of byStatus.items) assert.equal(row.status, "restricted")
      assert.deepEqual(paths(await refused(await olivia("/warehouses?status=open"), 400)), ["status"])
    })

    test("shows an account only the projects it works in, and answers an empty page to one that works in none", async () => {
      const here = await warehouse("WH-12")
      const elsewhere = await create(olivia, "/warehouses", body(a.projects.harbor.id, "WH-12"), Warehouse)
      const seen = (await page(viewer, "?limit=200")).items
      assert.ok(seen.some((row) => row.id === here.id))
      assert.ok(!seen.some((row) => row.id === elsewhere.id))
      for (const row of seen) assert.equal(row.projectId, a.projects.copenhagen.id)

      assert.deepEqual(await page(lars, "?limit=200"), { items: [], nextCursor: null }, "a service provider's account works in no project and reads none of this")
      const problem = await refused(await viewer(`/warehouses?projectId=${a.projects.harbor.id}`), 400)
      assert.deepEqual(problem.errors, [{ path: "projectId", message: "Not a project this account works in" }])
    })

    test("refuses a role without resources.warehouses view, and a caller with no token", async () => {
      assert.match((await refused(await ungranted("/warehouses"), 403)).detail ?? "", /view on resources\.warehouses/)
      assert.equal((await app.request("/warehouses")).status, 401)
    })
  })

  describe("GET /warehouses/:id", () => {
    test("answers 404 for another company's, for one in a project the caller does not work in, and for an id nobody minted", async () => {
      const foreign = await refused(await olivia(`/warehouses/${theirWarehouse.id}`), 404)
      assert.match(foreign.detail ?? "", /warehouse/i)
      assert.deepEqual(await one(other, theirWarehouse.id), theirWarehouse, "still there for its own company")

      const elsewhere = await create(olivia, "/warehouses", body(a.projects.harbor.id, "WH-20"), Warehouse)
      await refused(await viewer(`/warehouses/${elsewhere.id}`), 404)
      await refused(await lars(`/warehouses/${elsewhere.id}`), 404)
      assert.equal((await one(olivia, elsewhere.id)).code, "WH-20")
      await refused(await olivia(`/warehouses/${testId()}`), 404)
      assert.deepEqual(paths(await refused(await olivia("/warehouses/not-a-uuid"), 400)), ["id"])
    })
  })

  describe("PATCH /warehouses/:id", () => {
    test("changes what the body names, moves and clears the place and the depot, leaves the code, and moves the stamp", async () => {
      const created = await warehouse("WH-30", { location: nordhavn, depotId: nordhavnDepot.id })
      await nextMillisecond()
      const changed = await patch(olivia, created.id, { name: "Warehouse Sydhavn", location: sydhavn, status: "restricted", notes: "Moving" })
      assert.deepEqual([changed.code, changed.name, changed.status, changed.notes], ["WH-30", "Warehouse Sydhavn", "restricted", "Moving"])
      assert.deepEqual(changed.location, sydhavn, "the place moved")
      assert.equal(changed.depotId, nordhavnDepot.id, "what the patch did not name it did not touch")
      assert.ok(changed.updatedAt > created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), changed)

      const cleared = await patch(olivia, created.id, { location: null, depotId: null, notes: null })
      assert.equal(cleared.location, null, "a null takes the point off again")
      assert.equal(cleared.depotId, null, "and the shared yard")
      assert.equal(cleared.notes, null)
    })

    test("refuses a depot of another project on the stored row's project, the code, the project, and an empty patch", async () => {
      const created = await warehouse("WH-31")
      const elsewhere = await refused(await olivia(`/warehouses/${created.id}`, { method: "PATCH", body: { depotId: pierDepot.id } }), 400)
      assert.deepEqual(elsewhere.errors, [{ path: "depotId", message: "Not a depot of this project" }])
      const code = await refused(await olivia(`/warehouses/${created.id}`, { method: "PATCH", body: { code: "WH-32" } }), 400)
      assert.ok(code.errors?.some((error) => /code/.test(error.message)), JSON.stringify(code.errors))
      const moved = await refused(await olivia(`/warehouses/${created.id}`, { method: "PATCH", body: { projectId: a.projects.harbor.id } }), 400)
      assert.ok(moved.errors?.some((error) => /projectId/.test(error.message)), JSON.stringify(moved.errors))
      assert.deepEqual(paths(await refused(await olivia(`/warehouses/${created.id}`, { method: "PATCH", body: {} }), 400)), [""])
      assert.deepEqual(await one(olivia, created.id), created, "a refused patch changes nothing")
      assert.equal((await patch(olivia, created.id, { depotId: nordhavnDepot.id })).depotId, nordhavnDepot.id, "a depot of its own project is taken")
    })

    test("refuses a rename onto a name the project already uses, and changes nothing", async () => {
      await warehouse("WH-33", { name: "Taken already" })
      const created = await warehouse("WH-34", { name: "Free to rename" })
      const problem = await refused(await olivia(`/warehouses/${created.id}`, { method: "PATCH", body: { name: "Taken already" } }), 409)
      assert.equal(problem.detail, 'This project already has a warehouse called "Taken already"')
      assert.equal((await one(olivia, created.id)).name, "Free to rename")
    })

    test("refuses another company's warehouse, one out of the caller's projects, an id nobody minted, and a role that may view but not edit", async () => {
      await refused(await olivia(`/warehouses/${theirWarehouse.id}`, { method: "PATCH", body: { name: "Mine now" } }), 404)
      assert.equal((await one(other, theirWarehouse.id)).name, "Warehouse WH-THEIRS")
      const elsewhere = await create(olivia, "/warehouses", body(a.projects.harbor.id, "WH-35"), Warehouse)
      await refused(await viewer(`/warehouses/${elsewhere.id}`, { method: "PATCH", body: { name: "Mine now" } }), 404)
      const unminted = await refused(await olivia(`/warehouses/${testId()}`, { method: "PATCH", body: { depotId: theirDepot.id } }), 404)
      assert.match(unminted.detail ?? "", /warehouse/i, "the row is read before the patch's references, so an id nobody minted is the 404 it is everywhere else")
      assert.match((await refused(await lars(`/warehouses/${elsewhere.id}`, { method: "PATCH", body: { name: "x" } }), 403)).detail ?? "", /edit on resources\.warehouses/)
    })
  })
})
