import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { after, before, describe, test } from "node:test"

import { Role } from "@waste/contracts/access"
import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const RolePage = Page(Role)

/** A name no other role in the company holds. */
const roleName = (prefix: string) => `${prefix} ${randomBytes(3).toString("hex")}`

describe("the role endpoints", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  /** Tenant A is written to; tenant B is only ever read, so its three seeded roles are a stable page. */
  let a: Tenant
  let b: Tenant
  let app: ReturnType<typeof createApp>
  let olivia: Call
  let viewer: Call
  let lars: Call
  let other: Call

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  const page = async (call: Call, query = "") => {
    const response = await call(`/roles${query}`)
    assert.equal(response.status, 200, query)
    return RolePage.parse(await response.json())
  }
  const one = async (call: Call, id: string) => {
    const response = await call(`/roles/${id}`)
    assert.equal(response.status, 200)
    return Role.parse(await response.json())
  }
  const create = async (call: Call, values: Record<string, unknown>) => {
    const response = await call("/roles", { method: "POST", body: values })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return Role.parse(await response.json())
  }
  const setGrants = async (call: Call, id: string, grants: unknown) => {
    const response = await call(`/roles/${id}/grants`, { method: "PUT", body: { grants } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Role.parse(await response.json())
  }

  describe("GET /roles", () => {
    test("answers the company's roles in id order, each with its whole matrix", async () => {
      const { items, nextCursor } = await page(other, "?limit=200")
      assert.equal(items.length, 3)
      assert.equal(nextCursor, null)
      const ids = items.map((role) => role.id)
      assert.deepEqual(ids, [...ids].sort(), "ascending by id")

      const byName = new Map(items.map((role) => [role.name, role]))
      const administrator = byName.get("Company Administrator")
      assert.equal(administrator?.key, "company-administrator")
      assert.equal(administrator?.system, true)
      assert.deepEqual(administrator?.grants, b.roles.administrator.grants, "the charter it was seeded with, normalised")
      const custom = byName.get("Viewer")
      assert.equal(custom?.key, null, "a custom role has no key")
      assert.equal(custom?.system, false)
      assert.deepEqual(custom?.grants, [{ moduleKey: "configure.access", actions: ["view"] }])
      assert.deepEqual(items[0], await one(other, ids[0]), "a row in the list is the row on its own")
    })

    test("holds nothing of another company's", async () => {
      const mine = (await page(olivia, "?limit=200")).items.map((role) => role.id)
      const theirs = (await page(other, "?limit=200")).items.map((role) => role.id)
      assert.ok(mine.includes(a.roles.administrator.id))
      for (const id of theirs) assert.ok(!mine.includes(id), `${id} belongs to the other company`)
    })

    test("walks the pages with the cursor and says when there is no next one", async () => {
      const all = (await page(other, "?limit=200")).items
      const first = await page(other, "?limit=2")
      assert.deepEqual(first.items, all.slice(0, 2))
      assert.ok(first.nextCursor !== null)
      const second = await page(other, `?limit=2&cursor=${first.nextCursor}`)
      assert.deepEqual(second.items, all.slice(2))
      assert.equal(second.nextCursor, null)
    })

    test("refuses a cursor it did not write and a page size outside 1..200", async () => {
      const cursor = await other("/roles?cursor=nonsense")
      assert.equal(cursor.status, 400)
      assert.deepEqual((await readProblem(cursor)).errors?.map((error) => error.path), ["cursor"])
      const limit = await other("/roles?limit=0")
      assert.equal(limit.status, 400)
      assert.deepEqual((await readProblem(limit)).errors?.map((error) => error.path), ["limit"])
    })

    test("lets a role with configure.access view list, refuses one without the module, and refuses no token at all", async () => {
      assert.equal((await viewer("/roles")).status, 200)
      const refused = await lars("/roles")
      assert.equal(refused.status, 403)
      assert.match((await readProblem(refused)).detail ?? "", /view on configure\.access/)
      assert.equal((await app.request("/roles")).status, 401)
    })
  })

  describe("POST /roles", () => {
    test("creates a custom role: no key, not a system role, and no grants unless the body says so", async () => {
      const name = roleName("Weekend Dispatcher")
      const created = await create(olivia, { name, scope: "Assigned projects", description: "Weekends only" })
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.equal(created.key, null)
      assert.equal(created.system, false)
      assert.deepEqual(created.grants, [])
      assert.equal(created.createdAt, created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), created)
      assert.ok((await page(olivia, "?limit=200")).items.some((role) => role.id === created.id))
    })

    test("stores the matrix as the system spells it: view implied, a module named twice merged, sorted", async () => {
      const created = await create(olivia, {
        name: roleName("Ticket Handler"),
        scope: "Assigned projects",
        description: "Tickets and the drivers behind them",
        grants: [
          { moduleKey: "operate.tickets", actions: ["delete"] },
          { moduleKey: "fleet.drivers", actions: ["edit"] },
          { moduleKey: "operate.tickets", actions: ["create"] },
          { moduleKey: "fleet.vehicles", actions: [] },
        ],
      })
      assert.deepEqual(created.grants, [
        { moduleKey: "fleet.drivers", actions: ["view", "edit"] },
        { moduleKey: "operate.tickets", actions: ["view", "create", "delete"] },
      ])
      assert.deepEqual((await one(olivia, created.id)).grants, created.grants, "and that is what was written")
    })

    test("refuses a name the company already uses, and writes nothing", async () => {
      const before_ = (await page(olivia, "?limit=200")).items.length
      const response = await olivia("/roles", { method: "POST", body: { name: "Viewer", scope: "Company", description: "Again" } })
      assert.equal(response.status, 409)
      const problem = await readProblem(response)
      assert.equal(problem.title, "Conflict")
      assert.match(problem.detail ?? "", /Viewer/)
      assert.doesNotMatch(problem.detail ?? "", /_key/)
      assert.equal((await page(olivia, "?limit=200")).items.length, before_)
    })

    test("lets another company use the same name: a role name is unique inside a company", async () => {
      const name = roleName("Shared Name")
      await create(olivia, { name, scope: "Company", description: "d" })
      assert.equal((await create(other, { name, scope: "Company", description: "d" })).name, name)
    })

    test("refuses a missing field, a member the server owns, and a grant outside the vocabulary", async () => {
      const body = { name: roleName("Bad"), scope: "Company", description: "d" }
      const missing = await olivia("/roles", { method: "POST", body: { scope: "Company", description: "d" } })
      assert.equal(missing.status, 400)
      assert.deepEqual((await readProblem(missing)).errors?.map((error) => error.path), ["name"])

      for (const owned of ["key", "system"]) {
        const response = await olivia("/roles", { method: "POST", body: { ...body, [owned]: "x" } })
        assert.equal(response.status, 400, owned)
        assert.ok((await readProblem(response)).errors?.some((error) => new RegExp(owned).test(error.message)), owned)
      }

      const unknown = await olivia("/roles", {
        method: "POST",
        body: { ...body, grants: [{ moduleKey: "configure.nope", actions: ["view"] }] },
      })
      assert.equal(unknown.status, 400)
      assert.deepEqual((await readProblem(unknown)).errors?.map((error) => error.path), ["grants.0.moduleKey"])
    })

    test("refuses a role that may view but not create", async () => {
      const body = { name: roleName("Not mine"), scope: "Company", description: "d" }
      const refused = await viewer("/roles", { method: "POST", body })
      assert.equal(refused.status, 403)
      assert.match((await readProblem(refused)).detail ?? "", /create on configure\.access/)
      assert.equal((await lars("/roles", { method: "POST", body })).status, 403)
    })
  })

  describe("GET /roles/:id", () => {
    test("answers one role of the caller's company, 404 for another's, and 400 for a path that is not an id", async () => {
      const found = await one(olivia, a.roles.providerManager.id)
      assert.equal(found.name, "Service Provider Manager")
      assert.deepEqual(found.grants, a.roles.providerManager.grants)

      const missing = await olivia(`/roles/${b.roles.viewer.id}`)
      assert.equal(missing.status, 404)
      assert.match((await readProblem(missing)).detail ?? "", /role/i)
      assert.equal((await one(other, b.roles.viewer.id)).name, "Viewer", "and it is still there for its own company")
      assert.equal((await olivia(`/roles/${testId()}`)).status, 404)

      const malformed = await olivia("/roles/not-a-uuid")
      assert.equal(malformed.status, 400)
      assert.deepEqual((await readProblem(malformed)).errors?.map((error) => error.path), ["id"])
    })
  })

  describe("PATCH /roles/:id", () => {
    test("changes the copy and leaves the matrix alone", async () => {
      const created = await create(olivia, {
        name: roleName("Before"),
        scope: "Company",
        description: "d",
        grants: [{ moduleKey: "operate.tickets", actions: ["view"] }],
      })
      const name = roleName("After")
      const response = await olivia(`/roles/${created.id}`, { method: "PATCH", body: { name, description: "Renamed" } })
      assert.equal(response.status, 200)
      const patched = Role.parse(await response.json())
      assert.equal(patched.name, name)
      assert.equal(patched.description, "Renamed")
      assert.equal(patched.scope, "Company", "what the patch did not name it did not touch")
      assert.deepEqual(patched.grants, created.grants)
      assert.ok(patched.updatedAt > created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), patched)
    })

    test("renames a system role too: only its key and its system flag are its for life", async () => {
      const name = roleName("Provider Manager")
      const response = await olivia(`/roles/${a.roles.providerManager.id}`, { method: "PATCH", body: { name, scope: "Own service provider" } })
      assert.equal(response.status, 200)
      const patched = Role.parse(await response.json())
      assert.equal(patched.name, name)
      assert.equal(patched.key, "service-provider-manager")
      assert.equal(patched.system, true)

      for (const owned of ["key", "system"]) {
        const refused = await olivia(`/roles/${a.roles.providerManager.id}`, { method: "PATCH", body: { [owned]: "x" } })
        assert.equal(refused.status, 400, owned)
        assert.ok((await readProblem(refused)).errors?.some((error) => new RegExp(owned).test(error.message)), owned)
      }
      await olivia(`/roles/${a.roles.providerManager.id}`, { method: "PATCH", body: { name: "Service Provider Manager" } })
    })

    test("refuses an empty patch, a rename onto a name in use, 404 for another company's role, and a role that may only view", async () => {
      const created = await create(olivia, { name: roleName("Patch me"), scope: "Company", description: "d" })
      const empty = await olivia(`/roles/${created.id}`, { method: "PATCH", body: {} })
      assert.equal(empty.status, 400)
      assert.deepEqual((await readProblem(empty)).errors?.map((error) => error.path), [""])

      const taken = await olivia(`/roles/${created.id}`, { method: "PATCH", body: { name: "Viewer" } })
      assert.equal(taken.status, 409)
      const problem = await readProblem(taken)
      assert.match(problem.detail ?? "", /Viewer/)
      assert.doesNotMatch(problem.detail ?? "", /_key/)
      assert.equal((await one(olivia, created.id)).name, created.name, "and the role is as it was")

      const missing = await olivia(`/roles/${b.roles.viewer.id}`, { method: "PATCH", body: { name: "Mine now" } })
      assert.equal(missing.status, 404)
      assert.equal((await one(other, b.roles.viewer.id)).name, "Viewer")

      const refused = await viewer(`/roles/${created.id}`, { method: "PATCH", body: { name: "Not mine" } })
      assert.equal(refused.status, 403)
      assert.match((await readProblem(refused)).detail ?? "", /edit on configure\.access/)
    })
  })

  describe("PUT /roles/:id/grants", () => {
    test("replaces the whole matrix: what the body leaves out is gone, and what it names is normalised", async () => {
      const created = await create(olivia, {
        name: roleName("Matrix"),
        scope: "Company",
        description: "d",
        grants: [
          { moduleKey: "operate.tickets", actions: ["view", "edit"] },
          { moduleKey: "fleet.vehicles", actions: ["view"] },
        ],
      })
      const replaced = await setGrants(olivia, created.id, [
        { moduleKey: "operate.tickets", actions: ["delete"] },
        { moduleKey: "customers.contacts", actions: ["create"] },
        { moduleKey: "operate.tickets", actions: ["edit"] },
        { moduleKey: "resources.containers", actions: [] },
      ])
      assert.deepEqual(replaced.grants, [
        { moduleKey: "customers.contacts", actions: ["view", "create"] },
        { moduleKey: "operate.tickets", actions: ["view", "edit", "delete"] },
      ])
      assert.deepEqual(await one(olivia, created.id), replaced)
      assert.ok(!replaced.grants.some((grant) => grant.moduleKey === "fleet.vehicles"), "a grant the body left out is gone")
      assert.ok(replaced.updatedAt > created.updatedAt, "the matrix is part of the role, so the role changed")

      const emptied = await setGrants(olivia, created.id, [])
      assert.deepEqual(emptied.grants, [], "a role that may do nothing")
      assert.deepEqual((await one(olivia, created.id)).grants, [])
    })

    test("replaces a system role's matrix too, and gives it back", async () => {
      const id = a.roles.providerManager.id
      const narrowed = await setGrants(olivia, id, [{ moduleKey: "operate.tickets", actions: ["edit"] }])
      assert.deepEqual(narrowed.grants, [{ moduleKey: "operate.tickets", actions: ["view", "edit"] }])
      assert.equal(narrowed.key, "service-provider-manager", "its key and its system flag are untouched")
      assert.equal(narrowed.system, true)
      const restored = await setGrants(olivia, id, a.roles.providerManager.grants)
      assert.deepEqual(restored.grants, a.roles.providerManager.grants)
    })

    test("refuses a grant outside the vocabulary, a body without the matrix, and a member it does not own", async () => {
      const created = await create(olivia, { name: roleName("Refuser"), scope: "Company", description: "d" })
      const cases: [unknown, string][] = [
        [{ grants: [{ moduleKey: "configure.nope", actions: ["view"] }] }, "grants.0.moduleKey"],
        [{ grants: [{ moduleKey: "operate.tickets", actions: ["approve"] }] }, "grants.0.actions.0"],
        [{}, "grants"],
      ]
      for (const [body, path] of cases) {
        const response = await olivia(`/roles/${created.id}/grants`, { method: "PUT", body })
        assert.equal(response.status, 400, path)
        assert.deepEqual((await readProblem(response)).errors?.map((error) => error.path), [path], JSON.stringify(body))
      }
      const owned = await olivia(`/roles/${created.id}/grants`, { method: "PUT", body: { grants: [], system: true } })
      assert.equal(owned.status, 400)
      assert.ok((await readProblem(owned)).errors?.some((error) => /system/.test(error.message)))
      assert.deepEqual((await one(olivia, created.id)).grants, [], "and nothing was written")
    })

    test("answers 404 for another company's role and leaves its matrix alone, 403 for a role that may only view, 401 without a token", async () => {
      const missing = await olivia(`/roles/${b.roles.viewer.id}/grants`, { method: "PUT", body: { grants: [] } })
      assert.equal(missing.status, 404)
      await readProblem(missing)
      assert.deepEqual((await one(other, b.roles.viewer.id)).grants, [{ moduleKey: "configure.access", actions: ["view"] }])
      assert.equal((await olivia(`/roles/${testId()}/grants`, { method: "PUT", body: { grants: [] } })).status, 404)

      const refused = await viewer(`/roles/${a.roles.viewer.id}/grants`, { method: "PUT", body: { grants: [] } })
      assert.equal(refused.status, 403)
      assert.match((await readProblem(refused)).detail ?? "", /edit on configure\.access/)
      assert.equal(
        (await app.request(`/roles/${a.roles.viewer.id}/grants`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status,
        401,
      )
      assert.deepEqual((await one(olivia, a.roles.viewer.id)).grants, [{ moduleKey: "configure.access", actions: ["view"] }])
    })
  })
})
