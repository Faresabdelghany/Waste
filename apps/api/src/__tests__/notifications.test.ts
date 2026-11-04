// A staff member's own notices on the API (O16 of #290) against a real
// database: the preferences, nothing until chosen, replaced whole and read
// back, each person's own; the notices they were sent, read by them alone and
// left out of the customers' delivery log.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Message } from "@waste/contracts/messaging"
import { NotificationPreferences } from "@waste/contracts/notifications"
import { Page } from "@waste/contracts/pagination"
import { createDb, type Database } from "@waste/db/client"
import { message } from "@waste/db/schema/messaging"
import { notificationPreference } from "@waste/db/schema/notifications"
import { withCompany } from "@waste/db/tenant"
import { eq } from "drizzle-orm"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const NoticePage = Page(Message)

describe("a staff member's notices", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  let a: Tenant
  let olivia: Call
  let viewer: Call

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    const app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    await pool?.close()
  })

  const preferences = async (call: Call) => {
    const response = await call("/me/notification-preferences")
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return NotificationPreferences.parse(await response.json())
  }
  const put = (call: Call, body: unknown) => call("/me/notification-preferences", { method: "PUT", body })

  test("ask for nothing until chosen", async () => {
    assert.deepEqual(await preferences(olivia), { alertRaisedMinSeverity: null, ticketAssigned: false })
  })

  test("are replaced whole and read back, a row per event asked for and none for one not, each person's own", async () => {
    const response = await put(olivia, { alertRaisedMinSeverity: "high", ticketAssigned: true })
    assert.equal(response.status, 200)
    assert.deepEqual(NotificationPreferences.parse(await response.json()), { alertRaisedMinSeverity: "high", ticketAssigned: true })
    assert.deepEqual(await preferences(olivia), { alertRaisedMinSeverity: "high", ticketAssigned: true })
    assert.deepEqual(await preferences(viewer), { alertRaisedMinSeverity: null, ticketAssigned: false }, "Vera chose nothing")

    await put(olivia, { alertRaisedMinSeverity: "critical", ticketAssigned: false })
    assert.deepEqual(await preferences(olivia), { alertRaisedMinSeverity: "critical", ticketAssigned: false })
    const rows = await withCompany(pool.db, a.companyId, (tx) =>
      tx.select({ event: notificationPreference.event, minSeverity: notificationPreference.minSeverity }).from(notificationPreference).where(eq(notificationPreference.userAccountId, a.users.olivia.id)),
    )
    assert.deepEqual(rows, [{ event: "alert-raised", minSeverity: "critical" }], "the assignment's row is gone, the alert's written over")
  })

  test("refuse a body that is not the whole set, a severity that is not one, and a member it does not take", async () => {
    assert.deepEqual((await readProblem(await put(olivia, { ticketAssigned: true }))).errors?.map((error) => error.path), ["alertRaisedMinSeverity"])
    assert.deepEqual((await readProblem(await put(olivia, { alertRaisedMinSeverity: "urgent", ticketAssigned: true }))).errors?.map((error) => error.path), ["alertRaisedMinSeverity"])
    const theirs = await put(olivia, { alertRaisedMinSeverity: null, ticketAssigned: true, userAccountId: a.users.viewer.id })
    assert.equal(theirs.status, 400, "nobody chooses for another")
    assert.deepEqual(await preferences(olivia), { alertRaisedMinSeverity: "critical", ticketAssigned: false }, "untouched")
  })

  test("the notices sent are read by their recipient alone, newest first, and are no customer's message", async () => {
    // Each a millisecond apart: an id's order is its time's, and two minted in one millisecond have none.
    const minted = Date.now()
    let made = 0
    const staff = (userAccountId: string, subject: string) => ({
      id: testId(minted + made++),
      companyId: a.companyId,
      projectId: a.projects.copenhagen.id,
      userAccountId,
      sourceEventId: testId(),
      channel: "email",
      purpose: "staff",
      recipient: "someone@example.test",
      subject,
      body: "…",
      status: "queued",
    })
    const first = staff(a.users.olivia.id, "Critical alert · Truck on fire")
    const second = staff(a.users.olivia.id, "Ticket T-12 assigned to you · Missed bin")
    const veras = staff(a.users.viewer.id, "Ticket T-13 assigned to you · Lid broken")
    await withCompany(pool.db, a.companyId, (tx) => tx.insert(message).values([first, second, veras]))

    const mine = NoticePage.parse(await (await olivia("/me/notices")).json())
    assert.deepEqual(mine.items.map((item) => [item.subject, item.userAccountId, item.customerId, item.purpose]), [
      [second.subject, a.users.olivia.id, null, "staff"],
      [first.subject, a.users.olivia.id, null, "staff"],
    ])
    assert.deepEqual(NoticePage.parse(await (await viewer("/me/notices")).json()).items.map((item) => item.subject), [veras.subject])
    const paged = NoticePage.parse(await (await olivia("/me/notices?limit=1")).json())
    assert.deepEqual(paged.items.map((item) => item.id), [second.id])
    assert.deepEqual(NoticePage.parse(await (await olivia(`/me/notices?limit=1&cursor=${paged.nextCursor}`)).json()).items.map((item) => item.id), [first.id])

    const log = NoticePage.parse(await (await olivia("/messages")).json())
    assert.deepEqual(log.items, [], "the delivery log is the customers'")
    assert.equal((await olivia(`/messages/${first.id}`)).status, 404)
  })
})
