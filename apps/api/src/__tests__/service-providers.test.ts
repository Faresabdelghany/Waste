import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Id } from "@waste/contracts/ids"
import { ServiceProvider } from "@waste/contracts/organisation"
import { Page } from "@waste/contracts/pagination"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const ProviderPage = Page(ServiceProvider)

let registrations = 20_000_000
/** A provider body a caller may send. A registration is unique inside a company, so the counter only has to stay off the two the tenant was seeded with. */
const body = (legalName: string, registrationNumber = String((registrations += 1))) => ({
  legalName,
  registrationNumber,
  country: "DK",
  contactName: "Mette Sørensen",
  contactEmail: "mette@example.test",
})

describe("the service provider endpoints", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  /**
   * Three companies. Tenant A is the one under test and is written to;
   * tenant C is the second company, for the rules that need a write from
   * somewhere else; tenant B is never written to by any test in this file,
   * so its two seeded providers are a page whose size holds however the tests are
   * ordered.
   */
  let a: Tenant
  let b: Tenant
  let c: Tenant
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** Lars: Service Provider Manager — view and edit on the module, but no create. */
  let lars: Call
  let viewer: Call
  let other: Call
  /** The second company: what it writes is its own, and tenant B's page stays as it was seeded. */
  let third: Call

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    c = await seedTenant(pool)
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    third = callingAs(app, keys, c.users.olivia, c.companyId)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    if (c) await dropTenant(pool, c.companyId)
    await pool?.close()
  })

  const page = async (call: Call, query = "") => {
    const response = await call(`/service-providers${query}`)
    assert.equal(response.status, 200, query)
    return ProviderPage.parse(await response.json())
  }
  const one = async (call: Call, id: string) => {
    const response = await call(`/service-providers/${id}`)
    assert.equal(response.status, 200)
    return ServiceProvider.parse(await response.json())
  }
  const create = async (call: Call, values: Record<string, unknown>) => {
    const response = await call("/service-providers", { method: "POST", body: values })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return ServiceProvider.parse(await response.json())
  }

  describe("GET /service-providers", () => {
    test("answers the company's providers in id order, with the contact to call", async () => {
      const { items, nextCursor } = await page(other, "?limit=200")
      assert.equal(items.length, 2)
      assert.deepEqual(items.map((provider) => provider.legalName).sort(), ["CityHaul A/S", "NordRen ApS"])
      const ids = items.map((provider) => provider.id)
      assert.deepEqual(ids, [...ids].sort(), "ascending by id")
      assert.equal(nextCursor, null)
      const nordren = items.find((provider) => provider.legalName === "NordRen ApS")
      assert.equal(nordren?.contactName, "Lars Mikkelsen")
      assert.match(nordren?.contactEmail ?? "", /@.+\.example$/)
      assert.equal(nordren?.country, "DK")
    })

    test("walks the pages with the cursor", async () => {
      const all = (await page(other, "?limit=200")).items
      const first = await page(other, "?limit=1")
      assert.deepEqual(first.items, all.slice(0, 1))
      assert.ok(first.nextCursor !== null)
      const second = await page(other, `?limit=1&cursor=${first.nextCursor}`)
      assert.deepEqual(second.items, all.slice(1))
      assert.equal(second.nextCursor, null)
    })

    test("holds nothing of another company's", async () => {
      const mine = (await page(olivia, "?limit=200")).items.map((provider) => provider.id)
      const theirs = (await page(other, "?limit=200")).items.map((provider) => provider.id)
      assert.ok(mine.includes(a.serviceProviders.nordren.id))
      for (const id of theirs) assert.ok(!mine.includes(id), `${id} belongs to the other company`)
    })

    test("lets the provider manager look, and refuses the role with no grant on the module", async () => {
      assert.ok((await page(lars, "?limit=200")).items.length >= 2)
      const refused = await viewer("/service-providers")
      assert.equal(refused.status, 403)
      assert.match((await readProblem(refused)).detail ?? "", /view on service-providers\.service-providers/)
      assert.equal((await app.request("/service-providers")).status, 401)
    })

    test("refuses a bad cursor and a page size outside 1..200", async () => {
      const cursor = await other("/service-providers?cursor=nonsense")
      assert.equal(cursor.status, 400)
      assert.deepEqual((await readProblem(cursor)).errors?.map((error) => error.path), ["cursor"])
      const limit = await other("/service-providers?limit=201")
      assert.equal(limit.status, 400)
      assert.deepEqual((await readProblem(limit)).errors?.map((error) => error.path), ["limit"])
    })
  })

  describe("POST /service-providers", () => {
    test("mints the id itself and answers the row it wrote", async () => {
      const created = await create(olivia, body("Genbrug Nord ApS"))
      assert.equal(Id.parse(created.id), created.id)
      assert.equal(created.legalName, "Genbrug Nord ApS")
      assert.equal(created.contactEmail, "mette@example.test")
      assert.equal(created.createdAt, created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), created)
      assert.ok((await page(olivia, "?limit=200")).items.some((provider) => provider.id === created.id))
    })

    test("needs the contact: both columns are NOT NULL, so neither is optional on the wire", async () => {
      const { contactEmail: _email, ...contactless } = body("Nobody To Call")
      const missing = await olivia("/service-providers", { method: "POST", body: contactless })
      assert.equal(missing.status, 400)
      assert.deepEqual((await readProblem(missing)).errors?.map((error) => error.path), ["contactEmail"])

      const wrong = await olivia("/service-providers", { method: "POST", body: { ...body("Bad Address"), contactEmail: "mette" } })
      assert.equal(wrong.status, 400)
      assert.deepEqual((await readProblem(wrong)).errors?.map((error) => error.path), ["contactEmail"])
    })

    test("refuses an id from the client", async () => {
      const response = await olivia("/service-providers", { method: "POST", body: { ...body("Client Minted"), id: testId() } })
      assert.equal(response.status, 400)
      assert.ok((await readProblem(response)).errors?.some((error) => /id/.test(error.message)))
    })

    test("refuses a role that may view and edit but not create", async () => {
      const response = await lars("/service-providers", { method: "POST", body: body("Lars Haulage") })
      assert.equal(response.status, 403)
      assert.match((await readProblem(response)).detail ?? "", /create on service-providers\.service-providers/)
    })

    test("refuses a registration number the company already has for that country, and writes nothing", async () => {
      const taken = await create(olivia, body("Første Vognmand"))
      const before_ = (await page(olivia, "?limit=200")).items.length
      const response = await olivia("/service-providers", {
        method: "POST",
        body: { ...body("Anden Vognmand", taken.registrationNumber), country: taken.country },
      })
      assert.equal(response.status, 409)
      const problem = await readProblem(response)
      assert.equal(problem.title, "Conflict")
      assert.match(problem.detail ?? "", new RegExp(taken.registrationNumber))
      assert.doesNotMatch(problem.detail ?? "", /_key/)
      assert.equal((await page(olivia, "?limit=200")).items.length, before_)
    })

    test("lets another company register the same provider: the number is unique inside a company", async () => {
      const mine = await create(olivia, body("Fælles Vognmand"))
      const theirs = await create(third, { ...body("Fælles Vognmand", mine.registrationNumber), country: mine.country })
      assert.equal(theirs.registrationNumber, mine.registrationNumber)
      assert.notEqual(theirs.id, mine.id)
    })
  })

  describe("GET /service-providers/:id", () => {
    test("answers one provider of the caller's company", async () => {
      assert.equal((await one(olivia, a.serviceProviders.cityhaul.id)).legalName, "CityHaul A/S")
    })

    test("answers 404 for another company's provider, an id nobody minted, and 400 for a path that is not an id", async () => {
      const foreign = await olivia(`/service-providers/${b.serviceProviders.nordren.id}`)
      assert.equal(foreign.status, 404)
      assert.match((await readProblem(foreign)).detail ?? "", /service provider/i)
      assert.equal((await one(other, b.serviceProviders.nordren.id)).legalName, "NordRen ApS")

      assert.equal((await olivia(`/service-providers/${testId()}`)).status, 404)

      const bad = await olivia("/service-providers/not-a-uuid")
      assert.equal(bad.status, 400)
      assert.deepEqual((await readProblem(bad)).errors?.map((error) => error.path), ["id"])
    })

    test("refuses a role without the module, and a caller with no token", async () => {
      const refused = await viewer(`/service-providers/${a.serviceProviders.cityhaul.id}`)
      assert.equal(refused.status, 403)
      assert.match((await readProblem(refused)).detail ?? "", /view on service-providers\.service-providers/)
      assert.equal((await app.request(`/service-providers/${a.serviceProviders.cityhaul.id}`)).status, 401)
    })
  })

  describe("PATCH /service-providers/:id", () => {
    test("changes the contact and answers the row as it now stands", async () => {
      const created = await create(olivia, body("Skift Vognmand"))
      const response = await olivia(`/service-providers/${created.id}`, {
        method: "PATCH",
        body: { contactName: "Jens Jensen", contactEmail: "jens@example.test" },
      })
      assert.equal(response.status, 200)
      const patched = ServiceProvider.parse(await response.json())
      assert.equal(patched.contactName, "Jens Jensen")
      assert.equal(patched.contactEmail, "jens@example.test")
      assert.equal(patched.legalName, created.legalName)
      assert.ok(patched.updatedAt > created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), patched)
    })

    test("lets the provider manager edit, and refuses the role with no grant", async () => {
      const created = await create(olivia, body("Lars Må Rette"))
      const allowed = await lars(`/service-providers/${created.id}`, { method: "PATCH", body: { contactName: "Lars Mikkelsen" } })
      assert.equal(allowed.status, 200)
      assert.equal(ServiceProvider.parse(await allowed.json()).contactName, "Lars Mikkelsen")

      const refused = await viewer(`/service-providers/${created.id}`, { method: "PATCH", body: { contactName: "Vera" } })
      assert.equal(refused.status, 403)
      assert.match((await readProblem(refused)).detail ?? "", /edit on service-providers\.service-providers/)
    })

    test("refuses an empty patch and a member it does not own", async () => {
      const empty = await olivia(`/service-providers/${a.serviceProviders.cityhaul.id}`, { method: "PATCH", body: {} })
      assert.equal(empty.status, 400)
      assert.deepEqual((await readProblem(empty)).errors?.map((error) => error.path), [""])

      const owned = await olivia(`/service-providers/${a.serviceProviders.cityhaul.id}`, { method: "PATCH", body: { contactName: "X", updatedAt: "2026-09-24T13:41:00.000Z" } })
      assert.equal(owned.status, 400)
      assert.ok((await readProblem(owned)).errors?.some((error) => /updatedAt/.test(error.message)))
    })

    test("answers 404 for another company's provider, and leaves it alone", async () => {
      const response = await olivia(`/service-providers/${b.serviceProviders.cityhaul.id}`, { method: "PATCH", body: { contactName: "Mine now" } })
      assert.equal(response.status, 404)
      await readProblem(response)
      assert.equal((await one(other, b.serviceProviders.cityhaul.id)).contactName, "Mikkel Andersen")
    })

    test("refuses a country that moves a registration number onto one the company already has there, and changes nothing", async () => {
      // The unique is (company, country, registration number), so a patch that
      // names only the country can collide just as one that names only the
      // number: the same number is free in Sweden until the provider moves there.
      const shared = String((registrations += 1))
      await create(olivia, { ...body("Nord Grænse", shared), country: "SE" })
      const moving = await create(olivia, { ...body("Syd Grænse", shared), country: "DK" })
      const response = await olivia(`/service-providers/${moving.id}`, { method: "PATCH", body: { country: "SE" } })
      assert.equal(response.status, 409)
      const problem = await readProblem(response)
      assert.match(problem.detail ?? "", /registration number/i)
      assert.doesNotMatch(problem.detail ?? "", /_key/, "a constraint name is not a sentence for a client")
      assert.equal((await one(olivia, moving.id)).country, "DK", "the whole request was rolled back")
    })

    test("refuses a registration number the company already has, and changes nothing", async () => {
      const first = await create(olivia, body("Nummer Et"))
      const second = await create(olivia, body("Nummer To"))
      const response = await olivia(`/service-providers/${second.id}`, { method: "PATCH", body: { registrationNumber: first.registrationNumber } })
      assert.equal(response.status, 409)
      const problem = await readProblem(response)
      assert.match(problem.detail ?? "", new RegExp(first.registrationNumber))
      assert.doesNotMatch(problem.detail ?? "", /_key/)
      assert.equal((await one(olivia, second.id)).registrationNumber, second.registrationNumber)
    })
  })
})
