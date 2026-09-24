import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Customer, Property } from "@waste/contracts/customers"
import type { Point } from "@waste/contracts/geojson"
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
const PropertyPage = Page(Property)

const MODULE = "customers.properties"

/** Copenhagen town hall, the point every located fixture here sits on. */
const townHall: Point = { type: "Point", coordinates: [12.5683, 55.6761] }

/** The order a set reads back in, so a test can say what it expects without knowing which random id sorts first: the customer, then the role. */
const inReadOrder = <Entry extends { customerId: string; role: string }>(parties: readonly Entry[]): Entry[] =>
  [...parties].sort((left, right) => (`${left.customerId} ${left.role}` < `${right.customerId} ${right.role}` ? -1 : 1))

describe("the property endpoints", { skip: database.skip }, () => {
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

  /** This company's customers: who a party names. */
  let housing: Customer
  let tenantCustomer: Customer
  /** The other company's. */
  let theirCustomer: Customer
  let theirProperty: Property

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

    housing = await create(olivia, "/customers", { kind: "organisation", name: "Kystbyen Housing" }, Customer)
    tenantCustomer = await create(olivia, "/customers", { kind: "person", name: "Ida Jensen" }, Customer)
    theirCustomer = await create(other, "/customers", { kind: "organisation", name: "Someone Else" }, Customer)
    theirProperty = await create(other, "/properties", body(b.projects.copenhagen.id, "Havnegade 2"), Property)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }

  /** A property body a caller may send: the four fields with no default, and nothing else. */
  const body = (projectId: string, name: string) => ({ projectId, name, address: `${name}, 1000 København`, kind: "residential" })

  const create = async <T>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> => {
    const response = await call(path, { method: "POST", body: values })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  const one = async (call: Call, id: string): Promise<Property> => {
    const response = await call(`/properties/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Property.parse(await response.json())
  }
  const patch = async (call: Call, id: string, values: unknown): Promise<Property> => {
    const response = await call(`/properties/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Property.parse(await response.json())
  }
  const putParties = async (call: Call, id: string, parties: unknown): Promise<Property> => {
    const response = await call(`/properties/${id}/parties`, { method: "PUT", body: { parties } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Property.parse(await response.json())
  }
  const page = async (call: Call, query = "") => PropertyPage.parse(await (await call(`/properties${query}`)).json())
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }

  describe("POST /properties", () => {
    test("mints the id, defaults the status to active, and is unlocated and unheld until it is told otherwise", async () => {
      const created = await create(olivia, "/properties", body(a.projects.copenhagen.id, "Parkvej 18"), Property)
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.equal(created.projectId, a.projects.copenhagen.id)
      assert.equal(created.status, "active", "a property is registered in order to be served")
      assert.equal(created.location, null, "a property is registered before it is geocoded")
      assert.deepEqual(created.parties, [])
      assert.deepEqual(await one(olivia, created.id), created)
    })

    test("takes the location as GeoJSON and reads it back as GeoJSON", async () => {
      const created = await create(olivia, "/properties", { ...body(a.projects.copenhagen.id, "Rådhuspladsen 1"), location: townHall }, Property)
      assert.deepEqual(created.location, townHall)
      assert.deepEqual((await one(olivia, created.id)).location, townHall)
    })

    test("refuses a point outside WGS 84 before the database sees it", async () => {
      const problem = await refused(
        await olivia("/properties", {
          method: "POST",
          body: { ...body(a.projects.copenhagen.id, "Off the globe"), location: { type: "Point", coordinates: [200, 55.6761] } },
        }),
        400,
      )
      assert.deepEqual(
        problem.errors?.map((error) => error.path),
        ["location.coordinates.0"],
      )
    })

    test("writes the parties the body starts with, each a customer of this company", async () => {
      const created = await create(
        olivia,
        "/properties",
        {
          ...body(a.projects.copenhagen.id, "Strandvej 4"),
          parties: [
            { customerId: housing.id, role: "owner" },
            { customerId: housing.id, role: "payer" },
            { customerId: tenantCustomer.id, role: "tenant" },
          ],
        },
        Property,
      )
      assert.deepEqual(
        created.parties,
        inReadOrder([
          { customerId: housing.id, role: "owner" },
          { customerId: housing.id, role: "payer" },
          { customerId: tenantCustomer.id, role: "tenant" },
        ]),
        "the customer, then the role: the order a page reads a set in",
      )
      assert.deepEqual(await one(olivia, created.id), created, "the answer is what the next read says")
    })

    test("refuses a party naming another company's customer, at the indexed path", async () => {
      const problem = await refused(
        await olivia("/properties", {
          method: "POST",
          body: {
            ...body(a.projects.copenhagen.id, "Foreign party"),
            parties: [
              { customerId: housing.id, role: "owner" },
              { customerId: theirCustomer.id, role: "payer" },
            ],
          },
        }),
        400,
      )
      assert.deepEqual(problem.errors, [{ path: "parties.1.customerId", message: "Not a customer of this company" }])
      const unminted = await refused(
        await olivia("/properties", {
          method: "POST",
          body: { ...body(a.projects.copenhagen.id, "Nobody's party"), parties: [{ customerId: testId(), role: "owner" }] },
        }),
        400,
      )
      assert.deepEqual(unminted.errors, [{ path: "parties.0.customerId", message: "Not a customer of this company" }])
      assert.deepEqual((await page(olivia, "?limit=200")).items.filter((held) => held.name === "Foreign party"), [], "and nothing was written")
    })

    test("refuses the same customer in the same role twice", async () => {
      const problem = await refused(
        await olivia("/properties", {
          method: "POST",
          body: {
            ...body(a.projects.copenhagen.id, "Twice over"),
            parties: [
              { customerId: housing.id, role: "owner" },
              { customerId: housing.id, role: "owner" },
            ],
          },
        }),
        400,
      )
      assert.deepEqual(
        problem.errors?.map((error) => error.path),
        ["parties"],
      )
    })

    test("refuses a project the caller does not work in, and a member the server owns", async () => {
      const foreign = await refused(await olivia("/properties", { method: "POST", body: body(b.projects.copenhagen.id, "Theirs now") }), 400)
      assert.deepEqual(foreign.errors, [{ path: "projectId", message: "Not a project this account works in" }])
      const owned = await refused(
        await olivia("/properties", { method: "POST", body: { ...body(a.projects.copenhagen.id, "Client minted"), id: testId() } }),
        400,
      )
      assert.ok(owned.errors?.some((error) => /id/.test(error.message)), JSON.stringify(owned.errors))
    })

    test("refuses a name the project already uses, and lets another project use it", async () => {
      await create(olivia, "/properties", body(a.projects.copenhagen.id, "Søndergade 7"), Property)
      const problem = await refused(await olivia("/properties", { method: "POST", body: body(a.projects.copenhagen.id, "Søndergade 7") }), 409)
      assert.match(problem.detail ?? "", /"Søndergade 7"/)
      assert.doesNotMatch(problem.detail ?? "", /_key/)
      assert.equal(
        (await create(olivia, "/properties", body(a.projects.harbor.id, "Søndergade 7"), Property)).projectId,
        a.projects.harbor.id,
      )
    })

    test("refuses a registry identifier the company already holds, whatever project it is in", async () => {
      await create(olivia, "/properties", { ...body(a.projects.copenhagen.id, "BFE one"), registryId: "10000001" }, Property)
      const problem = await refused(
        await olivia("/properties", { method: "POST", body: { ...body(a.projects.harbor.id, "BFE one again"), registryId: "10000001" } }),
        409,
      )
      assert.match(problem.detail ?? "", /10000001/)
      assert.doesNotMatch(problem.detail ?? "", /_idx/)
    })

    test("refuses a role that may view but not create", async () => {
      const problem = await refused(await lars("/properties", { method: "POST", body: body(a.projects.copenhagen.id, "Not mine") }), 403)
      assert.match(problem.detail ?? "", /create on customers\.properties/)
    })
  })

  describe("GET /properties", () => {
    test("answers the company's properties in id order and holds nothing of another company's", async () => {
      const mine = await create(olivia, "/properties", body(a.projects.copenhagen.id, "Nørrebrogade 40"), Property)
      const ids = (await page(olivia, "?limit=200")).items.map((held) => held.id)
      assert.ok(ids.includes(mine.id))
      assert.deepEqual(ids, [...ids].sort(), "ascending by id")
      assert.ok(!ids.includes(theirProperty.id))
      assert.deepEqual((await page(other, "?limit=200")).items.map((held) => held.name), ["Havnegade 2"])
    })

    test("carries each property's parties with it", async () => {
      const created = await create(
        olivia,
        "/properties",
        { ...body(a.projects.copenhagen.id, "Vestergade 3"), parties: [{ customerId: housing.id, role: "administrator" }] },
        Property,
      )
      const found = (await page(olivia, "?limit=200")).items.find((held) => held.id === created.id)
      assert.deepEqual(found?.parties, [{ customerId: housing.id, role: "administrator" }])
    })

    test("walks the pages with the cursor, each item carrying its own parties and none of the next record's", async () => {
      const all = (await page(olivia, "?limit=200")).items
      assert.ok(all.length >= 2)
      assert.ok(all.some((held) => held.parties.length > 0), "and at least one of them has parties to carry")
      const first = await page(olivia, "?limit=1")
      assert.deepEqual(first.items, all.slice(0, 1), "one item, with its own parties: the surplus row that proved there is a next page is not one of them")
      assert.ok(first.nextCursor !== null)
      const rest = await page(olivia, `?limit=200&cursor=${first.nextCursor}`)
      assert.deepEqual(rest.items, all.slice(1))
      assert.equal(rest.nextCursor, null)
    })

    test("shows an account only the projects it works in, and answers an empty page to one that works in none", async () => {
      const here = await create(olivia, "/properties", body(a.projects.copenhagen.id, "Istedgade 11"), Property)
      const elsewhere = await create(olivia, "/properties", body(a.projects.harbor.id, "Kajgade 5"), Property)
      const seen = (await page(viewer, "?limit=200")).items
      assert.ok(seen.some((held) => held.id === here.id))
      assert.ok(!seen.some((held) => held.id === elsewhere.id))
      for (const held of seen) assert.equal(held.projectId, a.projects.copenhagen.id)
      assert.deepEqual(await page(lars, "?limit=200"), { items: [], nextCursor: null })
    })

    test("filters the page by project, and refuses a project the caller does not work in", async () => {
      const harbor = await create(olivia, "/properties", body(a.projects.harbor.id, "Pier 9"), Property)
      const filtered = await page(olivia, `?limit=200&projectId=${a.projects.harbor.id}`)
      assert.ok(filtered.items.some((held) => held.id === harbor.id))
      for (const held of filtered.items) assert.equal(held.projectId, a.projects.harbor.id)
      const problem = await refused(await viewer(`/properties?projectId=${a.projects.harbor.id}`), 400)
      assert.equal(problem.detail, "The request query is invalid")
      assert.deepEqual(problem.errors, [{ path: "projectId", message: "Not a project this account works in" }])
    })

    test("answers exactly the properties a party row names when a customer is given, each once", async () => {
      const ida = await create(olivia, "/customers", { kind: "person", name: "Ida Kold" }, Customer)
      const twoRoles = await create(
        olivia,
        "/properties",
        {
          ...body(a.projects.copenhagen.id, "Kolds hus"),
          parties: [
            { customerId: ida.id, role: "owner" },
            { customerId: ida.id, role: "payer" },
          ],
        },
        Property,
      )
      const harbor = await create(
        olivia,
        "/properties",
        { ...body(a.projects.harbor.id, "Kolds lager"), parties: [{ customerId: ida.id, role: "owner" }] },
        Property,
      )
      await create(olivia, "/properties", body(a.projects.copenhagen.id, "Nobody's house"), Property)

      const held = (await page(olivia, `?limit=200&customerId=${ida.id}`)).items
      assert.deepEqual(held.map((property) => property.id).sort(), [twoRoles.id, harbor.id].sort(), "each property once, however many roles")
      const inCopenhagen = (await page(olivia, `?limit=200&customerId=${ida.id}&projectId=${a.projects.copenhagen.id}`)).items
      assert.deepEqual(inCopenhagen.map((property) => property.id), [twoRoles.id], "the two filters together")
      assert.deepEqual((await page(olivia, `?limit=200&customerId=${testId()}`)).items, [], "a customer nobody is a party for")
    })

    test("refuses a role without customers.properties view, and a caller with no token", async () => {
      assert.match((await refused(await ungranted("/properties"), 403)).detail ?? "", /view on customers\.properties/)
      assert.equal((await app.request("/properties")).status, 401)
    })
  })

  describe("GET /properties/:id", () => {
    test("answers 404 for another company's property, for one in a project the caller does not work in, and for an id nobody minted", async () => {
      const foreign = await refused(await olivia(`/properties/${theirProperty.id}`), 404)
      assert.match(foreign.detail ?? "", /property/i)
      assert.equal((await one(other, theirProperty.id)).name, "Havnegade 2", "still there for its own company")

      const elsewhere = await create(olivia, "/properties", body(a.projects.harbor.id, "Kran 3"), Property)
      await refused(await viewer(`/properties/${elsewhere.id}`), 404)
      assert.equal((await one(olivia, elsewhere.id)).name, "Kran 3")
      await refused(await olivia(`/properties/${testId()}`), 404)
      assert.deepEqual(
        (await refused(await olivia("/properties/not-a-uuid"), 400)).errors?.map((error) => error.path),
        ["id"],
      )
    })
  })

  describe("PATCH /properties/:id", () => {
    test("changes what the body names, leaves the parties alone, and answers the row as it now stands", async () => {
      const created = await create(
        olivia,
        "/properties",
        { ...body(a.projects.copenhagen.id, "Bredgade 6"), location: townHall, parties: [{ customerId: housing.id, role: "owner" }] },
        Property,
      )
      const changed = await patch(olivia, created.id, { status: "inactive", notes: "Demolished" })
      assert.equal(changed.status, "inactive")
      assert.equal(changed.notes, "Demolished")
      assert.deepEqual(changed.parties, [{ customerId: housing.id, role: "owner" }], "a patch is not how a set changes")
      assert.deepEqual(changed.location, townHall, "what the patch did not name it did not touch")
      assert.ok(changed.updatedAt > created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), changed)

      const cleared = await patch(olivia, created.id, { location: null })
      assert.equal(cleared.location, null, "a geocode may be taken back")
    })

    test("refuses an empty patch, the parties, the project, another company's property and one out of the caller's projects", async () => {
      const created = await create(olivia, "/properties", body(a.projects.copenhagen.id, "Gothersgade 12"), Property)
      assert.deepEqual(
        (await refused(await olivia(`/properties/${created.id}`, { method: "PATCH", body: {} }), 400)).errors?.map((error) => error.path),
        [""],
      )
      const withParties = await refused(
        await olivia(`/properties/${created.id}`, { method: "PATCH", body: { parties: [{ customerId: housing.id, role: "owner" }] } }),
        400,
      )
      assert.ok(withParties.errors?.some((error) => /parties/.test(error.message)), JSON.stringify(withParties.errors))
      const moved = await refused(await olivia(`/properties/${created.id}`, { method: "PATCH", body: { projectId: a.projects.harbor.id } }), 400)
      assert.ok(moved.errors?.some((error) => /projectId/.test(error.message)), JSON.stringify(moved.errors))

      await refused(await olivia(`/properties/${theirProperty.id}`, { method: "PATCH", body: { status: "inactive" } }), 404)
      assert.equal((await one(other, theirProperty.id)).status, "active")
      const elsewhere = await create(olivia, "/properties", body(a.projects.harbor.id, "Kran 4"), Property)
      await refused(await viewer(`/properties/${elsewhere.id}`, { method: "PATCH", body: { status: "inactive" } }), 404)
    })

    test("refuses a rename onto a name the project already uses", async () => {
      await create(olivia, "/properties", body(a.projects.copenhagen.id, "Taken already"), Property)
      const created = await create(olivia, "/properties", body(a.projects.copenhagen.id, "Free to rename"), Property)
      const problem = await refused(await olivia(`/properties/${created.id}`, { method: "PATCH", body: { name: "Taken already" } }), 409)
      assert.match(problem.detail ?? "", /"Taken already"/)
      assert.equal((await one(olivia, created.id)).name, "Free to rename")
    })

    test("refuses a role that may view but not edit", async () => {
      const created = await create(olivia, "/properties", body(a.projects.copenhagen.id, "Not theirs to change"), Property)
      const problem = await refused(await lars(`/properties/${created.id}`, { method: "PATCH", body: { status: "inactive" } }), 403)
      assert.match(problem.detail ?? "", /edit on customers\.properties/)
    })
  })

  describe("PUT /properties/:id/parties", () => {
    test("replaces the whole set: what the body leaves out is gone, and the record is stamped", async () => {
      const created = await create(
        olivia,
        "/properties",
        {
          ...body(a.projects.copenhagen.id, "Amagerbrogade 21"),
          parties: [
            { customerId: housing.id, role: "owner" },
            { customerId: tenantCustomer.id, role: "tenant" },
          ],
        },
        Property,
      )
      const replaced = await putParties(olivia, created.id, [{ customerId: tenantCustomer.id, role: "payer" }])
      assert.deepEqual(replaced.parties, [{ customerId: tenantCustomer.id, role: "payer" }])
      assert.ok(replaced.updatedAt > created.updatedAt, "the record the set belongs to moved")
      assert.deepEqual(await one(olivia, created.id), replaced)

      const emptied = await putParties(olivia, created.id, [])
      assert.deepEqual(emptied.parties, [], "an empty list is a property nobody is billed for")
    })

    test("refuses a party naming another company's customer, at the indexed path, and writes nothing", async () => {
      const created = await create(
        olivia,
        "/properties",
        { ...body(a.projects.copenhagen.id, "Enghavevej 8"), parties: [{ customerId: housing.id, role: "owner" }] },
        Property,
      )
      const problem = await refused(
        await olivia(`/properties/${created.id}/parties`, {
          method: "PUT",
          body: {
            parties: [
              { customerId: housing.id, role: "owner" },
              { customerId: theirCustomer.id, role: "payer" },
            ],
          },
        }),
        400,
      )
      assert.deepEqual(problem.errors, [{ path: "parties.1.customerId", message: "Not a customer of this company" }])
      const unchanged = await one(olivia, created.id)
      assert.deepEqual(unchanged.parties, [{ customerId: housing.id, role: "owner" }], "the set it had is the set it has")
      assert.equal(unchanged.updatedAt, created.updatedAt, "and the stamp the replacement took rolled back with the rest of it")
    })

    test("refuses the same pair twice, a body that names no list, and a role outside the vocabulary", async () => {
      const created = await create(olivia, "/properties", body(a.projects.copenhagen.id, "Valby Langgade 2"), Property)
      const twice = await refused(
        await olivia(`/properties/${created.id}/parties`, {
          method: "PUT",
          body: {
            parties: [
              { customerId: housing.id, role: "owner" },
              { customerId: housing.id, role: "owner" },
            ],
          },
        }),
        400,
      )
      assert.deepEqual(twice.errors?.map((error) => error.path), ["parties"])
      assert.deepEqual(
        (await refused(await olivia(`/properties/${created.id}/parties`, { method: "PUT", body: {} }), 400)).errors?.map((error) => error.path),
        ["parties"],
      )
      assert.deepEqual(
        (await refused(
          await olivia(`/properties/${created.id}/parties`, { method: "PUT", body: { parties: [{ customerId: housing.id, role: "landlord" }] } }),
          400,
        )).errors?.map((error) => error.path),
        ["parties.0.role"],
      )
    })

    test("answers 404 for another company's property and one in a project the caller does not work in", async () => {
      await refused(await olivia(`/properties/${theirProperty.id}/parties`, { method: "PUT", body: { parties: [] } }), 404)
      const elsewhere = await create(olivia, "/properties", body(a.projects.harbor.id, "Kran 5"), Property)
      await refused(await viewer(`/properties/${elsewhere.id}/parties`, { method: "PUT", body: { parties: [] } }), 404)
    })

    test("refuses a role that may view but not edit", async () => {
      const created = await create(olivia, "/properties", body(a.projects.copenhagen.id, "Not theirs to hold"), Property)
      const problem = await refused(await lars(`/properties/${created.id}/parties`, { method: "PUT", body: { parties: [] } }), 403)
      assert.match(problem.detail ?? "", /edit on customers\.properties/)
    })
  })
})
