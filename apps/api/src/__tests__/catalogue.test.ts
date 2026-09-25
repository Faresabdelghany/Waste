import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { ContainerType, ServiceFrequency, WasteFraction } from "@waste/contracts/catalogue"
import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const WasteFractionPage = Page(WasteFraction)
const ContainerTypePage = Page(ContainerType)
const ServiceFrequencyPage = Page(ServiceFrequency)

const MODULE = "configure.master"

describe("the master data endpoints", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  /** The company under test; everything this file writes, unless a test says otherwise, is written here. */
  let a: Tenant
  /** The other company: its rows are made once below and never touched again, so they are the 404s and the page that holds. */
  let b: Tenant
  let app: ReturnType<typeof createApp>
  /** The Company Administrator: every action on every module. */
  let olivia: Call
  /** The custom role, granted view, create and edit on this module, with Project Access to Copenhagen only. */
  let viewer: Call
  /** The Service Provider Manager, granted view: a role that reaches no project of the company. */
  let lars: Call
  /** The other company's Company Administrator. */
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call

  /** The other company's rows, made once so its pages hold however this file's tests are ordered. */
  let theirFraction: WasteFraction
  let theirType: ContainerType
  let theirFrequency: ServiceFrequency

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

    theirFraction = await create(other, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    theirType = await create(other, "/container-types", { name: "240 L bin", volumeLitres: 240 }, ContainerType)
    theirFrequency = await create(
      other,
      "/service-frequencies",
      { projectId: b.projects.copenhagen.id, name: "Weekly", collectionsPerWeek: 1, weeksBetween: 1 },
      ServiceFrequency,
    )
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }

  const create = async <T extends { id: string }>(call: Call, path: string, body: unknown, schema: Schema<T>): Promise<T> =>
    created(call, path, await call(path, { method: "POST", body }), schema)
  const one = async <T>(call: Call, path: string, schema: Schema<T>): Promise<T> => {
    const response = await call(path)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  const patch = async <T>(call: Call, path: string, body: unknown, schema: Schema<T>): Promise<T> => {
    const response = await call(path, { method: "PATCH", body })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const paths = (problem: { errors?: { path: string }[] }) => problem.errors?.map((error) => error.path)

  describe("the waste fractions", () => {
    const page = async (call: Call, query = "") => WasteFractionPage.parse(await (await call(`/waste-fractions${query}`)).json())

    test("answers the company's fractions in id order and walks the pages with the cursor", async () => {
      await create(olivia, "/waste-fractions", { key: "paper", name: "Paper and cardboard" }, WasteFraction)
      await create(olivia, "/waste-fractions", { key: "glass", name: "Glass" }, WasteFraction)
      const all = (await page(olivia, "?limit=200")).items
      assert.ok(all.length >= 2)
      const ids = all.map((fraction) => fraction.id)
      assert.deepEqual(ids, [...ids].sort(), "ascending by id")

      const first = await page(olivia, "?limit=1")
      assert.deepEqual(first.items, all.slice(0, 1))
      assert.ok(first.nextCursor !== null)
      const second = await page(olivia, `?limit=200&cursor=${first.nextCursor}`)
      assert.deepEqual(second.items, all.slice(1))
      assert.equal(second.nextCursor, null)
    })

    test("holds nothing of another company's", async () => {
      const theirs = (await page(other, "?limit=200")).items
      assert.deepEqual(theirs.map((fraction) => fraction.key), ["residual"])
      const mine = (await page(olivia, "?limit=200")).items.map((fraction) => fraction.id)
      assert.ok(!mine.includes(theirFraction.id))
    })

    test("refuses a role without configure.master view, and a caller with no token", async () => {
      const problem = await refused(await ungranted("/waste-fractions"), 403)
      assert.match(problem.detail ?? "", /view on configure\.master/)
      assert.equal((await app.request("/waste-fractions")).status, 401)
    })

    test("mints the id itself on a create and answers the row it wrote", async () => {
      const created = await create(olivia, "/waste-fractions", { key: "food", name: "Food waste" }, WasteFraction)
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.equal(created.key, "food")
      assert.equal(created.createdAt, created.updatedAt)
      assert.deepEqual(await one(olivia, `/waste-fractions/${created.id}`, WasteFraction), created)
    })

    test("refuses a body that is missing a field, spells the key wrongly, or names a member the server owns", async () => {
      assert.deepEqual(paths(await refused(await olivia("/waste-fractions", { method: "POST", body: { name: "No key" } }), 400)), ["key"])
      const shouted = await refused(await olivia("/waste-fractions", { method: "POST", body: { key: "Food Waste", name: "Food" } }), 400)
      assert.deepEqual(shouted.errors?.map((error) => error.path), ["key"])
      assert.match(shouted.errors?.[0].message ?? "", /slug/)
      const owned = await refused(
        await olivia("/waste-fractions", { method: "POST", body: { id: testId(), key: "metal", name: "Metal" } }),
        400,
      )
      assert.ok(owned.errors?.some((error) => /id/.test(error.message)), JSON.stringify(owned.errors))
    })

    test("refuses a role that may view but not create", async () => {
      const problem = await refused(await lars("/waste-fractions", { method: "POST", body: { key: "wood", name: "Wood" } }), 403)
      assert.match(problem.detail ?? "", /create on configure\.master/)
    })

    test("refuses a key or a name the company already uses, each with its own sentence", async () => {
      const mine = await create(olivia, "/waste-fractions", { key: "textile", name: "Textiles" }, WasteFraction)
      const key = await refused(await olivia("/waste-fractions", { method: "POST", body: { key: "textile", name: "Old clothes" } }), 409)
      assert.match(key.detail ?? "", /key "textile"/)
      assert.doesNotMatch(key.detail ?? "", /_key/)
      const name = await refused(await olivia("/waste-fractions", { method: "POST", body: { key: "clothes", name: "Textiles" } }), 409)
      assert.match(name.detail ?? "", /"Textiles"/)
      assert.doesNotMatch(name.detail ?? "", /_key/)
      assert.equal((await one(olivia, `/waste-fractions/${mine.id}`, WasteFraction)).name, "Textiles")
    })

    test("lets another company use the same key: a fraction's key is unique inside a company", async () => {
      const created = await create(olivia, "/waste-fractions", { key: "residual", name: "Residual" }, WasteFraction)
      assert.equal(created.key, theirFraction.key)
      assert.notEqual(created.id, theirFraction.id)
    })

    test("answers 404 for another company's fraction, for an id nobody minted, and 400 for a path that is not an id", async () => {
      const foreign = await refused(await olivia(`/waste-fractions/${theirFraction.id}`), 404)
      assert.match(foreign.detail ?? "", /waste fraction/i)
      assert.equal((await one(other, `/waste-fractions/${theirFraction.id}`, WasteFraction)).key, "residual", "still there for its own company")
      await refused(await olivia(`/waste-fractions/${testId()}`), 404)
      assert.deepEqual(paths(await refused(await olivia("/waste-fractions/not-a-uuid"), 400)), ["id"])
    })

    test("changes the name on a patch, and refuses an empty one, the key, and another company's row", async () => {
      const created = await create(olivia, "/waste-fractions", { key: "garden", name: "Garden" }, WasteFraction)
      const renamed = await patch(olivia, `/waste-fractions/${created.id}`, { name: "Garden waste" }, WasteFraction)
      assert.equal(renamed.name, "Garden waste")
      assert.equal(renamed.key, "garden", "the key is the slug the rest of the system quotes")
      assert.ok(renamed.updatedAt > created.updatedAt)

      assert.deepEqual(paths(await refused(await olivia(`/waste-fractions/${created.id}`, { method: "PATCH", body: {} }), 400)), [""])
      const rekeyed = await refused(await olivia(`/waste-fractions/${created.id}`, { method: "PATCH", body: { key: "compost" } }), 400)
      assert.ok(rekeyed.errors?.some((error) => /key/.test(error.message)), JSON.stringify(rekeyed.errors))
      await refused(await olivia(`/waste-fractions/${theirFraction.id}`, { method: "PATCH", body: { name: "Mine now" } }), 404)
      assert.equal((await one(other, `/waste-fractions/${theirFraction.id}`, WasteFraction)).name, "Residual waste")
    })

    test("refuses a rename onto a name the company already uses", async () => {
      const created = await create(olivia, "/waste-fractions", { key: "plastic", name: "Plastic" }, WasteFraction)
      const problem = await refused(await olivia(`/waste-fractions/${created.id}`, { method: "PATCH", body: { name: "Glass" } }), 409)
      assert.match(problem.detail ?? "", /"Glass"/)
      assert.equal((await one(olivia, `/waste-fractions/${created.id}`, WasteFraction)).name, "Plastic")
    })
  })

  describe("the container types", () => {
    const page = async (call: Call, query = "") => ContainerTypePage.parse(await (await call(`/container-types${query}`)).json())

    test("writes a type with or without a volume, and answers it on the next read", async () => {
      const measured = await create(olivia, "/container-types", { name: "660 L container", volumeLitres: 660 }, ContainerType)
      assert.equal(measured.volumeLitres, 660)
      const unmeasured = await create(olivia, "/container-types", { name: "Underground shaft" }, ContainerType)
      assert.equal(unmeasured.volumeLitres, null, "null where nobody recorded one")
      assert.deepEqual(await one(olivia, `/container-types/${measured.id}`, ContainerType), measured)
      const ids = (await page(olivia, "?limit=200")).items.map((type) => type.id)
      assert.ok(ids.includes(measured.id) && ids.includes(unmeasured.id))
      assert.ok(!ids.includes(theirType.id), "and nothing of another company's")
    })

    test("refuses a volume of zero, a missing name, and a member the server owns", async () => {
      assert.deepEqual(
        paths(await refused(await olivia("/container-types", { method: "POST", body: { name: "Nothing at all", volumeLitres: 0 } }), 400)),
        ["volumeLitres"],
      )
      assert.deepEqual(paths(await refused(await olivia("/container-types", { method: "POST", body: { volumeLitres: 400 } }), 400)), ["name"])
      const owned = await refused(
        await olivia("/container-types", { method: "POST", body: { id: testId(), name: "Client minted" } }),
        400,
      )
      assert.ok(owned.errors?.some((error) => /id/.test(error.message)), JSON.stringify(owned.errors))
    })

    test("refuses a name the company already uses, and lets another company use it", async () => {
      await create(olivia, "/container-types", { name: "140 L bin", volumeLitres: 140 }, ContainerType)
      const problem = await refused(await olivia("/container-types", { method: "POST", body: { name: "140 L bin" } }), 409)
      assert.match(problem.detail ?? "", /"140 L bin"/)
      assert.doesNotMatch(problem.detail ?? "", /_key/)
      assert.equal((await create(olivia, "/container-types", { name: "240 L bin" }, ContainerType)).name, theirType.name)
    })

    test("changes the volume on a patch, and clears it", async () => {
      const created = await create(olivia, "/container-types", { name: "Roll-on container", volumeLitres: 8000 }, ContainerType)
      assert.equal((await patch(olivia, `/container-types/${created.id}`, { volumeLitres: 10_000 }, ContainerType)).volumeLitres, 10_000)
      assert.equal((await patch(olivia, `/container-types/${created.id}`, { volumeLitres: null }, ContainerType)).volumeLitres, null)
      assert.equal((await one(olivia, `/container-types/${created.id}`, ContainerType)).name, "Roll-on container")
    })

    test("refuses a rename onto a name the company already uses, and changes nothing", async () => {
      await create(olivia, "/container-types", { name: "770 L container", volumeLitres: 770 }, ContainerType)
      const created = await create(olivia, "/container-types", { name: "Free to rename", volumeLitres: 400 }, ContainerType)
      const problem = await refused(await olivia(`/container-types/${created.id}`, { method: "PATCH", body: { name: "770 L container" } }), 409)
      assert.match(problem.detail ?? "", /"770 L container"/)
      assert.doesNotMatch(problem.detail ?? "", /_key/)
      assert.equal((await one(olivia, `/container-types/${created.id}`, ContainerType)).name, "Free to rename")
    })

    test("answers 404 for another company's type and refuses a role without the grant", async () => {
      await refused(await olivia(`/container-types/${theirType.id}`), 404)
      await refused(await olivia(`/container-types/${theirType.id}`, { method: "PATCH", body: { name: "Mine now" } }), 404)
      assert.match((await refused(await ungranted("/container-types"), 403)).detail ?? "", /view on configure\.master/)
      assert.match(
        (await refused(await lars("/container-types", { method: "POST", body: { name: "Not mine to make" } }), 403)).detail ?? "",
        /create on configure\.master/,
      )
    })
  })

  describe("the service frequencies", () => {
    const page = async (call: Call, query = "") => ServiceFrequencyPage.parse(await (await call(`/service-frequencies${query}`)).json())
    const body = (projectId: string, name: string) => ({ projectId, name, collectionsPerWeek: 1, weeksBetween: 1 })

    test("writes a frequency into a project the caller works in and answers it with that project", async () => {
      const created = await create(olivia, "/service-frequencies", body(a.projects.copenhagen.id, "Weekly"), ServiceFrequency)
      assert.equal(created.projectId, a.projects.copenhagen.id)
      assert.equal(created.collectionsPerWeek, 1)
      assert.equal(created.weeksBetween, 1)
      assert.equal(created.daysBetween, null)
      assert.equal(created.description, null)
      assert.deepEqual(await one(olivia, `/service-frequencies/${created.id}`, ServiceFrequency), created)
    })

    test("takes on demand as a rate nobody gave, and monthly as one a week with no interval", async () => {
      const onDemand = await create(olivia, "/service-frequencies", { projectId: a.projects.copenhagen.id, name: "On demand" }, ServiceFrequency)
      assert.equal(onDemand.collectionsPerWeek, null)
      const monthly = await create(
        olivia,
        "/service-frequencies",
        { projectId: a.projects.copenhagen.id, name: "Monthly", collectionsPerWeek: 1 },
        ServiceFrequency,
      )
      assert.equal(monthly.weeksBetween, null)
      assert.equal(monthly.daysBetween, null)
    })

    test("refuses an interval with no rate to belong to, and both intervals at once", async () => {
      const orphan = await refused(
        await olivia("/service-frequencies", { method: "POST", body: { projectId: a.projects.copenhagen.id, name: "Orphan", weeksBetween: 2 } }),
        400,
      )
      assert.match(orphan.errors?.[0].message ?? "", /collectionsPerWeek/)
      const both = await refused(
        await olivia("/service-frequencies", {
          method: "POST",
          body: { projectId: a.projects.copenhagen.id, name: "Both", collectionsPerWeek: 2, weeksBetween: 1, daysBetween: 3 },
        }),
        400,
      )
      assert.match(both.errors?.[0].message ?? "", /weeksBetween/)
    })

    test("refuses a patch that would leave the stored row with an interval and no rate", async () => {
      const created = await create(
        olivia,
        "/service-frequencies",
        { projectId: a.projects.copenhagen.id, name: "Fortnightly", collectionsPerWeek: 1, weeksBetween: 2 },
        ServiceFrequency,
      )
      const problem = await refused(
        await olivia(`/service-frequencies/${created.id}`, { method: "PATCH", body: { collectionsPerWeek: null } }),
        400,
      )
      assert.match(problem.errors?.[0].message ?? "", /collectionsPerWeek/)
      assert.equal((await one(olivia, `/service-frequencies/${created.id}`, ServiceFrequency)).collectionsPerWeek, 1)
      // Clearing both together is the same row saying "on demand", and that is fine.
      const cleared = await patch(
        olivia,
        `/service-frequencies/${created.id}`,
        { collectionsPerWeek: null, weeksBetween: null },
        ServiceFrequency,
      )
      assert.equal(cleared.collectionsPerWeek, null)
      assert.equal(cleared.weeksBetween, null)
    })

    test("refuses a create in a project the caller does not work in, naming the field", async () => {
      const foreign = await refused(
        await olivia("/service-frequencies", { method: "POST", body: body(b.projects.copenhagen.id, "Theirs now") }),
        400,
      )
      assert.deepEqual(foreign.errors, [{ path: "projectId", message: "Not a project this account works in" }])
    })

    test("shows an account only the projects it works in, and refuses a create in one it does not", async () => {
      const mine = await create(olivia, "/service-frequencies", body(a.projects.copenhagen.id, "Twice a week"), ServiceFrequency)
      const elsewhere = await create(olivia, "/service-frequencies", body(a.projects.harbor.id, "Harbor weekly"), ServiceFrequency)

      const seen = (await page(viewer, "?limit=200")).items
      assert.ok(seen.some((frequency) => frequency.id === mine.id))
      assert.ok(!seen.some((frequency) => frequency.id === elsewhere.id), "Harbor is not a project this account works in")
      for (const frequency of seen) assert.equal(frequency.projectId, a.projects.copenhagen.id)

      const refusal = await refused(
        await viewer("/service-frequencies", { method: "POST", body: body(a.projects.harbor.id, "Not mine to make") }),
        400,
      )
      assert.deepEqual(refusal.errors, [{ path: "projectId", message: "Not a project this account works in" }])
      assert.equal((await create(viewer, "/service-frequencies", body(a.projects.copenhagen.id, "Viewer's own"), ServiceFrequency)).projectId, a.projects.copenhagen.id)
    })

    test("answers 404 when the row is in a project the caller does not work in", async () => {
      const elsewhere = await create(olivia, "/service-frequencies", body(a.projects.harbor.id, "Harbor fortnightly"), ServiceFrequency)
      await refused(await viewer(`/service-frequencies/${elsewhere.id}`), 404)
      await refused(await viewer(`/service-frequencies/${elsewhere.id}`, { method: "PATCH", body: { name: "Mine now" } }), 404)
      assert.equal((await one(olivia, `/service-frequencies/${elsewhere.id}`, ServiceFrequency)).name, "Harbor fortnightly")
    })

    test("answers an empty page to an account that works in no project at all", async () => {
      const { items, nextCursor } = ServiceFrequencyPage.parse(await (await lars("/service-frequencies?limit=200")).json())
      assert.deepEqual(items, [])
      assert.equal(nextCursor, null)
    })

    test("filters the page by project, and refuses a project the caller does not work in", async () => {
      const harbor = await create(olivia, "/service-frequencies", body(a.projects.harbor.id, "Harbor monthly"), ServiceFrequency)
      const filtered = await page(olivia, `?limit=200&projectId=${a.projects.harbor.id}`)
      assert.ok(filtered.items.some((frequency) => frequency.id === harbor.id))
      for (const frequency of filtered.items) assert.equal(frequency.projectId, a.projects.harbor.id)

      const problem = await refused(await viewer(`/service-frequencies?projectId=${a.projects.harbor.id}`), 400)
      assert.equal(problem.detail, "The request query is invalid")
      assert.deepEqual(problem.errors, [{ path: "projectId", message: "Not a project this account works in" }])
    })

    test("refuses a name the project already uses, and lets another project use it", async () => {
      await create(olivia, "/service-frequencies", body(a.projects.copenhagen.id, "Every other day"), ServiceFrequency)
      const problem = await refused(
        await olivia("/service-frequencies", { method: "POST", body: body(a.projects.copenhagen.id, "Every other day") }),
        409,
      )
      assert.match(problem.detail ?? "", /"Every other day"/)
      assert.doesNotMatch(problem.detail ?? "", /_key/)
      assert.equal(
        (await create(olivia, "/service-frequencies", body(a.projects.harbor.id, "Every other day"), ServiceFrequency)).projectId,
        a.projects.harbor.id,
      )
    })

    test("refuses a rename onto a name the project already uses, and changes nothing", async () => {
      await create(olivia, "/service-frequencies", body(a.projects.copenhagen.id, "Three times a week"), ServiceFrequency)
      const created = await create(olivia, "/service-frequencies", body(a.projects.copenhagen.id, "Free to rename"), ServiceFrequency)
      const problem = await refused(
        await olivia(`/service-frequencies/${created.id}`, { method: "PATCH", body: { name: "Three times a week" } }),
        409,
      )
      assert.match(problem.detail ?? "", /"Three times a week"/)
      assert.doesNotMatch(problem.detail ?? "", /_key/)
      assert.equal((await one(olivia, `/service-frequencies/${created.id}`, ServiceFrequency)).name, "Free to rename")
    })

    test("answers 404 for another company's frequency and refuses a role without the grant", async () => {
      await refused(await olivia(`/service-frequencies/${theirFrequency.id}`), 404)
      assert.equal((await one(other, `/service-frequencies/${theirFrequency.id}`, ServiceFrequency)).name, "Weekly")
      assert.match((await refused(await ungranted("/service-frequencies"), 403)).detail ?? "", /view on configure\.master/)
    })

    test("refuses a body naming a member the server owns, and a patch naming the project", async () => {
      const owned = await refused(
        await olivia("/service-frequencies", { method: "POST", body: { ...body(a.projects.copenhagen.id, "Client minted"), id: testId() } }),
        400,
      )
      assert.ok(owned.errors?.some((error) => /id/.test(error.message)), JSON.stringify(owned.errors))
      const created = await create(olivia, "/service-frequencies", body(a.projects.copenhagen.id, "Stays put"), ServiceFrequency)
      const moved = await refused(
        await olivia(`/service-frequencies/${created.id}`, { method: "PATCH", body: { projectId: a.projects.harbor.id } }),
        400,
      )
      assert.ok(moved.errors?.some((error) => /projectId/.test(error.message)), JSON.stringify(moved.errors))
    })
  })
})
