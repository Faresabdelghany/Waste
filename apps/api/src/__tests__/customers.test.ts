import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Customer } from "@waste/contracts/customers"
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
const CustomerPage = Page(Customer)

const MODULE = "customers.contacts"

describe("the customer endpoints", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  /** The company under test. */
  let a: Tenant
  /** The other company, written to once below and never again. */
  let b: Tenant
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The Service Provider Manager, granted view: a role that may look and not write. */
  let lars: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call
  /** The other company's customer, with a registration number this company may use too. */
  let theirs: Customer

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.providerManager.id, [{ moduleKey: MODULE, actions: ["view"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)

    theirs = await create(other, { kind: "organisation", name: "Havnegade Ejendomme", registrationNumber: "87654321" })
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  const create = async (call: Call, values: unknown): Promise<Customer> =>
    created(call, "/customers", await call("/customers", { method: "POST", body: values }), Customer)
  const one = async (call: Call, id: string): Promise<Customer> => {
    const response = await call(`/customers/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Customer.parse(await response.json())
  }
  const patch = async (call: Call, id: string, values: unknown): Promise<Customer> => {
    const response = await call(`/customers/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Customer.parse(await response.json())
  }
  const page = async (call: Call, query = "") => CustomerPage.parse(await (await call(`/customers${query}`)).json())
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }

  describe("POST /customers", () => {
    test("mints the id, serves the customer until they say otherwise, and leaves out what nobody gave", async () => {
      const created = await create(olivia, { kind: "person", name: "Anna Jensen" })
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.equal(created.kind, "person")
      assert.equal(created.status, "active", "a customer is registered in order to be served")
      assert.equal(created.serviceMessagesAllowed, true)
      assert.deepEqual(
        [created.registrationNumber, created.email, created.phone, created.billingAddress],
        [null, null, null, null],
      )
      assert.equal(created.createdAt, created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), created)
    })

    test("stores the e-mail lowercase, whatever case it arrived in", async () => {
      const created = await create(olivia, { kind: "person", name: "Bo Nielsen", email: "Bo.Nielsen@Example.COM" })
      assert.equal(created.email, "bo.nielsen@example.com")
      assert.equal((await one(olivia, created.id)).email, "bo.nielsen@example.com")
    })

    test("takes an organisation with everything a bill needs", async () => {
      const created = await create(olivia, {
        kind: "organisation",
        name: "Kystvej Boligforening",
        registrationNumber: "11223344",
        email: "kontor@example.com",
        phone: "+45 33 44 55 66",
        billingAddress: "Kystvej 4\n2300 København S",
        serviceMessagesAllowed: false,
        status: "inactive",
      })
      assert.equal(created.registrationNumber, "11223344")
      assert.equal(created.serviceMessagesAllowed, false)
      assert.equal(created.status, "inactive")
      assert.match(created.billingAddress ?? "", /\n/, "a billing address is prose, newlines and all")
    })

    test("refuses a body missing a field, spelling one wrongly, or naming a member the server owns", async () => {
      const nameless = await refused(await olivia("/customers", { method: "POST", body: { kind: "person" } }), 400)
      assert.deepEqual(nameless.errors?.map((error) => error.path), ["name"])
      const wrong = await refused(
        await olivia("/customers", { method: "POST", body: { kind: "company", name: "Nobody", email: "not-an-address" } }),
        400,
      )
      assert.deepEqual(wrong.errors?.map((error) => error.path), ["kind", "email"])
      const owned = await refused(
        await olivia("/customers", { method: "POST", body: { id: testId(), kind: "person", name: "Client Minted" } }),
        400,
      )
      assert.ok(owned.errors?.some((error) => /id/.test(error.message)), JSON.stringify(owned.errors))
    })

    test("refuses a registration number the company already uses, and lets another company use it", async () => {
      await create(olivia, { kind: "organisation", name: "Strandvejens Bolig", registrationNumber: "87654321" })
      const problem = await refused(
        await olivia("/customers", { method: "POST", body: { kind: "organisation", name: "Another", registrationNumber: "87654321" } }),
        409,
      )
      assert.equal(problem.detail, "This company already has a customer with registration number 87654321")
      assert.doesNotMatch(problem.detail ?? "", /_idx/)
      assert.equal(theirs.registrationNumber, "87654321", "and the other company keeps its own")
    })

    test("lets any number of customers have no registration number at all: a null is not a duplicate", async () => {
      const first = await create(olivia, { kind: "person", name: "Carl Sørensen" })
      const second = await create(olivia, { kind: "person", name: "Dorte Holm" })
      assert.deepEqual([first.registrationNumber, second.registrationNumber], [null, null])
      assert.notEqual(first.id, second.id)
    })

    test("refuses a role that may view but not create", async () => {
      const problem = await refused(await lars("/customers", { method: "POST", body: { kind: "person", name: "Not mine" } }), 403)
      assert.match(problem.detail ?? "", /create on customers\.contacts/)
    })
  })

  describe("GET /customers", () => {
    test("answers the company's customers in id order and holds nothing of another company's", async () => {
      const mine = await create(olivia, { kind: "person", name: "Erik Madsen" })
      const all = (await page(olivia, "?limit=200")).items
      const ids = all.map((customer) => customer.id)
      assert.ok(ids.includes(mine.id))
      assert.deepEqual(ids, [...ids].sort(), "ascending by id")
      assert.ok(!ids.includes(theirs.id))
      assert.deepEqual((await page(other, "?limit=200")).items.map((customer) => customer.name), ["Havnegade Ejendomme"])
    })

    test("walks the pages with the cursor and says when there is no next one", async () => {
      const all = (await page(olivia, "?limit=200")).items
      assert.ok(all.length >= 2)
      const first = await page(olivia, "?limit=1")
      assert.deepEqual(first.items, all.slice(0, 1))
      assert.ok(first.nextCursor !== null)
      const rest = await page(olivia, `?limit=200&cursor=${first.nextCursor}`)
      assert.deepEqual(rest.items, all.slice(1))
      assert.equal(rest.nextCursor, null)
    })

    test("refuses a role without customers.contacts view, and a caller with no token", async () => {
      assert.match((await refused(await ungranted("/customers"), 403)).detail ?? "", /view on customers\.contacts/)
      assert.equal((await app.request("/customers")).status, 401)
    })
  })

  describe("GET /customers/:id", () => {
    test("answers 404 for another company's customer, for an id nobody minted, and 400 for a path that is not an id", async () => {
      const foreign = await refused(await olivia(`/customers/${theirs.id}`), 404)
      assert.match(foreign.detail ?? "", /customer/i)
      assert.equal((await one(other, theirs.id)).name, "Havnegade Ejendomme", "still there for its own company")
      await refused(await olivia(`/customers/${testId()}`), 404)
      assert.deepEqual((await refused(await olivia("/customers/not-a-uuid"), 400)).errors?.map((error) => error.path), ["id"])
    })
  })

  describe("PATCH /customers/:id", () => {
    test("changes what the body names, lowercases the e-mail, and leaves the rest", async () => {
      const created = await create(olivia, { kind: "person", name: "Frida Berg", phone: "+45 20 20 20 20" })
      const changed = await patch(olivia, created.id, { email: "Frida.Berg@Example.COM", status: "inactive" })
      assert.equal(changed.email, "frida.berg@example.com")
      assert.equal(changed.status, "inactive")
      assert.equal(changed.phone, "+45 20 20 20 20", "what the patch did not name it did not touch")
      assert.ok(changed.updatedAt > created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), changed)
    })

    test("clears what a null names", async () => {
      const created = await create(olivia, { kind: "organisation", name: "Gammel Havn ApS", registrationNumber: "55667788" })
      const cleared = await patch(olivia, created.id, { registrationNumber: null })
      assert.equal(cleared.registrationNumber, null)
    })

    test("refuses an empty patch, a member the caller does not own, and another company's customer", async () => {
      const created = await create(olivia, { kind: "person", name: "Hanne Krogh" })
      assert.deepEqual(
        (await refused(await olivia(`/customers/${created.id}`, { method: "PATCH", body: {} }), 400)).errors?.map((error) => error.path),
        [""],
      )
      const owned = await refused(
        await olivia(`/customers/${created.id}`, { method: "PATCH", body: { name: "Hanne", createdAt: "2026-09-24T13:41:00.000Z" } }),
        400,
      )
      assert.ok(owned.errors?.some((error) => /createdAt/.test(error.message)), JSON.stringify(owned.errors))
      await refused(await olivia(`/customers/${theirs.id}`, { method: "PATCH", body: { name: "Mine now" } }), 404)
      assert.equal((await one(other, theirs.id)).name, "Havnegade Ejendomme")
    })

    test("refuses a registration number the company already uses, and changes nothing", async () => {
      await create(olivia, { kind: "organisation", name: "Nordhavn Drift", registrationNumber: "99887766" })
      const created = await create(olivia, { kind: "organisation", name: "Sydhavn Drift", registrationNumber: "66778899" })
      const problem = await refused(
        await olivia(`/customers/${created.id}`, { method: "PATCH", body: { registrationNumber: "99887766" } }),
        409,
      )
      assert.equal(problem.detail, "This company already has a customer with registration number 99887766")
      assert.equal((await one(olivia, created.id)).registrationNumber, "66778899")
    })

    test("refuses a role that may view but not edit", async () => {
      const created = await create(olivia, { kind: "person", name: "Ida Lund" })
      const problem = await refused(await lars(`/customers/${created.id}`, { method: "PATCH", body: { status: "inactive" } }), 403)
      assert.match(problem.detail ?? "", /edit on customers\.contacts/)
    })
  })
})
