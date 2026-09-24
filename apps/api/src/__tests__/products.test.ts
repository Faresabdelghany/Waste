import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { ContainerType, Product, ServiceFrequency, WasteFraction } from "@waste/contracts/catalogue"
import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const ProductPage = Page(Product)

const MODULE = "commercial.products"

describe("the product endpoints", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  /** The company under test. */
  let a: Tenant
  /** The other company, written to once below and never again. */
  let b: Tenant
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted view, create and edit, with Project Access to Copenhagen only. */
  let viewer: Call
  /** The Service Provider Manager, granted view: a role that reaches no project of the company. */
  let lars: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call

  /** This company's master data: what a product may point at. */
  let bin: ContainerType
  let residual: WasteFraction
  let weekly: ServiceFrequency
  /** A cadence of Harbor Commercial: this company's, but not a Copenhagen product's to name. */
  let harborWeekly: ServiceFrequency
  /** The other company's. */
  let theirBin: ContainerType
  let theirFraction: WasteFraction
  let theirProduct: Product

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

    bin = await create(olivia, "/container-types", { name: "240 L bin", volumeLitres: 240 }, ContainerType)
    residual = await create(olivia, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    weekly = await create(
      olivia,
      "/service-frequencies",
      { projectId: a.projects.copenhagen.id, name: "Weekly", collectionsPerWeek: 1, weeksBetween: 1 },
      ServiceFrequency,
    )
    harborWeekly = await create(
      olivia,
      "/service-frequencies",
      { projectId: a.projects.harbor.id, name: "Weekly", collectionsPerWeek: 1, weeksBetween: 1 },
      ServiceFrequency,
    )
    theirBin = await create(other, "/container-types", { name: "240 L bin", volumeLitres: 240 }, ContainerType)
    theirFraction = await create(other, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    theirProduct = await create(other, "/products", body(b.projects.copenhagen.id, "Residual collection"), Product)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }

  /** A product body a caller may send: the three fields with no default, and nothing pointed at. */
  const body = (projectId: string, name: string) => ({ projectId, name, kind: "container-collection", unit: "pickup" })

  const create = async <T>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> => {
    const response = await call(path, { method: "POST", body: values })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  const one = async (call: Call, id: string): Promise<Product> => {
    const response = await call(`/products/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Product.parse(await response.json())
  }
  const patch = async (call: Call, id: string, values: unknown): Promise<Product> => {
    const response = await call(`/products/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Product.parse(await response.json())
  }
  const page = async (call: Call, query = "") => ProductPage.parse(await (await call(`/products${query}`)).json())
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }

  describe("POST /products", () => {
    test("mints the id, defaults the status to draft, and points at nothing until it is told to", async () => {
      const created = await create(olivia, "/products", body(a.projects.copenhagen.id, "Residual collection"), Product)
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.equal(created.projectId, a.projects.copenhagen.id)
      assert.equal(created.status, "draft", "a product is written before it is offered")
      assert.deepEqual(
        [created.containerTypeId, created.wasteFractionId, created.serviceFrequencyId],
        [null, null, null],
        "only a container collection has a container and a fraction, and the cadence is a default",
      )
      assert.deepEqual(await one(olivia, created.id), created)
    })

    test("takes the container type, the waste fraction and the cadence of its own company and project", async () => {
      const created = await create(
        olivia,
        "/products",
        {
          ...body(a.projects.copenhagen.id, "Weekly residual, 240 L"),
          status: "active",
          containerTypeId: bin.id,
          wasteFractionId: residual.id,
          serviceFrequencyId: weekly.id,
        },
        Product,
      )
      assert.equal(created.status, "active")
      assert.deepEqual(
        [created.containerTypeId, created.wasteFractionId, created.serviceFrequencyId],
        [bin.id, residual.id, weekly.id],
      )
    })

    test("refuses a container type or a waste fraction that is not this company's, naming the field", async () => {
      const type = await refused(
        await olivia("/products", { method: "POST", body: { ...body(a.projects.copenhagen.id, "Foreign bin"), containerTypeId: theirBin.id } }),
        400,
      )
      assert.deepEqual(type.errors, [{ path: "containerTypeId", message: "Not a container type of this company" }])
      const fraction = await refused(
        await olivia("/products", {
          method: "POST",
          body: { ...body(a.projects.copenhagen.id, "Foreign fraction"), wasteFractionId: theirFraction.id },
        }),
        400,
      )
      assert.deepEqual(fraction.errors, [{ path: "wasteFractionId", message: "Not a waste fraction of this company" }])
      const unminted = await refused(
        await olivia("/products", { method: "POST", body: { ...body(a.projects.copenhagen.id, "Nobody's bin"), containerTypeId: testId() } }),
        400,
      )
      assert.deepEqual(unminted.errors, [{ path: "containerTypeId", message: "Not a container type of this company" }])
    })

    test("refuses a cadence of another project of its own company: a frequency belongs to one project", async () => {
      const problem = await refused(
        await olivia("/products", {
          method: "POST",
          body: { ...body(a.projects.copenhagen.id, "Harbor cadence"), serviceFrequencyId: harborWeekly.id },
        }),
        400,
      )
      assert.deepEqual(problem.errors, [{ path: "serviceFrequencyId", message: "Not a service frequency of this project" }])
      assert.equal(
        (await create(
          olivia,
          "/products",
          { ...body(a.projects.harbor.id, "Harbor residual"), serviceFrequencyId: harborWeekly.id },
          Product,
        )).serviceFrequencyId,
        harborWeekly.id,
        "and the same cadence is fine on a product of its own project",
      )
    })

    test("refuses a project the caller does not work in, and a member the server owns", async () => {
      const foreign = await refused(await olivia("/products", { method: "POST", body: body(b.projects.copenhagen.id, "Theirs now") }), 400)
      assert.deepEqual(foreign.errors, [{ path: "projectId", message: "Not a project this account works in" }])
      const owned = await refused(
        await olivia("/products", { method: "POST", body: { ...body(a.projects.copenhagen.id, "Client minted"), id: testId() } }),
        400,
      )
      assert.ok(owned.errors?.some((error) => /id/.test(error.message)), JSON.stringify(owned.errors))
    })

    test("refuses a kind or a unit outside the vocabulary, naming the field", async () => {
      const problem = await refused(
        await olivia("/products", { method: "POST", body: { ...body(a.projects.copenhagen.id, "Nonsense"), kind: "collection", unit: "bag" } }),
        400,
      )
      assert.deepEqual(problem.errors?.map((error) => error.path), ["kind", "unit"])
    })

    test("refuses a name the project already uses, and lets another project use it", async () => {
      await create(olivia, "/products", body(a.projects.copenhagen.id, "Bulky waste on call"), Product)
      const problem = await refused(
        await olivia("/products", { method: "POST", body: body(a.projects.copenhagen.id, "Bulky waste on call") }),
        409,
      )
      assert.match(problem.detail ?? "", /"Bulky waste on call"/)
      assert.doesNotMatch(problem.detail ?? "", /_key/)
      assert.equal(
        (await create(olivia, "/products", body(a.projects.harbor.id, "Bulky waste on call"), Product)).projectId,
        a.projects.harbor.id,
      )
    })

    test("refuses a role that may view but not create", async () => {
      const problem = await refused(await lars("/products", { method: "POST", body: body(a.projects.copenhagen.id, "Not mine") }), 403)
      assert.match(problem.detail ?? "", /create on commercial\.products/)
    })
  })

  describe("GET /products", () => {
    test("answers the company's products in id order and holds nothing of another company's", async () => {
      const mine = await create(olivia, "/products", body(a.projects.copenhagen.id, "Paper collection"), Product)
      const all = (await page(olivia, "?limit=200")).items
      const ids = all.map((product) => product.id)
      assert.ok(ids.includes(mine.id))
      assert.deepEqual(ids, [...ids].sort(), "ascending by id")
      assert.ok(!ids.includes(theirProduct.id))
      assert.deepEqual((await page(other, "?limit=200")).items.map((product) => product.name), ["Residual collection"])
    })

    test("shows an account only the projects it works in, and refuses a create in one it does not", async () => {
      const here = await create(olivia, "/products", body(a.projects.copenhagen.id, "Glass collection"), Product)
      const elsewhere = await create(olivia, "/products", body(a.projects.harbor.id, "Glass collection, harbour"), Product)
      const seen = (await page(viewer, "?limit=200")).items
      assert.ok(seen.some((product) => product.id === here.id))
      assert.ok(!seen.some((product) => product.id === elsewhere.id))
      for (const product of seen) assert.equal(product.projectId, a.projects.copenhagen.id)

      const problem = await refused(await viewer("/products", { method: "POST", body: body(a.projects.harbor.id, "Not mine to make") }), 400)
      assert.deepEqual(problem.errors, [{ path: "projectId", message: "Not a project this account works in" }])
    })

    test("answers an empty page to an account that works in no project at all", async () => {
      const { items, nextCursor } = await page(lars, "?limit=200")
      assert.deepEqual(items, [])
      assert.equal(nextCursor, null)
    })

    test("filters the page by project, and refuses a project the caller does not work in", async () => {
      const harbor = await create(olivia, "/products", body(a.projects.harbor.id, "Harbour paper"), Product)
      const filtered = await page(olivia, `?limit=200&projectId=${a.projects.harbor.id}`)
      assert.ok(filtered.items.some((product) => product.id === harbor.id))
      for (const product of filtered.items) assert.equal(product.projectId, a.projects.harbor.id)
      const problem = await refused(await viewer(`/products?projectId=${a.projects.harbor.id}`), 400)
      assert.equal(problem.detail, "The request query is invalid")
      assert.deepEqual(problem.errors, [{ path: "projectId", message: "Not a project this account works in" }])
    })

    test("refuses a role without commercial.products view, and a caller with no token", async () => {
      assert.match((await refused(await ungranted("/products"), 403)).detail ?? "", /view on commercial\.products/)
      assert.equal((await app.request("/products")).status, 401)
    })
  })

  describe("GET /products/:id", () => {
    test("answers 404 for another company's product, for one in a project the caller does not work in, and for an id nobody minted", async () => {
      const foreign = await refused(await olivia(`/products/${theirProduct.id}`), 404)
      assert.match(foreign.detail ?? "", /product/i)
      assert.equal((await one(other, theirProduct.id)).name, "Residual collection", "still there for its own company")

      const elsewhere = await create(olivia, "/products", body(a.projects.harbor.id, "Harbour bulky"), Product)
      await refused(await viewer(`/products/${elsewhere.id}`), 404)
      assert.equal((await one(olivia, elsewhere.id)).name, "Harbour bulky")
      await refused(await olivia(`/products/${testId()}`), 404)
      assert.deepEqual(
        (await refused(await olivia("/products/not-a-uuid"), 400)).errors?.map((error) => error.path),
        ["id"],
      )
    })
  })

  describe("PATCH /products/:id", () => {
    test("changes what the body names and leaves the rest, and answers the row as it now stands", async () => {
      const created = await create(
        olivia,
        "/products",
        { ...body(a.projects.copenhagen.id, "Food collection"), containerTypeId: bin.id, serviceFrequencyId: weekly.id },
        Product,
      )
      const changed = await patch(olivia, created.id, { status: "active", unit: "month" })
      assert.equal(changed.status, "active")
      assert.equal(changed.unit, "month")
      assert.equal(changed.containerTypeId, bin.id, "what the patch did not name it did not touch")
      assert.ok(changed.updatedAt > created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), changed)

      const cleared = await patch(olivia, created.id, { serviceFrequencyId: null })
      assert.equal(cleared.serviceFrequencyId, null, "a product may have no default cadence")
    })

    test("checks a reference against the stored row's project, and refuses the project itself", async () => {
      const created = await create(olivia, "/products", body(a.projects.copenhagen.id, "Cardboard collection"), Product)
      const problem = await refused(await olivia(`/products/${created.id}`, { method: "PATCH", body: { serviceFrequencyId: harborWeekly.id } }), 400)
      assert.deepEqual(problem.errors, [{ path: "serviceFrequencyId", message: "Not a service frequency of this project" }])
      const moved = await refused(await olivia(`/products/${created.id}`, { method: "PATCH", body: { projectId: a.projects.harbor.id } }), 400)
      assert.ok(moved.errors?.some((error) => /projectId/.test(error.message)), JSON.stringify(moved.errors))
      assert.equal((await one(olivia, created.id)).serviceFrequencyId, null)
    })

    test("refuses an empty patch, another company's product, and one in a project the caller does not work in", async () => {
      const created = await create(olivia, "/products", body(a.projects.copenhagen.id, "Garden collection"), Product)
      assert.deepEqual(
        (await refused(await olivia(`/products/${created.id}`, { method: "PATCH", body: {} }), 400)).errors?.map((error) => error.path),
        [""],
      )
      await refused(await olivia(`/products/${theirProduct.id}`, { method: "PATCH", body: { status: "inactive" } }), 404)
      assert.equal((await one(other, theirProduct.id)).status, "draft")

      const elsewhere = await create(olivia, "/products", body(a.projects.harbor.id, "Harbour garden"), Product)
      await refused(await viewer(`/products/${elsewhere.id}`, { method: "PATCH", body: { status: "inactive" } }), 404)
    })

    test("refuses a rename onto a name the project already uses", async () => {
      await create(olivia, "/products", body(a.projects.copenhagen.id, "Taken already"), Product)
      const created = await create(olivia, "/products", body(a.projects.copenhagen.id, "Free to rename"), Product)
      const problem = await refused(await olivia(`/products/${created.id}`, { method: "PATCH", body: { name: "Taken already" } }), 409)
      assert.match(problem.detail ?? "", /"Taken already"/)
      assert.equal((await one(olivia, created.id)).name, "Free to rename")
    })

    test("refuses a role that may view but not edit", async () => {
      const created = await create(olivia, "/products", body(a.projects.copenhagen.id, "Not theirs to change"), Product)
      const problem = await refused(await lars(`/products/${created.id}`, { method: "PATCH", body: { status: "active" } }), 403)
      assert.match(problem.detail ?? "", /edit on commercial\.products/)
    })
  })
})
