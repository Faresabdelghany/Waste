import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Customer, Property, PropertyGroup } from "@waste/contracts/customers"
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
const PropertyGroupPage = Page(PropertyGroup)

const MODULE = "customers.groups"

/** The order a set reads back in: the property a member names, which it names once. */
const inReadOrder = <Entry extends { propertyId: string }>(members: readonly Entry[]): Entry[] =>
  [...members].sort((left, right) => (left.propertyId < right.propertyId ? -1 : 1))

describe("the property group endpoints", { skip: database.skip }, () => {
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

  /** Copenhagen properties, what a group of that project may gather. */
  let parkvej: Property
  let strandvej: Property
  /** A property of this company in another project: not this group's to gather. */
  let pier: Property
  /** This company's customer, who a group may answer to. */
  let housing: Customer
  /** The other company's. */
  let theirCustomer: Customer
  let theirGroup: PropertyGroup

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

    parkvej = await create(olivia, "/properties", propertyBody(a.projects.copenhagen.id, "Parkvej 18"), Property)
    strandvej = await create(olivia, "/properties", propertyBody(a.projects.copenhagen.id, "Strandvej 4"), Property)
    pier = await create(olivia, "/properties", propertyBody(a.projects.harbor.id, "Pier 9"), Property)
    housing = await create(olivia, "/customers", { kind: "organisation", name: "Kystbyen Housing" }, Customer)
    theirCustomer = await create(other, "/customers", { kind: "organisation", name: "Someone Else" }, Customer)
    theirGroup = await create(other, "/property-groups", body(b.projects.copenhagen.id, "Their block"), PropertyGroup)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }

  /** A group body a caller may send: the three fields with no default, and nothing else. */
  const body = (projectId: string, name: string) => ({ projectId, name, purpose: "administration" })
  const propertyBody = (projectId: string, name: string) => ({ projectId, name, address: `${name}, 1000 København`, kind: "residential" })

  const create = async <T extends { id: string }>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> =>
    created(call, path, await call(path, { method: "POST", body: values }), schema)
  const one = async (call: Call, id: string): Promise<PropertyGroup> => {
    const response = await call(`/property-groups/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return PropertyGroup.parse(await response.json())
  }
  const patch = async (call: Call, id: string, values: unknown): Promise<PropertyGroup> => {
    const response = await call(`/property-groups/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return PropertyGroup.parse(await response.json())
  }
  const putMembers = async (call: Call, id: string, members: unknown): Promise<PropertyGroup> => {
    const response = await call(`/property-groups/${id}/members`, { method: "PUT", body: { members } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return PropertyGroup.parse(await response.json())
  }
  const page = async (call: Call, query = "") => PropertyGroupPage.parse(await (await call(`/property-groups${query}`)).json())
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }

  describe("POST /property-groups", () => {
    test("mints the id, defaults the status to draft, and gathers nobody until it is told to", async () => {
      const created = await create(olivia, "/property-groups", body(a.projects.copenhagen.id, "Parkvej blocks"), PropertyGroup)
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.equal(created.projectId, a.projects.copenhagen.id)
      assert.equal(created.status, "draft", "a group is gathered before it is used")
      assert.equal(created.responsibleCustomerId, null)
      assert.deepEqual(created.members, [])
      assert.deepEqual(await one(olivia, created.id), created)
    })

    test("takes the customer it answers to and the members it starts with", async () => {
      const created = await create(
        olivia,
        "/property-groups",
        {
          ...body(a.projects.copenhagen.id, "Kystbyen east"),
          status: "active",
          responsibleCustomerId: housing.id,
          members: [
            { propertyId: parkvej.id, role: "member" },
            { propertyId: strandvej.id, role: "administrator" },
          ],
        },
        PropertyGroup,
      )
      assert.equal(created.status, "active")
      assert.equal(created.responsibleCustomerId, housing.id)
      assert.deepEqual(
        created.members,
        inReadOrder([
          { propertyId: parkvej.id, role: "member" },
          { propertyId: strandvej.id, role: "administrator" },
        ]),
        "the property: the order a page reads a set in",
      )
      assert.deepEqual(await one(olivia, created.id), created, "the answer is what the next read says")
    })

    test("refuses a customer that is not this company's, naming the field", async () => {
      const problem = await refused(
        await olivia("/property-groups", {
          method: "POST",
          body: { ...body(a.projects.copenhagen.id, "Foreign owner"), responsibleCustomerId: theirCustomer.id },
        }),
        400,
      )
      assert.deepEqual(problem.errors, [{ path: "responsibleCustomerId", message: "Not a customer of this company" }])
      const unminted = await refused(
        await olivia("/property-groups", {
          method: "POST",
          body: { ...body(a.projects.copenhagen.id, "Nobody's owner"), responsibleCustomerId: testId() },
        }),
        400,
      )
      assert.deepEqual(unminted.errors, [{ path: "responsibleCustomerId", message: "Not a customer of this company" }])
    })

    test("refuses a member that is not a property of the group's own project, at the indexed path", async () => {
      const problem = await refused(
        await olivia("/property-groups", {
          method: "POST",
          body: {
            ...body(a.projects.copenhagen.id, "Reaching out"),
            members: [
              { propertyId: parkvej.id, role: "member" },
              { propertyId: pier.id, role: "member" },
            ],
          },
        }),
        400,
      )
      assert.deepEqual(problem.errors, [{ path: "members.1.propertyId", message: "Not a property of this project" }])
      assert.deepEqual((await page(olivia, "?limit=200")).items.filter((group) => group.name === "Reaching out"), [], "and nothing was written")
      assert.equal(
        (await create(
          olivia,
          "/property-groups",
          { ...body(a.projects.harbor.id, "Harbour blocks"), members: [{ propertyId: pier.id, role: "member" }] },
          PropertyGroup,
        )).members.length,
        1,
        "and the same property is fine in a group of its own project",
      )
    })

    test("refuses the same property twice", async () => {
      const problem = await refused(
        await olivia("/property-groups", {
          method: "POST",
          body: {
            ...body(a.projects.copenhagen.id, "Twice over"),
            members: [
              { propertyId: parkvej.id, role: "member" },
              { propertyId: parkvej.id, role: "payer" },
            ],
          },
        }),
        400,
      )
      assert.deepEqual(problem.errors?.map((error) => error.path), ["members"])
    })

    test("refuses a project the caller does not work in, and a member the server owns", async () => {
      const foreign = await refused(await olivia("/property-groups", { method: "POST", body: body(b.projects.copenhagen.id, "Theirs now") }), 400)
      assert.deepEqual(foreign.errors, [{ path: "projectId", message: "Not a project this account works in" }])
      const owned = await refused(
        await olivia("/property-groups", { method: "POST", body: { ...body(a.projects.copenhagen.id, "Client minted"), id: testId() } }),
        400,
      )
      assert.ok(owned.errors?.some((error) => /id/.test(error.message)), JSON.stringify(owned.errors))
    })

    test("refuses a name the project already uses, and lets another project use it", async () => {
      await create(olivia, "/property-groups", body(a.projects.copenhagen.id, "Søndergade"), PropertyGroup)
      const problem = await refused(await olivia("/property-groups", { method: "POST", body: body(a.projects.copenhagen.id, "Søndergade") }), 409)
      assert.match(problem.detail ?? "", /"Søndergade"/)
      assert.doesNotMatch(problem.detail ?? "", /_key/)
      assert.equal(
        (await create(olivia, "/property-groups", body(a.projects.harbor.id, "Søndergade"), PropertyGroup)).projectId,
        a.projects.harbor.id,
      )
    })

    test("refuses a role that may view but not create", async () => {
      const problem = await refused(await lars("/property-groups", { method: "POST", body: body(a.projects.copenhagen.id, "Not mine") }), 403)
      assert.match(problem.detail ?? "", /create on customers\.groups/)
    })
  })

  describe("GET /property-groups", () => {
    test("answers the company's groups in id order, each with its members, and holds nothing of another company's", async () => {
      const mine = await create(
        olivia,
        "/property-groups",
        { ...body(a.projects.copenhagen.id, "Nørrebro blocks"), members: [{ propertyId: parkvej.id, role: "member" }] },
        PropertyGroup,
      )
      const items = (await page(olivia, "?limit=200")).items
      const ids = items.map((group) => group.id)
      assert.ok(ids.includes(mine.id))
      assert.deepEqual(ids, [...ids].sort(), "ascending by id")
      assert.ok(!ids.includes(theirGroup.id))
      assert.deepEqual(items.find((group) => group.id === mine.id)?.members, [{ propertyId: parkvej.id, role: "member" }])
      assert.deepEqual((await page(other, "?limit=200")).items.map((group) => group.name), ["Their block"])
    })

    test("walks the pages with the cursor, each item carrying its own members and none of the next record's", async () => {
      const all = (await page(olivia, "?limit=200")).items
      assert.ok(all.length >= 2)
      assert.ok(all.some((held) => held.members.length > 0), "and at least one of them has members to carry")
      const first = await page(olivia, "?limit=1")
      assert.deepEqual(first.items, all.slice(0, 1), "one item, with its own members: the surplus row that proved there is a next page is not one of them")
      assert.ok(first.nextCursor !== null)
      const rest = await page(olivia, `?limit=200&cursor=${first.nextCursor}`)
      assert.deepEqual(rest.items, all.slice(1))
      assert.equal(rest.nextCursor, null)
    })

    test("shows an account only the projects it works in, and answers an empty page to one that works in none", async () => {
      const here = await create(olivia, "/property-groups", body(a.projects.copenhagen.id, "Istedgade blocks"), PropertyGroup)
      const elsewhere = await create(olivia, "/property-groups", body(a.projects.harbor.id, "Kajgade blocks"), PropertyGroup)
      const seen = (await page(viewer, "?limit=200")).items
      assert.ok(seen.some((group) => group.id === here.id))
      assert.ok(!seen.some((group) => group.id === elsewhere.id))
      for (const group of seen) assert.equal(group.projectId, a.projects.copenhagen.id)
      assert.deepEqual(await page(lars, "?limit=200"), { items: [], nextCursor: null })
    })

    test("filters the page by project, and refuses a project the caller does not work in", async () => {
      const harbor = await create(olivia, "/property-groups", body(a.projects.harbor.id, "Pier blocks"), PropertyGroup)
      const filtered = await page(olivia, `?limit=200&projectId=${a.projects.harbor.id}`)
      assert.ok(filtered.items.some((group) => group.id === harbor.id))
      for (const group of filtered.items) assert.equal(group.projectId, a.projects.harbor.id)
      const problem = await refused(await viewer(`/property-groups?projectId=${a.projects.harbor.id}`), 400)
      assert.equal(problem.detail, "The request query is invalid")
      assert.deepEqual(problem.errors, [{ path: "projectId", message: "Not a project this account works in" }])
    })

    test("refuses a role without customers.groups view, and a caller with no token", async () => {
      assert.match((await refused(await ungranted("/property-groups"), 403)).detail ?? "", /view on customers\.groups/)
      assert.equal((await app.request("/property-groups")).status, 401)
    })
  })

  describe("GET /property-groups/:id", () => {
    test("answers 404 for another company's group, for one in a project the caller does not work in, and for an id nobody minted", async () => {
      const foreign = await refused(await olivia(`/property-groups/${theirGroup.id}`), 404)
      assert.match(foreign.detail ?? "", /property group/i)
      assert.equal((await one(other, theirGroup.id)).name, "Their block", "still there for its own company")

      const elsewhere = await create(olivia, "/property-groups", body(a.projects.harbor.id, "Kran blocks"), PropertyGroup)
      await refused(await viewer(`/property-groups/${elsewhere.id}`), 404)
      assert.equal((await one(olivia, elsewhere.id)).name, "Kran blocks")
      await refused(await olivia(`/property-groups/${testId()}`), 404)
      assert.deepEqual(
        (await refused(await olivia("/property-groups/not-a-uuid"), 400)).errors?.map((error) => error.path),
        ["id"],
      )
    })
  })

  describe("PATCH /property-groups/:id", () => {
    test("changes what the body names, leaves the members alone, and answers the row as it now stands", async () => {
      const created = await create(
        olivia,
        "/property-groups",
        {
          ...body(a.projects.copenhagen.id, "Bredgade blocks"),
          responsibleCustomerId: housing.id,
          members: [{ propertyId: parkvej.id, role: "member" }],
        },
        PropertyGroup,
      )
      const changed = await patch(olivia, created.id, { status: "active", purpose: "reporting" })
      assert.equal(changed.status, "active")
      assert.equal(changed.purpose, "reporting")
      assert.deepEqual(changed.members, [{ propertyId: parkvej.id, role: "member" }], "a patch is not how a set changes")
      assert.equal(changed.responsibleCustomerId, housing.id, "what the patch did not name it did not touch")
      assert.ok(changed.updatedAt > created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), changed)

      const cleared = await patch(olivia, created.id, { responsibleCustomerId: null })
      assert.equal(cleared.responsibleCustomerId, null, "a group may answer to nobody in particular")
    })

    test("refuses a customer that is not this company's, an empty patch, the members, the project, and a row out of reach", async () => {
      const created = await create(olivia, "/property-groups", body(a.projects.copenhagen.id, "Gothersgade blocks"), PropertyGroup)
      const foreign = await refused(
        await olivia(`/property-groups/${created.id}`, { method: "PATCH", body: { responsibleCustomerId: theirCustomer.id } }),
        400,
      )
      assert.deepEqual(foreign.errors, [{ path: "responsibleCustomerId", message: "Not a customer of this company" }])
      const unminted = await refused(
        await olivia(`/property-groups/${testId()}`, { method: "PATCH", body: { responsibleCustomerId: theirCustomer.id } }),
        404,
      )
      assert.match(unminted.detail ?? "", /property group/i, "the row is read before the patch's references, so an id nobody minted is the 404 it is everywhere else")
      assert.deepEqual(
        (await refused(await olivia(`/property-groups/${created.id}`, { method: "PATCH", body: {} }), 400)).errors?.map((error) => error.path),
        [""],
      )
      const withMembers = await refused(
        await olivia(`/property-groups/${created.id}`, { method: "PATCH", body: { members: [{ propertyId: parkvej.id, role: "member" }] } }),
        400,
      )
      assert.ok(withMembers.errors?.some((error) => /members/.test(error.message)), JSON.stringify(withMembers.errors))
      const moved = await refused(await olivia(`/property-groups/${created.id}`, { method: "PATCH", body: { projectId: a.projects.harbor.id } }), 400)
      assert.ok(moved.errors?.some((error) => /projectId/.test(error.message)), JSON.stringify(moved.errors))

      await refused(await olivia(`/property-groups/${theirGroup.id}`, { method: "PATCH", body: { status: "active" } }), 404)
      assert.equal((await one(other, theirGroup.id)).status, "draft")
      const elsewhere = await create(olivia, "/property-groups", body(a.projects.harbor.id, "Kran 4 blocks"), PropertyGroup)
      await refused(await viewer(`/property-groups/${elsewhere.id}`, { method: "PATCH", body: { status: "active" } }), 404)
    })

    test("refuses a rename onto a name the project already uses, and a role that may view but not edit", async () => {
      await create(olivia, "/property-groups", body(a.projects.copenhagen.id, "Taken already"), PropertyGroup)
      const created = await create(olivia, "/property-groups", body(a.projects.copenhagen.id, "Free to rename"), PropertyGroup)
      const taken = await refused(await olivia(`/property-groups/${created.id}`, { method: "PATCH", body: { name: "Taken already" } }), 409)
      assert.match(taken.detail ?? "", /"Taken already"/)
      assert.equal((await one(olivia, created.id)).name, "Free to rename")
      const ungrantedEdit = await refused(await lars(`/property-groups/${created.id}`, { method: "PATCH", body: { status: "active" } }), 403)
      assert.match(ungrantedEdit.detail ?? "", /edit on customers\.groups/)
    })
  })

  describe("PUT /property-groups/:id/members", () => {
    test("replaces the whole set: what the body leaves out is gone, and the record is stamped", async () => {
      const created = await create(
        olivia,
        "/property-groups",
        {
          ...body(a.projects.copenhagen.id, "Amagerbro blocks"),
          members: [
            { propertyId: parkvej.id, role: "member" },
            { propertyId: strandvej.id, role: "administrator" },
          ],
        },
        PropertyGroup,
      )
      const replaced = await putMembers(olivia, created.id, [{ propertyId: strandvej.id, role: "payer" }])
      assert.deepEqual(replaced.members, [{ propertyId: strandvej.id, role: "payer" }])
      assert.ok(replaced.updatedAt > created.updatedAt, "the record the set belongs to moved")
      assert.deepEqual(await one(olivia, created.id), replaced)

      const emptied = await putMembers(olivia, created.id, [])
      assert.deepEqual(emptied.members, [], "an empty group is a group nobody is in")
    })

    test("refuses a member out of the group's project, at the indexed path, and writes nothing", async () => {
      const created = await create(
        olivia,
        "/property-groups",
        { ...body(a.projects.copenhagen.id, "Enghave blocks"), members: [{ propertyId: parkvej.id, role: "member" }] },
        PropertyGroup,
      )
      const problem = await refused(
        await olivia(`/property-groups/${created.id}/members`, {
          method: "PUT",
          body: {
            members: [
              { propertyId: parkvej.id, role: "member" },
              { propertyId: pier.id, role: "member" },
            ],
          },
        }),
        400,
      )
      assert.deepEqual(problem.errors, [{ path: "members.1.propertyId", message: "Not a property of this project" }])
      const unchanged = await one(olivia, created.id)
      assert.deepEqual(unchanged.members, [{ propertyId: parkvej.id, role: "member" }], "the set it had is the set it has")
      assert.equal(unchanged.updatedAt, created.updatedAt, "and the stamp the replacement took rolled back with the rest of it")
    })

    test("refuses the same property twice, a body that names no list, and a role outside the vocabulary", async () => {
      const created = await create(olivia, "/property-groups", body(a.projects.copenhagen.id, "Valby blocks"), PropertyGroup)
      const twice = await refused(
        await olivia(`/property-groups/${created.id}/members`, {
          method: "PUT",
          body: {
            members: [
              { propertyId: parkvej.id, role: "member" },
              { propertyId: parkvej.id, role: "payer" },
            ],
          },
        }),
        400,
      )
      assert.deepEqual(twice.errors?.map((error) => error.path), ["members"])
      assert.deepEqual(
        (await refused(await olivia(`/property-groups/${created.id}/members`, { method: "PUT", body: {} }), 400)).errors?.map((error) => error.path),
        ["members"],
      )
      assert.deepEqual(
        (await refused(
          await olivia(`/property-groups/${created.id}/members`, { method: "PUT", body: { members: [{ propertyId: parkvej.id, role: "janitor" }] } }),
          400,
        )).errors?.map((error) => error.path),
        ["members.0.role"],
      )
    })

    test("answers 404 out of reach, and 403 to a role that may view but not edit", async () => {
      await refused(await olivia(`/property-groups/${theirGroup.id}/members`, { method: "PUT", body: { members: [] } }), 404)
      const elsewhere = await create(olivia, "/property-groups", body(a.projects.harbor.id, "Kran 5 blocks"), PropertyGroup)
      await refused(await viewer(`/property-groups/${elsewhere.id}/members`, { method: "PUT", body: { members: [] } }), 404)
      const created = await create(olivia, "/property-groups", body(a.projects.copenhagen.id, "Not theirs to gather"), PropertyGroup)
      const problem = await refused(await lars(`/property-groups/${created.id}/members`, { method: "PUT", body: { members: [] } }), 403)
      assert.match(problem.detail ?? "", /edit on customers\.groups/)
    })
  })
})
