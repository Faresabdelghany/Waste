import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Company } from "@waste/contracts/organisation"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, seedTenant, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()

describe("the company endpoints", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let app: ReturnType<typeof createApp>
  /** Olivia of tenant A: Company Administrator, every grant. */
  let olivia: Call
  /** Vera of tenant A: a custom role with `configure.access view` and nothing else. */
  let viewer: Call
  /** Lars of tenant A: Service Provider Manager, nothing on configure.organization. */
  let lars: Call
  /** Olivia of tenant B, to prove one company never reads another's. */
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

  const companyOf = async (call: Call) => {
    const response = await call("/company")
    assert.equal(response.status, 200)
    return Company.parse(await response.json())
  }

  describe("GET /company", () => {
    test("answers the caller's own company, whole", async () => {
      const body = await companyOf(olivia)
      assert.equal(body.id, a.companyId)
      assert.equal(body.name, a.name)
      assert.equal(body.legalName, `${a.name} A/S`)
      assert.equal(body.country, "DK")
      assert.equal(body.status, "active")
      assert.match(body.registrationNumber, /^\d{8}$/)
      assert.equal(body.createdAt, body.updatedAt, "nothing has changed it since it was seeded")
      assert.equal(new Date(body.createdAt).toISOString(), body.createdAt, "an instant, as RFC 3339")
    })

    test("answers the other tenant its own: two companies on one database never meet", async () => {
      const body = await companyOf(other)
      assert.equal(body.id, b.companyId)
      assert.notEqual(body.id, a.companyId)
      assert.equal(body.name, b.name)
    })

    test("refuses a role without configure.organization view, naming the module and the action", async () => {
      for (const [who, call] of [
        ["the viewer", viewer],
        ["the provider manager", lars],
      ] as const) {
        const response = await call("/company")
        assert.equal(response.status, 403, who)
        const body = await readProblem(response)
        assert.match(body.detail ?? "", /configure\.organization/, who)
        assert.match(body.detail ?? "", /view/, who)
      }
    })

    test("refuses a caller with no token at all", async () => {
      const response = await app.request("/company")
      assert.equal(response.status, 401)
      assert.equal(response.headers.get("www-authenticate"), "Bearer")
      await readProblem(response)
    })
  })

  describe("PATCH /company", () => {
    test("changes what an administrator may change and answers the row as it now stands", async () => {
      const before_ = await companyOf(olivia)
      const response = await olivia("/company", { method: "PATCH", body: { name: "Kystbyen Nord", legalName: "Kystbyen Nord A/S" } })
      assert.equal(response.status, 200)
      const body = Company.parse(await response.json())
      assert.equal(body.name, "Kystbyen Nord")
      assert.equal(body.legalName, "Kystbyen Nord A/S")
      assert.equal(body.id, a.companyId)
      assert.equal(body.registrationNumber, before_.registrationNumber, "what the patch did not name it did not touch")
      assert.ok(body.updatedAt > before_.updatedAt, `${body.updatedAt} must be after ${before_.updatedAt}`)
      assert.equal(body.createdAt, before_.createdAt)
      assert.deepEqual(await companyOf(olivia), body, "and that is what the next read says")
    })

    test("refuses an empty patch: a change with nothing to change is a mistake", async () => {
      const response = await olivia("/company", { method: "PATCH", body: {} })
      assert.equal(response.status, 400)
      const body = await readProblem(response)
      assert.equal(body.detail, "The request body is invalid")
      assert.deepEqual(body.errors?.map((error) => error.path), [""])
      assert.match(body.errors?.[0].message ?? "", /at least one/i)
    })

    test("refuses a member it does not own, the status above all", async () => {
      const response = await olivia("/company", { method: "PATCH", body: { name: "Whatever", status: "active" } })
      assert.equal(response.status, 400)
      const body = await readProblem(response)
      assert.ok(body.errors?.some((error) => /status/.test(error.message)), JSON.stringify(body.errors))
    })

    test("refuses a country that is not two uppercase letters, naming the field", async () => {
      const response = await olivia("/company", { method: "PATCH", body: { country: "denmark" } })
      assert.equal(response.status, 400)
      const body = await readProblem(response)
      assert.deepEqual(body.errors?.map((error) => error.path), ["country"])
      assert.match(body.errors?.[0].message ?? "", /3166/)
    })

    test("refuses a role without configure.organization edit", async () => {
      const response = await viewer("/company", { method: "PATCH", body: { name: "Not mine to change" } })
      assert.equal(response.status, 403)
      assert.match((await readProblem(response)).detail ?? "", /edit on configure\.organization/)
    })

    test("refuses a registration number another company already registered, and changes nothing", async () => {
      const taken = await companyOf(other)
      const mine = await companyOf(olivia)
      const response = await olivia("/company", {
        method: "PATCH",
        body: { name: "Doppelganger", country: taken.country, registrationNumber: taken.registrationNumber },
      })
      assert.equal(response.status, 409)
      const body = await readProblem(response)
      assert.equal(body.title, "Conflict")
      assert.match(body.detail ?? "", /registration number/i)
      assert.doesNotMatch(body.detail ?? "", /_key/, "a constraint name is not a sentence for a client")
      assert.deepEqual(await companyOf(olivia), mine, "the whole request was rolled back, the name with it")
    })
  })
})
