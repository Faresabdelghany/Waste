import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Customer, Property, SharedCollectionPoint } from "@waste/contracts/customers"
import type { Point } from "@waste/contracts/geojson"
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
const SharedCollectionPointPage = Page(SharedCollectionPoint)

const MODULE = "customers.shared"

/** Copenhagen town hall, where every point in this file stands until it is moved. */
const townHall: Point = { type: "Point", coordinates: [12.5683, 55.6761] }
/** A few streets away, for a point that moves. */
const kongensNytorv: Point = { type: "Point", coordinates: [12.5851, 55.6797] }

/** The order a set reads back in: the property a member names, which it names once. */
const inReadOrder = <Entry extends { propertyId: string }>(members: readonly Entry[]): Entry[] =>
  [...members].sort((left, right) => (left.propertyId < right.propertyId ? -1 : 1))

describe("the shared collection point endpoints", { skip: database.skip }, () => {
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

  /** Copenhagen properties, what a point of that project may serve. */
  let parkvej: Property
  let strandvej: Property
  /** A property of this company in another project: not this point's to serve. */
  let pier: Property
  /** This company's customer, who a point may answer to. */
  let housing: Customer
  /** The other company's. */
  let theirCustomer: Customer
  let theirPoint: SharedCollectionPoint

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
    theirPoint = await create(other, "/shared-collection-points", body(b.projects.copenhagen.id, "Their yard"), SharedCollectionPoint)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }

  /** A point body a caller may send: the fields with no default, and nothing else. */
  const body = (projectId: string, name: string) => ({
    projectId,
    name,
    kind: "underground",
    address: `${name}, 1000 København`,
    location: townHall,
    operatingModel: "municipal",
    accessMode: "member",
    billingMode: "member-share",
  })
  const propertyBody = (projectId: string, name: string) => ({ projectId, name, address: `${name}, 1000 København`, kind: "residential" })

  const create = async <T extends { id: string }>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> =>
    created(call, path, await call(path, { method: "POST", body: values }), schema)
  const one = async (call: Call, id: string): Promise<SharedCollectionPoint> => {
    const response = await call(`/shared-collection-points/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return SharedCollectionPoint.parse(await response.json())
  }
  const patch = async (call: Call, id: string, values: unknown): Promise<SharedCollectionPoint> => {
    const response = await call(`/shared-collection-points/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return SharedCollectionPoint.parse(await response.json())
  }
  const putMembers = async (call: Call, id: string, members: unknown): Promise<SharedCollectionPoint> => {
    const response = await call(`/shared-collection-points/${id}/members`, { method: "PUT", body: { members } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return SharedCollectionPoint.parse(await response.json())
  }
  const page = async (call: Call, query = "") => SharedCollectionPointPage.parse(await (await call(`/shared-collection-points${query}`)).json())
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }

  describe("POST /shared-collection-points", () => {
    test("mints the id, defaults the status to draft, stands where the body puts it, and serves nobody until it is told to", async () => {
      const created = await create(olivia, "/shared-collection-points", body(a.projects.copenhagen.id, "Rådhus yard"), SharedCollectionPoint)
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.equal(created.projectId, a.projects.copenhagen.id)
      assert.equal(created.status, "draft", "a point is planned before it takes waste")
      assert.deepEqual(created.location, townHall, "the place is the record")
      assert.equal(created.eligibilityDistanceM, null)
      assert.equal(created.responsibleCustomerId, null)
      assert.deepEqual(created.members, [])
      assert.deepEqual(await one(olivia, created.id), created)
    })

    test("takes the customer it answers to, the distance it serves, and the members it starts with", async () => {
      const created = await create(
        olivia,
        "/shared-collection-points",
        {
          ...body(a.projects.copenhagen.id, "Kystbyen yard"),
          status: "open",
          eligibilityDistanceM: 150,
          accessConditions: "Members open the hatch with their tag",
          availability: "Around the clock",
          responsibleCustomerId: housing.id,
          members: [
            { propertyId: parkvej.id, role: "service-member" },
            { propertyId: strandvej.id, role: "payer" },
          ],
        },
        SharedCollectionPoint,
      )
      assert.equal(created.status, "open")
      assert.equal(created.eligibilityDistanceM, 150)
      assert.equal(created.responsibleCustomerId, housing.id)
      assert.deepEqual(
        created.members,
        inReadOrder([
          { propertyId: parkvej.id, role: "service-member" },
          { propertyId: strandvej.id, role: "payer" },
        ]),
        "the property: the order a page reads a set in",
      )
      assert.deepEqual(await one(olivia, created.id), created, "the answer is what the next read says")
    })

    test("insists on a place, refuses one off the globe before the database sees it, and refuses a distance of nothing", async () => {
      const unplaced = await refused(
        await olivia("/shared-collection-points", { method: "POST", body: { ...body(a.projects.copenhagen.id, "Nowhere"), location: undefined } }),
        400,
      )
      assert.deepEqual(unplaced.errors?.map((error) => error.path), ["location"])
      const offTheGlobe = await refused(
        await olivia("/shared-collection-points", {
          method: "POST",
          body: { ...body(a.projects.copenhagen.id, "Off the globe"), location: { type: "Point", coordinates: [12.5683, 91] } },
        }),
        400,
      )
      assert.deepEqual(offTheGlobe.errors?.map((error) => error.path), ["location.coordinates.1"])
      const lifted = await refused(
        await olivia("/shared-collection-points", {
          method: "POST",
          body: { ...body(a.projects.copenhagen.id, "Lifted"), location: { type: "Point", coordinates: [12.5683, 55.6761, 10] } },
        }),
        400,
      )
      assert.deepEqual(lifted.errors?.map((error) => error.path), ["location.coordinates"], "a third ordinate: the column is flat, and the refusal is the contracts' and never PostGIS's 22023 (#101)")
      const noDistance = await refused(
        await olivia("/shared-collection-points", { method: "POST", body: { ...body(a.projects.copenhagen.id, "No reach"), eligibilityDistanceM: 0 } }),
        400,
      )
      assert.deepEqual(noDistance.errors?.map((error) => error.path), ["eligibilityDistanceM"])
    })

    test("refuses a customer that is not this company's, naming the field", async () => {
      const problem = await refused(
        await olivia("/shared-collection-points", {
          method: "POST",
          body: { ...body(a.projects.copenhagen.id, "Foreign owner"), responsibleCustomerId: theirCustomer.id },
        }),
        400,
      )
      assert.deepEqual(problem.errors, [{ path: "responsibleCustomerId", message: "Not a customer of this company" }])
    })

    test("refuses a member that is not a property of the point's own project, at the indexed path", async () => {
      const problem = await refused(
        await olivia("/shared-collection-points", {
          method: "POST",
          body: {
            ...body(a.projects.copenhagen.id, "Reaching out"),
            members: [
              { propertyId: parkvej.id, role: "service-member" },
              { propertyId: pier.id, role: "service-member" },
            ],
          },
        }),
        400,
      )
      assert.deepEqual(problem.errors, [{ path: "members.1.propertyId", message: "Not a property of this project" }])
      assert.deepEqual((await page(olivia, "?limit=200")).items.filter((point) => point.name === "Reaching out"), [], "and nothing was written")
      assert.equal(
        (await create(
          olivia,
          "/shared-collection-points",
          { ...body(a.projects.harbor.id, "Harbour yard"), members: [{ propertyId: pier.id, role: "service-member" }] },
          SharedCollectionPoint,
        )).members.length,
        1,
        "and the same property is fine at a point of its own project",
      )
    })

    test("refuses the same property twice, a project the caller does not work in, and a member the server owns", async () => {
      const twice = await refused(
        await olivia("/shared-collection-points", {
          method: "POST",
          body: {
            ...body(a.projects.copenhagen.id, "Twice over"),
            members: [
              { propertyId: parkvej.id, role: "service-member" },
              { propertyId: parkvej.id, role: "payer" },
            ],
          },
        }),
        400,
      )
      assert.deepEqual(twice.errors?.map((error) => error.path), ["members"])
      const foreign = await refused(
        await olivia("/shared-collection-points", { method: "POST", body: body(b.projects.copenhagen.id, "Theirs now") }),
        400,
      )
      assert.deepEqual(foreign.errors, [{ path: "projectId", message: "Not a project this account works in" }])
      const owned = await refused(
        await olivia("/shared-collection-points", { method: "POST", body: { ...body(a.projects.copenhagen.id, "Client minted"), id: testId() } }),
        400,
      )
      assert.ok(owned.errors?.some((error) => /id/.test(error.message)), JSON.stringify(owned.errors))
    })

    test("refuses a name the project already uses, and lets another project use it", async () => {
      await create(olivia, "/shared-collection-points", body(a.projects.copenhagen.id, "Søndergade yard"), SharedCollectionPoint)
      const problem = await refused(
        await olivia("/shared-collection-points", { method: "POST", body: body(a.projects.copenhagen.id, "Søndergade yard") }),
        409,
      )
      assert.match(problem.detail ?? "", /"Søndergade yard"/)
      assert.doesNotMatch(problem.detail ?? "", /_key/)
      assert.equal(
        (await create(olivia, "/shared-collection-points", body(a.projects.harbor.id, "Søndergade yard"), SharedCollectionPoint)).projectId,
        a.projects.harbor.id,
      )
    })

    test("refuses a role that may view but not create", async () => {
      const problem = await refused(await lars("/shared-collection-points", { method: "POST", body: body(a.projects.copenhagen.id, "Not mine") }), 403)
      assert.match(problem.detail ?? "", /create on customers\.shared/)
    })
  })

  describe("GET /shared-collection-points", () => {
    test("answers the company's points in id order, each with its members, and holds nothing of another company's", async () => {
      const mine = await create(
        olivia,
        "/shared-collection-points",
        { ...body(a.projects.copenhagen.id, "Nørrebro yard"), members: [{ propertyId: parkvej.id, role: "service-member" }] },
        SharedCollectionPoint,
      )
      const items = (await page(olivia, "?limit=200")).items
      const ids = items.map((point) => point.id)
      assert.ok(ids.includes(mine.id))
      assert.deepEqual(ids, [...ids].sort(), "ascending by id")
      assert.ok(!ids.includes(theirPoint.id))
      assert.deepEqual(items.find((point) => point.id === mine.id)?.members, [{ propertyId: parkvej.id, role: "service-member" }])
      assert.deepEqual((await page(other, "?limit=200")).items.map((point) => point.name), ["Their yard"])
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
      const here = await create(olivia, "/shared-collection-points", body(a.projects.copenhagen.id, "Istedgade yard"), SharedCollectionPoint)
      const elsewhere = await create(olivia, "/shared-collection-points", body(a.projects.harbor.id, "Kajgade yard"), SharedCollectionPoint)
      const seen = (await page(viewer, "?limit=200")).items
      assert.ok(seen.some((point) => point.id === here.id))
      assert.ok(!seen.some((point) => point.id === elsewhere.id))
      for (const point of seen) assert.equal(point.projectId, a.projects.copenhagen.id)
      assert.deepEqual(await page(lars, "?limit=200"), { items: [], nextCursor: null })
    })

    test("filters the page by project, and refuses a project the caller does not work in", async () => {
      const harbor = await create(olivia, "/shared-collection-points", body(a.projects.harbor.id, "Pier yard"), SharedCollectionPoint)
      const filtered = await page(olivia, `?limit=200&projectId=${a.projects.harbor.id}`)
      assert.ok(filtered.items.some((point) => point.id === harbor.id))
      for (const point of filtered.items) assert.equal(point.projectId, a.projects.harbor.id)
      const problem = await refused(await viewer(`/shared-collection-points?projectId=${a.projects.harbor.id}`), 400)
      assert.equal(problem.detail, "The request query is invalid")
      assert.deepEqual(problem.errors, [{ path: "projectId", message: "Not a project this account works in" }])
    })

    test("refuses a role without customers.shared view, and a caller with no token", async () => {
      assert.match((await refused(await ungranted("/shared-collection-points"), 403)).detail ?? "", /view on customers\.shared/)
      assert.equal((await app.request("/shared-collection-points")).status, 401)
    })
  })

  describe("GET /shared-collection-points/:id", () => {
    test("answers 404 for another company's point, for one in a project the caller does not work in, and for an id nobody minted", async () => {
      const foreign = await refused(await olivia(`/shared-collection-points/${theirPoint.id}`), 404)
      assert.match(foreign.detail ?? "", /shared collection point/i)
      assert.equal((await one(other, theirPoint.id)).name, "Their yard", "still there for its own company")

      const elsewhere = await create(olivia, "/shared-collection-points", body(a.projects.harbor.id, "Kran yard"), SharedCollectionPoint)
      await refused(await viewer(`/shared-collection-points/${elsewhere.id}`), 404)
      assert.equal((await one(olivia, elsewhere.id)).name, "Kran yard")
      await refused(await olivia(`/shared-collection-points/${testId()}`), 404)
      assert.deepEqual(
        (await refused(await olivia("/shared-collection-points/not-a-uuid"), 400)).errors?.map((error) => error.path),
        ["id"],
      )
    })
  })

  describe("PATCH /shared-collection-points/:id", () => {
    test("changes what the body names, moves the place, leaves the members alone, and answers the row as it now stands", async () => {
      const created = await create(
        olivia,
        "/shared-collection-points",
        {
          ...body(a.projects.copenhagen.id, "Bredgade yard"),
          eligibilityDistanceM: 100,
          responsibleCustomerId: housing.id,
          members: [{ propertyId: parkvej.id, role: "service-member" }],
        },
        SharedCollectionPoint,
      )
      const changed = await patch(olivia, created.id, { status: "open", location: kongensNytorv, accessMode: "open" })
      assert.equal(changed.status, "open")
      assert.equal(changed.accessMode, "open")
      assert.deepEqual(changed.location, kongensNytorv, "the place moved")
      assert.deepEqual(changed.members, [{ propertyId: parkvej.id, role: "service-member" }], "a patch is not how a set changes")
      assert.equal(changed.eligibilityDistanceM, 100, "what the patch did not name it did not touch")
      assert.ok(changed.updatedAt > created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), changed)

      const cleared = await patch(olivia, created.id, { eligibilityDistanceM: null, responsibleCustomerId: null })
      assert.equal(cleared.eligibilityDistanceM, null)
      assert.equal(cleared.responsibleCustomerId, null, "a point may answer to nobody in particular")
    })

    test("refuses a customer that is not this company's, an empty patch, the members, the project, and a row out of reach", async () => {
      const created = await create(olivia, "/shared-collection-points", body(a.projects.copenhagen.id, "Gothersgade yard"), SharedCollectionPoint)
      const foreign = await refused(
        await olivia(`/shared-collection-points/${created.id}`, { method: "PATCH", body: { responsibleCustomerId: theirCustomer.id } }),
        400,
      )
      assert.deepEqual(foreign.errors, [{ path: "responsibleCustomerId", message: "Not a customer of this company" }])
      const unminted = await refused(
        await olivia(`/shared-collection-points/${testId()}`, { method: "PATCH", body: { responsibleCustomerId: theirCustomer.id } }),
        404,
      )
      assert.match(
        unminted.detail ?? "",
        /shared collection point/i,
        "the row is read before the patch's references, so an id nobody minted is the 404 it is everywhere else",
      )
      assert.deepEqual(
        (await refused(await olivia(`/shared-collection-points/${created.id}`, { method: "PATCH", body: {} }), 400)).errors?.map((error) => error.path),
        [""],
      )
      const withMembers = await refused(
        await olivia(`/shared-collection-points/${created.id}`, {
          method: "PATCH",
          body: { members: [{ propertyId: parkvej.id, role: "service-member" }] },
        }),
        400,
      )
      assert.ok(withMembers.errors?.some((error) => /members/.test(error.message)), JSON.stringify(withMembers.errors))
      const moved = await refused(
        await olivia(`/shared-collection-points/${created.id}`, { method: "PATCH", body: { projectId: a.projects.harbor.id } }),
        400,
      )
      assert.ok(moved.errors?.some((error) => /projectId/.test(error.message)), JSON.stringify(moved.errors))

      await refused(await olivia(`/shared-collection-points/${theirPoint.id}`, { method: "PATCH", body: { status: "open" } }), 404)
      assert.equal((await one(other, theirPoint.id)).status, "draft")
      const elsewhere = await create(olivia, "/shared-collection-points", body(a.projects.harbor.id, "Kran 4 yard"), SharedCollectionPoint)
      await refused(await viewer(`/shared-collection-points/${elsewhere.id}`, { method: "PATCH", body: { status: "open" } }), 404)
    })

    test("refuses a rename onto a name the project already uses, and a role that may view but not edit", async () => {
      await create(olivia, "/shared-collection-points", body(a.projects.copenhagen.id, "Taken already"), SharedCollectionPoint)
      const created = await create(olivia, "/shared-collection-points", body(a.projects.copenhagen.id, "Free to rename"), SharedCollectionPoint)
      const taken = await refused(await olivia(`/shared-collection-points/${created.id}`, { method: "PATCH", body: { name: "Taken already" } }), 409)
      assert.match(taken.detail ?? "", /"Taken already"/)
      assert.equal((await one(olivia, created.id)).name, "Free to rename")
      const ungrantedEdit = await refused(await lars(`/shared-collection-points/${created.id}`, { method: "PATCH", body: { status: "open" } }), 403)
      assert.match(ungrantedEdit.detail ?? "", /edit on customers\.shared/)
    })
  })

  describe("PUT /shared-collection-points/:id/members", () => {
    test("replaces the whole set: what the body leaves out is gone, and the record is stamped", async () => {
      const created = await create(
        olivia,
        "/shared-collection-points",
        {
          ...body(a.projects.copenhagen.id, "Amagerbro yard"),
          members: [
            { propertyId: parkvej.id, role: "service-member" },
            { propertyId: strandvej.id, role: "administrator" },
          ],
        },
        SharedCollectionPoint,
      )
      const replaced = await putMembers(olivia, created.id, [{ propertyId: strandvej.id, role: "payer" }])
      assert.deepEqual(replaced.members, [{ propertyId: strandvej.id, role: "payer" }])
      assert.ok(replaced.updatedAt > created.updatedAt, "the record the set belongs to moved")
      assert.deepEqual(await one(olivia, created.id), replaced)

      const emptied = await putMembers(olivia, created.id, [])
      assert.deepEqual(emptied.members, [], "a point nobody puts waste at yet")
    })

    test("refuses a member out of the point's project, at the indexed path, and writes nothing", async () => {
      const created = await create(
        olivia,
        "/shared-collection-points",
        { ...body(a.projects.copenhagen.id, "Enghave yard"), members: [{ propertyId: parkvej.id, role: "service-member" }] },
        SharedCollectionPoint,
      )
      const problem = await refused(
        await olivia(`/shared-collection-points/${created.id}/members`, {
          method: "PUT",
          body: {
            members: [
              { propertyId: parkvej.id, role: "service-member" },
              { propertyId: pier.id, role: "service-member" },
            ],
          },
        }),
        400,
      )
      assert.deepEqual(problem.errors, [{ path: "members.1.propertyId", message: "Not a property of this project" }])
      const unchanged = await one(olivia, created.id)
      assert.deepEqual(unchanged.members, [{ propertyId: parkvej.id, role: "service-member" }], "the set it had is the set it has")
      assert.equal(unchanged.updatedAt, created.updatedAt, "and the stamp the replacement took rolled back with the rest of it")
    })

    test("refuses the same property twice, a body that names no list, and a role outside the vocabulary", async () => {
      const created = await create(olivia, "/shared-collection-points", body(a.projects.copenhagen.id, "Valby yard"), SharedCollectionPoint)
      const twice = await refused(
        await olivia(`/shared-collection-points/${created.id}/members`, {
          method: "PUT",
          body: {
            members: [
              { propertyId: parkvej.id, role: "service-member" },
              { propertyId: parkvej.id, role: "payer" },
            ],
          },
        }),
        400,
      )
      assert.deepEqual(twice.errors?.map((error) => error.path), ["members"])
      assert.deepEqual(
        (await refused(await olivia(`/shared-collection-points/${created.id}/members`, { method: "PUT", body: {} }), 400)).errors?.map(
          (error) => error.path,
        ),
        ["members"],
      )
      assert.deepEqual(
        (await refused(
          await olivia(`/shared-collection-points/${created.id}/members`, {
            method: "PUT",
            body: { members: [{ propertyId: parkvej.id, role: "janitor" }] },
          }),
          400,
        )).errors?.map((error) => error.path),
        ["members.0.role"],
      )
    })

    test("answers 404 out of reach, and 403 to a role that may view but not edit", async () => {
      await refused(await olivia(`/shared-collection-points/${theirPoint.id}/members`, { method: "PUT", body: { members: [] } }), 404)
      const elsewhere = await create(olivia, "/shared-collection-points", body(a.projects.harbor.id, "Kran 5 yard"), SharedCollectionPoint)
      await refused(await viewer(`/shared-collection-points/${elsewhere.id}/members`, { method: "PUT", body: { members: [] } }), 404)
      const created = await create(olivia, "/shared-collection-points", body(a.projects.copenhagen.id, "Not theirs to fill"), SharedCollectionPoint)
      const problem = await refused(await lars(`/shared-collection-points/${created.id}/members`, { method: "PUT", body: { members: [] } }), 403)
      assert.match(problem.detail ?? "", /edit on customers\.shared/)
    })
  })
})
