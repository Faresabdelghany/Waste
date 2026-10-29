// Route Messages on the API (O24 of #290) against a real database: the office
// writes to a route's driver and the driver back, one thread oldest first with
// the names beside it; the driver's send under its device's id is answered
// again, not written twice, and an id another message holds is refused; the
// office's fence is its projects, the driver's the assignment; a message is
// never edited or taken back.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { RouteMessage } from "@waste/contracts/route-messages"
import { createDb, type Database } from "@waste/db/client"
import { routeMessage } from "@waste/db/schema/route-messages"
import { withCompany } from "@waste/db/tenant"
import { eq } from "drizzle-orm"
import * as z from "zod"

import { createApp } from "../app"
import { MESSAGE_ID_TAKEN } from "../routes/route-messages"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { routeFor, seedDriverFixtures, type DriverFixtures, type FixtureRoute } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const owner = ownerUnderTest()
const Thread = z.array(RouteMessage)

describe("a route's messages", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let fixtures: DriverFixtures
  let olivia: Call
  let viewer: Call
  let other: Call
  let mads: Call
  let freja: Call
  let route: FixtureRoute

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    fixtures = await seedDriverFixtures(pool, a, fleet)
    const app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    mads = callingAs(app, keys, fixtures.accounts.mads, a.companyId)
    freja = callingAs(app, keys, fixtures.accounts.freja, a.companyId)
    route = await routeFor(pool, a, fleet, fixtures, { driver: fleet.drivers.mads })
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const send = (call: Call, path: string, body: unknown) => call(path, { method: "POST", body })
  const thread = async (call: Call, path: string) => {
    const response = await call(path)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Thread.parse(await response.json())
  }

  test("the office writes to the route's driver and the driver back: one thread, oldest first, the names beside each", async () => {
    const office = await send(olivia, `/routes/${route.id}/messages`, { body: "  Gate code at Parkvej is 4711  " })
    assert.equal(office.status, 201)
    assert.equal(office.headers.get("location"), null, "an append to the thread, read whole")
    const written = RouteMessage.parse(await office.json())
    assert.deepEqual([written.author, written.body, written.sentBy, written.senderName, written.driverId, written.routeId], ["office", "Gate code at Parkvej is 4711", a.users.olivia.id, "Olivia Larsen", null, route.id])

    const id = testId()
    const driver = await send(mads, `/driver/routes/${route.id}/messages`, { id, body: "Thanks, on my way" })
    assert.equal(driver.status, 201)
    const reply = RouteMessage.parse(await driver.json())
    assert.deepEqual([reply.id, reply.author, reply.driverId, reply.sentBy, reply.senderName], [id, "driver", fleet.drivers.mads.id, fixtures.accounts.mads.id, fleet.drivers.mads.name])

    for (const [call, path] of [[olivia, `/routes/${route.id}/messages`], [mads, `/driver/routes/${route.id}/messages`]] as const) {
      assert.deepEqual((await thread(call, path)).map((message) => [message.author, message.body]), [["office", "Gate code at Parkvej is 4711"], ["driver", "Thanks, on my way"]])
    }
  })

  test("the driver's send tried again under its id is the message already written; an id another message holds is refused", async () => {
    const id = testId()
    const first = await send(mads, `/driver/routes/${route.id}/messages`, { id, body: "Bin blocked by a van" })
    assert.equal(first.status, 201)
    const again = await send(mads, `/driver/routes/${route.id}/messages`, { id, body: "Bin blocked by a van" })
    assert.equal(again.status, 200)
    assert.deepEqual(RouteMessage.parse(await again.json()), RouteMessage.parse(await first.json()))
    const rows = await withCompany(pool.db, a.companyId, (tx) => tx.select({ id: routeMessage.id }).from(routeMessage).where(eq(routeMessage.id, id)))
    assert.equal(rows.length, 1, "written once")
    assert.equal((await refused(await send(mads, `/driver/routes/${route.id}/messages`, { id, body: "Something else" }), 409)).detail, MESSAGE_ID_TAKEN)
  })

  test("refuse an empty body, a member the command does not take, and an office's id", async () => {
    assert.deepEqual((await refused(await send(olivia, `/routes/${route.id}/messages`, { body: "  " }), 400)).errors?.map((error) => error.path), ["body"])
    assert.equal((await refused(await send(olivia, `/routes/${route.id}/messages`, { id: testId(), body: "Hi" }), 400)).status, 400)
    assert.deepEqual((await refused(await send(mads, `/driver/routes/${route.id}/messages`, { body: "Hi" }), 400)).errors?.map((error) => error.path), ["id"])
  })

  test("the office's fence is its projects, the driver's the assignment, and a role without the grant is refused", async () => {
    await refused(await other(`/routes/${route.id}/messages`), 404)
    await refused(await send(other, `/routes/${route.id}/messages`, { body: "Hi" }), 404)
    await refused(await viewer(`/routes/${route.id}/messages`), 403)
    await refused(await freja(`/driver/routes/${route.id}/messages`), 404)
    await refused(await send(freja, `/driver/routes/${route.id}/messages`, { id: testId(), body: "Not mine" }), 404)
    await refused(await olivia(`/driver/routes/${route.id}/messages`), 403)
  })

  test("a message is never edited or taken back: the API's role may not update or delete one", async () => {
    const denied = (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "42501"
    await assert.rejects(withCompany(pool.db, a.companyId, (tx) => tx.update(routeMessage).set({ body: "Changed" }).where(eq(routeMessage.routeId, route.id))), denied)
    await assert.rejects(withCompany(pool.db, a.companyId, (tx) => tx.delete(routeMessage).where(eq(routeMessage.routeId, route.id))), denied)
  })
})
