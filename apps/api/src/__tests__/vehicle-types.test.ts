import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { ContainerType } from "@waste/contracts/catalogue"
import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { EACH_CONTAINER_TYPE_ONCE, VehicleType } from "@waste/contracts/vehicle-types"
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
const VehicleTypePage = Page(VehicleType)

const MODULE = "configure.master"

/** The order a set reads back in: by the id an entry names, which it names once. */
const inReadOrder = (ids: readonly string[]): string[] => [...ids].sort()

describe("the vehicle type endpoints", { skip: database.skip }, () => {
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

  /** This company's container types, what a type may service. */
  let bin240: ContainerType
  let bin660: ContainerType
  let underground: ContainerType
  /** The other company's. */
  let theirContainerType: ContainerType
  let theirType: VehicleType

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

    bin240 = await create(olivia, "/container-types", { name: "240 L bin", volumeLitres: 240 }, ContainerType)
    bin660 = await create(olivia, "/container-types", { name: "660 L container", volumeLitres: 660 }, ContainerType)
    underground = await create(olivia, "/container-types", { name: "Underground · 5,000 L", volumeLitres: 5000 }, ContainerType)
    theirContainerType = await create(other, "/container-types", { name: "240 L bin", volumeLitres: 240 }, ContainerType)
    theirType = await create(other, "/vehicle-types", { key: "rear-loader", name: "Rear loader", containerTypeIds: [theirContainerType.id] }, VehicleType)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }

  const create = async <T extends { id: string }>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> =>
    created(call, path, await call(path, { method: "POST", body: values }), schema)
  const vehicleType = (key: string, values: Record<string, unknown> = {}) => create(olivia, "/vehicle-types", { key, name: `Type ${key}`, ...values }, VehicleType)
  const one = async (call: Call, id: string): Promise<VehicleType> => {
    const response = await call(`/vehicle-types/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return VehicleType.parse(await response.json())
  }
  const patch = async (call: Call, id: string, values: unknown): Promise<VehicleType> => {
    const response = await call(`/vehicle-types/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return VehicleType.parse(await response.json())
  }
  const put = async (call: Call, id: string, containerTypeIds: unknown): Promise<VehicleType> => {
    const response = await call(`/vehicle-types/${id}/container-types`, { method: "PUT", body: { containerTypeIds } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return VehicleType.parse(await response.json())
  }
  const page = async (call: Call, query = "") => {
    const response = await call(`/vehicle-types${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return VehicleTypePage.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const paths = (problem: { errors?: { path: string }[] }) => problem.errors?.map((error) => error.path)

  describe("POST /vehicle-types", () => {
    test("mints the id, keeps the key, the name and the description, and services nothing until it is told to", async () => {
      const created = await vehicleType("front-loader", { name: "Front loader", description: "Lifts a four-wheel container over the cab" })
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.deepEqual([created.key, created.name, created.description], ["front-loader", "Front loader", "Lifts a four-wheel container over the cab"])
      assert.deepEqual(created.containerTypeIds, [], "no compatibility set when the body names none: no typed rule matches through it")
      assert.equal(created.createdAt, created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), created)

      const bare = await vehicleType("skip-loader")
      assert.equal(bare.description, null, "a description nobody wrote is null")
    })

    test("takes the container types it starts out servicing, answers them by id, and the read agrees", async () => {
      const created = await vehicleType("rear-loader", { name: "Rear loader", containerTypeIds: [bin660.id, bin240.id] })
      assert.deepEqual(created.containerTypeIds, inReadOrder([bin240.id, bin660.id]), "by id, whatever order the body spelled them in")
      assert.deepEqual(await one(olivia, created.id), created, "the answer is what the next read says")
    })

    test("refuses a container type that is not this company's at the indexed path, and writes nothing", async () => {
      const foreign = await refused(
        await olivia("/vehicle-types", { method: "POST", body: { key: "glass-crane", name: "Glass crane", containerTypeIds: [bin240.id, theirContainerType.id] } }),
        400,
      )
      assert.deepEqual(foreign.errors, [{ path: "containerTypeIds.1", message: "Not a container type of this company" }])
      const unminted = await refused(
        await olivia("/vehicle-types", { method: "POST", body: { key: "glass-crane", name: "Glass crane", containerTypeIds: [testId()] } }),
        400,
      )
      assert.deepEqual(unminted.errors, [{ path: "containerTypeIds.0", message: "Not a container type of this company" }])
      assert.equal((await page(olivia, "?limit=200")).items.some((row) => row.key === "glass-crane"), false, "the type went with its set: one transaction")
    })

    test("refuses the same container type twice, a key that is not a slug, and a member the server owns, at the schema", async () => {
      const twice = await refused(
        await olivia("/vehicle-types", { method: "POST", body: { key: "hook-lift", name: "Hook lift", containerTypeIds: [bin240.id, bin240.id] } }),
        400,
      )
      assert.deepEqual(twice.errors, [{ path: "containerTypeIds", message: EACH_CONTAINER_TYPE_ONCE }])
      const shouted = await refused(await olivia("/vehicle-types", { method: "POST", body: { key: "Hook Lift", name: "Hook lift" } }), 400)
      assert.deepEqual(paths(shouted), ["key"])
      assert.match(shouted.errors?.[0].message ?? "", /slug/)
      const owned = await refused(await olivia("/vehicle-types", { method: "POST", body: { id: testId(), key: "hook-lift", name: "Hook lift" } }), 400)
      assert.ok(owned.errors?.some((error) => /id/.test(error.message)), JSON.stringify(owned.errors))
      assert.deepEqual(paths(await refused(await olivia("/vehicle-types", { method: "POST", body: { name: "No key" } }), 400)), ["key"])
    })

    test("refuses a key and a name the company already uses, each with its own sentence, and lets another company use them", async () => {
      await vehicleType("vacuum-tanker", { name: "Vacuum tanker" })
      const key = await refused(await olivia("/vehicle-types", { method: "POST", body: { key: "vacuum-tanker", name: "Something else" } }), 409)
      assert.equal(key.detail, 'This company already has a vehicle type keyed "vacuum-tanker"')
      const name = await refused(await olivia("/vehicle-types", { method: "POST", body: { key: "something-else", name: "Vacuum tanker" } }), 409)
      assert.equal(name.detail, 'This company already has a vehicle type named "Vacuum tanker"')
      assert.doesNotMatch(`${key.detail}${name.detail}`, /_key/)

      // Company B registered `rear-loader` in `before` and company A did above: a key is one type's inside a company, and free in the next.
      const mine = (await page(olivia, "?limit=200")).items.find((row) => row.key === "rear-loader")
      assert.ok(mine !== undefined)
      assert.equal(theirType.key, mine.key)
      assert.notEqual(theirType.id, mine.id)
    })

    test("refuses a role that may view but not create", async () => {
      const problem = await refused(await lars("/vehicle-types", { method: "POST", body: { key: "not-mine", name: "Not mine" } }), 403)
      assert.match(problem.detail ?? "", /create on configure\.master/)
    })
  })

  describe("GET /vehicle-types", () => {
    test("answers the company's types in id order, each with its container types, and holds nothing of another company's", async () => {
      const mine = await vehicleType("side-loader", { containerTypeIds: [underground.id] })
      const { items } = await page(olivia, "?limit=200")
      const ids = items.map((row) => row.id)
      assert.ok(ids.includes(mine.id))
      assert.deepEqual(ids, [...ids].sort(), "ascending by id")
      assert.deepEqual(items.find((row) => row.id === mine.id), mine, "a row in the list carries its set, like the row on its own")
      assert.ok(!ids.includes(theirType.id))
      assert.deepEqual((await page(other, "?limit=200")).items, [theirType])
    })

    test("walks the pages with the cursor, each item carrying its own set and none of the next record's", async () => {
      const all = (await page(olivia, "?limit=200")).items
      assert.ok(all.length >= 2)
      assert.ok(all.some((row) => row.containerTypeIds.length > 0), "and at least one of them has a set to carry")
      const first = await page(olivia, "?limit=1")
      assert.deepEqual(first.items, all.slice(0, 1), "one item, with its own set: the surplus row that proved there is a next page is not one of them")
      assert.ok(first.nextCursor !== null)
      const rest = await page(olivia, `?limit=200&cursor=${first.nextCursor}`)
      assert.deepEqual(rest.items, all.slice(1))
      assert.equal(rest.nextCursor, null)
    })

    test("is the company's vocabulary: an account that works in one project, or in none, reads every type of the company", async () => {
      const all = (await page(olivia, "?limit=200")).items.map((row) => row.id)
      assert.deepEqual((await page(viewer, "?limit=200")).items.map((row) => row.id), all, "Vera works in Copenhagen Central only and reads the company's types")
      assert.deepEqual((await page(lars, "?limit=200")).items.map((row) => row.id), all, "Lars works in no project and reads them too, as he reads the waste fractions")
    })

    test("refuses a role without configure.master view, and a caller with no token", async () => {
      assert.match((await refused(await ungranted("/vehicle-types"), 403)).detail ?? "", /view on configure\.master/)
      assert.equal((await app.request("/vehicle-types")).status, 401)
    })
  })

  describe("GET /vehicle-types/:id", () => {
    test("answers 404 for another company's, and for an id nobody minted, and 400 for a path that is not an id", async () => {
      const foreign = await refused(await olivia(`/vehicle-types/${theirType.id}`), 404)
      assert.match(foreign.detail ?? "", /vehicle type/i)
      assert.deepEqual(await one(other, theirType.id), theirType, "still there for its own company")
      await refused(await olivia(`/vehicle-types/${testId()}`), 404)
      assert.deepEqual(paths(await refused(await olivia("/vehicle-types/not-a-uuid"), 400)), ["id"])
    })
  })

  describe("PATCH /vehicle-types/:id", () => {
    test("changes the name and the description, leaves the key and the set, and moves the stamp", async () => {
      const created = await vehicleType("crane-truck", { name: "Crane truck", containerTypeIds: [underground.id] })
      await nextMillisecond()
      const changed = await patch(olivia, created.id, { name: "Glass crane", description: "Lifts an igloo by its hook" })
      assert.deepEqual([changed.key, changed.name, changed.description], ["crane-truck", "Glass crane", "Lifts an igloo by its hook"])
      assert.deepEqual(changed.containerTypeIds, [underground.id], "a patch is not how a set changes")
      assert.ok(changed.updatedAt > created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), changed)
      assert.equal((await patch(olivia, created.id, { description: null })).description, null, "a null clears the description")
    })

    test("refuses the key, the container types, an empty patch, and a member the server owns", async () => {
      const created = await vehicleType("compactor")
      const rekeyed = await refused(await olivia(`/vehicle-types/${created.id}`, { method: "PATCH", body: { key: "packer" } }), 400)
      assert.ok(rekeyed.errors?.some((error) => /key/.test(error.message)), JSON.stringify(rekeyed.errors))
      const withSet = await refused(await olivia(`/vehicle-types/${created.id}`, { method: "PATCH", body: { containerTypeIds: [bin240.id] } }), 400)
      assert.ok(withSet.errors?.some((error) => /containerTypeIds/.test(error.message)), "the set is not a field of the patch")
      assert.deepEqual(paths(await refused(await olivia(`/vehicle-types/${created.id}`, { method: "PATCH", body: {} }), 400)), [""])
      assert.equal((await one(olivia, created.id)).key, "compactor", "the key is the slug the rest of the system quotes")
    })

    test("refuses a rename onto a name the company already uses, and changes nothing", async () => {
      await vehicleType("taken", { name: "Taken already" })
      const created = await vehicleType("free", { name: "Free to rename" })
      const problem = await refused(await olivia(`/vehicle-types/${created.id}`, { method: "PATCH", body: { name: "Taken already" } }), 409)
      assert.equal(problem.detail, 'This company already has a vehicle type named "Taken already"')
      assert.equal((await one(olivia, created.id)).name, "Free to rename")
    })

    test("refuses another company's type, and a role that may view but not edit", async () => {
      await refused(await olivia(`/vehicle-types/${theirType.id}`, { method: "PATCH", body: { name: "Mine now" } }), 404)
      assert.equal((await one(other, theirType.id)).name, "Rear loader")
      const created = await vehicleType("not-theirs")
      assert.match((await refused(await lars(`/vehicle-types/${created.id}`, { method: "PATCH", body: { name: "x" } }), 403)).detail ?? "", /edit on configure\.master/)
    })
  })

  describe("PUT /vehicle-types/:id/container-types", () => {
    test("replaces the whole set, answers it by id, and moves the type's stamp", async () => {
      const created = await vehicleType("multi-lift", { containerTypeIds: [bin240.id] })
      await nextMillisecond()
      const replaced = await put(olivia, created.id, [underground.id, bin660.id])
      assert.deepEqual(replaced.containerTypeIds, inReadOrder([bin660.id, underground.id]), "what the body left out is gone; by id")
      assert.ok(replaced.updatedAt > created.updatedAt, "the set is part of the type on the wire")
      assert.deepEqual(await one(olivia, created.id), replaced)
      await nextMillisecond()
      const emptied = await put(olivia, created.id, [])
      assert.deepEqual(emptied.containerTypeIds, [], "an empty set is a type no typed rule matches through")
      assert.ok(emptied.updatedAt > replaced.updatedAt, "emptying the set is a change to the type too")
      assert.deepEqual(await one(olivia, created.id), emptied)
    })

    test("refuses a container type of another company at the indexed path, and leaves the type as it was, stamp included", async () => {
      const created = await vehicleType("kerbside", { containerTypeIds: [bin240.id] })
      const problem = await refused(
        await olivia(`/vehicle-types/${created.id}/container-types`, { method: "PUT", body: { containerTypeIds: [bin660.id, theirContainerType.id] } }),
        400,
      )
      assert.deepEqual(problem.errors, [{ path: "containerTypeIds.1", message: "Not a container type of this company" }])
      assert.deepEqual(await one(olivia, created.id), created, "a body with one bad entry leaves the record exactly as it was")
    })

    test("refuses the same type twice, a missing list and a member the body does not own, at the schema", async () => {
      const created = await vehicleType("tipper")
      const twice = await refused(
        await olivia(`/vehicle-types/${created.id}/container-types`, { method: "PUT", body: { containerTypeIds: [bin240.id, bin240.id] } }),
        400,
      )
      assert.deepEqual(twice.errors, [{ path: "containerTypeIds", message: EACH_CONTAINER_TYPE_ONCE }])
      assert.deepEqual(paths(await refused(await olivia(`/vehicle-types/${created.id}/container-types`, { method: "PUT", body: {} }), 400)), ["containerTypeIds"])
      const owned = await refused(
        await olivia(`/vehicle-types/${created.id}/container-types`, { method: "PUT", body: { containerTypeIds: [], name: "x" } }),
        400,
      )
      assert.ok(owned.errors?.some((error) => /name/.test(error.message)), JSON.stringify(owned.errors))
      assert.deepEqual((await one(olivia, created.id)).containerTypeIds, [])
    })

    test("answers 404 for another company's type and for an id nobody minted, and 403 to a role that may view but not edit", async () => {
      await refused(await olivia(`/vehicle-types/${theirType.id}/container-types`, { method: "PUT", body: { containerTypeIds: [] } }), 404)
      assert.deepEqual((await one(other, theirType.id)).containerTypeIds, [theirContainerType.id], "and it still has its set")
      await refused(await olivia(`/vehicle-types/${testId()}/container-types`, { method: "PUT", body: { containerTypeIds: [] } }), 404)
      const created = await vehicleType("not-theirs-to-fill")
      assert.match(
        (await refused(await lars(`/vehicle-types/${created.id}/container-types`, { method: "PUT", body: { containerTypeIds: [] } }), 403)).detail ?? "",
        /edit on configure\.master/,
      )
    })
  })
})
