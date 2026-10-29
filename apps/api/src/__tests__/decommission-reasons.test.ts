import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Page } from "@waste/contracts/pagination"
import { DecommissionReason } from "@waste/contracts/stock"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys } from "./tokens"

const database = databaseUnderTest()
const ReasonPage = Page(DecommissionReason)

describe("the decommission reason endpoints (O30 of #290, row 9.6)", { skip: database.skip }, () => {
  let pool: Database
  let a: Tenant
  let b: Tenant
  let olivia: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    const keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    const app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  const post = (call: Call, body: unknown) => call("/decommission-reasons", { method: "POST", body })
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return readProblem(response)
  }

  test("adds a reason, active unless said, read back by id and listed; a code or a name taken is a 409 naming it", async () => {
    const fire = await created(olivia, "/decommission-reasons", await post(olivia, { code: "fire", name: "Fire" }), DecommissionReason)
    assert.deepEqual([fire.code, fire.name, fire.status], ["fire", "Fire", "active"])
    const read = await olivia(`/decommission-reasons/${fire.id}`)
    assert.deepEqual(DecommissionReason.parse(await read.json()), fire)
    assert.equal((await refused(await post(olivia, { code: "fire", name: "Burnt" }), 409)).detail, 'This company already has a decommission reason "fire"')
    assert.equal((await refused(await post(olivia, { code: "burnt", name: "Fire" }), 409)).detail, 'This company already has a decommission reason called "Fire"')
    await refused(await post(olivia, { code: "Fire!", name: "Fire again" }), 400)
    const theirs = await created(other, "/decommission-reasons", await post(other, { code: "fire", name: "Fire" }), DecommissionReason)
    assert.notEqual(theirs.id, fire.id, "a code is one reason's inside a company, and free in the next")
  })

  test("renames and retires a reason, never moves its code, and lists the active and the retired apart", async () => {
    const lost = await created(olivia, "/decommission-reasons", await post(olivia, { code: "lost", name: "Lost" }), DecommissionReason)
    const patch = (body: unknown) => olivia(`/decommission-reasons/${lost.id}`, { method: "PATCH", body })
    const retired = DecommissionReason.parse(await (await patch({ name: "Lost on a route", status: "inactive" })).json())
    assert.deepEqual([retired.name, retired.status], ["Lost on a route", "inactive"])
    await refused(await patch({ code: "missing" }), 400)
    const inactive = ReasonPage.parse(await (await olivia("/decommission-reasons?status=inactive")).json())
    assert.deepEqual(inactive.items.map((reason) => reason.id), [lost.id])
    const active = ReasonPage.parse(await (await olivia("/decommission-reasons?status=active")).json())
    assert.ok(!active.items.some((reason) => reason.id === lost.id))
  })

  test("answers 404 for another company's reason and for an id nobody minted, and 403 without the grant", async () => {
    const mine = await created(olivia, "/decommission-reasons", await post(olivia, { code: "stolen", name: "Stolen" }), DecommissionReason)
    await refused(await other(`/decommission-reasons/${mine.id}`), 404)
    await refused(await other(`/decommission-reasons/${mine.id}`, { method: "PATCH", body: { name: "Mine now" } }), 404)
    await refused(await olivia(`/decommission-reasons/${testId()}`), 404)
    assert.match((await refused(await ungranted("/decommission-reasons"), 403)).detail ?? "", /view on configure\.master/)
  })
})
