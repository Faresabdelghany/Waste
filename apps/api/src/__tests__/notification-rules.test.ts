// A project's customer notices on the API (O16 of #290, part b) against a
// real database: none until chosen; replaced whole, a rule kept keeping its
// id; each template held to the project, to service and to active; the grant
// and the project fence.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { MessageTemplate } from "@waste/contracts/messaging"
import { NotificationRules, ONE_RULE_PER_NOTICE } from "@waste/contracts/notifications"
import { createDb, type Database } from "@waste/db/client"
import { templateInactive } from "@waste/db/commands/messaging"
import { notificationRule } from "@waste/db/schema/notifications"
import { withCompany } from "@waste/db/tenant"
import { eq } from "drizzle-orm"

import { createApp } from "../app"
import { A_SERVICE_TEMPLATE, PICK_A_PROJECT_TEMPLATE } from "../routes/notification-rules"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()

describe("a project's customer notices", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let olivia: Call
  let viewer: Call
  let other: Call
  let booked: MessageTemplate
  let collected: MessageTemplate
  let billing: MessageTemplate
  let harbors: MessageTemplate

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: "configure.templates", actions: ["view"] }])
    const app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    const write = async (body: Record<string, unknown>) => created(olivia, "/message-templates", await olivia("/message-templates", { method: "POST", body }), MessageTemplate)
    const copenhagen = a.projects.copenhagen.id
    booked = await write({ projectId: copenhagen, name: "Bulky booked", purpose: "service", channel: "email", subject: "Booked for {{collectionDate}}", body: "Dear {{recipientName}}, we come on {{collectionDate}}." })
    collected = await write({ projectId: copenhagen, name: "Bulky collected", purpose: "service", channel: "sms", body: "{{recipientName}}: collected." })
    billing = await write({ projectId: copenhagen, name: "Invoice due", purpose: "billing", channel: "sms", body: "Your invoice is due" })
    harbors = await write({ projectId: a.projects.harbor.id, name: "Harbor booked", purpose: "service", channel: "sms", body: "Booked" })
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  const path = () => `/projects/${a.projects.copenhagen.id}/notification-rules`
  const put = (body: unknown, call = olivia) => call(path(), { method: "PUT", body })
  const read = async (call = olivia) => {
    const response = await call(path())
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return NotificationRules.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }

  test("are none until chosen: a project sends no notice", async () => {
    assert.deepEqual(await read(), { projectId: a.projects.copenhagen.id, rules: [] })
  })

  test("are replaced whole, in the vocabulary's order, a rule kept keeping its id and a rule left out gone", async () => {
    const response = await put({ rules: [{ event: "bulky-booking-collected", templateId: collected.id }, { event: "bulky-booking-booked", templateId: booked.id }] })
    assert.equal(response.status, 200)
    assert.deepEqual(NotificationRules.parse(await response.json()).rules, [
      { event: "bulky-booking-booked", templateId: booked.id },
      { event: "bulky-booking-collected", templateId: collected.id },
    ])
    const ids = async () => new Map((await withCompany(pool.db, a.companyId, (tx) => tx.select({ id: notificationRule.id, event: notificationRule.event }).from(notificationRule).where(eq(notificationRule.projectId, a.projects.copenhagen.id)))).map((row) => [row.event, row.id]))
    const before = await ids()
    await put({ rules: [{ event: "bulky-booking-booked", templateId: collected.id }, { event: "bulky-booking-cancelled", templateId: booked.id }] })
    const now = await ids()
    assert.equal(now.get("bulky-booking-booked"), before.get("bulky-booking-booked"), "kept, its template moved")
    assert.equal(now.has("bulky-booking-collected"), false, "left out, gone")
    assert.deepEqual((await read(viewer)).rules, [
      { event: "bulky-booking-booked", templateId: collected.id },
      { event: "bulky-booking-cancelled", templateId: booked.id },
    ])
  })

  test("hold each template to the project, to service and to active, and each notice to once", async () => {
    const at = (response: Response) => refused(response, 400).then((problem) => problem.errors)
    assert.deepEqual(await at(await put({ rules: [{ event: "bulky-booking-booked", templateId: harbors.id }] })), [{ path: "rules.0.templateId", message: PICK_A_PROJECT_TEMPLATE }])
    assert.deepEqual(await at(await put({ rules: [{ event: "bulky-booking-booked", templateId: booked.id }, { event: "bulky-booking-cancelled", templateId: billing.id }] })), [{ path: "rules.1.templateId", message: A_SERVICE_TEMPLATE }])
    assert.deepEqual(await at(await put({ rules: [{ event: "bulky-booking-booked", templateId: booked.id }, { event: "bulky-booking-booked", templateId: collected.id }] })), [{ path: "rules.1.event", message: ONE_RULE_PER_NOTICE }])
    await olivia(`/message-templates/${collected.id}`, { method: "PATCH", body: { status: "inactive" } })
    try {
      assert.equal((await refused(await put({ rules: [{ event: "bulky-booking-collected", templateId: collected.id }] }), 409)).detail, templateInactive("Bulky collected"))
    } finally {
      await olivia(`/message-templates/${collected.id}`, { method: "PATCH", body: { status: "active" } })
    }
    assert.equal((await read()).rules.length, 2, "untouched")
  })

  test("are written by a role granted to, and another company's or another project's are nobody's here", async () => {
    await refused(await put({ rules: [] }, viewer), 403)
    await refused(await other(path()), 404)
    await refused(await viewer(`/projects/${a.projects.harbor.id}/notification-rules`), 404)
  })
})
