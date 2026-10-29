// A project's customer notices on the API (O16 of #290, part b) against a
// real database: none until chosen; replaced whole, a rule kept keeping its
// id; each template held to the project, to service and to active; the grant
// and the project fence; a template held to the values its notice fills, and
// a broadcast's areas to the project's notification areas (C18 of #291).
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { MessageTemplate } from "@waste/contracts/messaging"
import { AREAS_ARE_A_BROADCASTS, NotificationRules, ONE_RULE_PER_NOTICE } from "@waste/contracts/notifications"
import { createDb, type Database } from "@waste/db/client"
import { templateInactive } from "@waste/db/commands/messaging"
import { notificationRule } from "@waste/db/schema/notifications"
import { planningArea } from "@waste/db/schema/planning-areas"
import { withCompany } from "@waste/db/tenant"
import { eq } from "drizzle-orm"

import { createApp } from "../app"
import { A_NOTIFICATION_AREA, A_SERVICE_TEMPLATE, notFilledByNotice, PICK_A_PROJECT_TEMPLATE } from "../routes/notification-rules"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
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
  let replied: MessageTemplate
  let late: MessageTemplate
  let north: string
  let south: string
  let routing: string

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
    replied = await write({ projectId: copenhagen, name: "Ticket reply", purpose: "service", channel: "email", subject: "About {{ticketNumber}}", body: "{{replyText}}" })
    late = await write({ projectId: copenhagen, name: "Running late", purpose: "service", channel: "sms", body: "Your collection on {{collectionDate}} runs late." })
    const area = async (code: string, purpose: "notification" | "route-planning") => {
      const id = testId()
      await withCompany(pool.db, a.companyId, (tx) => tx.insert(planningArea).values({ id, companyId: a.companyId, projectId: copenhagen, code, name: code, purpose }))
      return id
    }
    north = await area("NOTE-N", "notification")
    south = await area("NOTE-S", "notification")
    routing = await area("NOTE-R", "route-planning")
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
      { event: "bulky-booking-booked", templateId: booked.id, planningAreaIds: [] },
      { event: "bulky-booking-collected", templateId: collected.id, planningAreaIds: [] },
    ])
    const ids = async () => new Map((await withCompany(pool.db, a.companyId, (tx) => tx.select({ id: notificationRule.id, event: notificationRule.event }).from(notificationRule).where(eq(notificationRule.projectId, a.projects.copenhagen.id)))).map((row) => [row.event, row.id]))
    const before = await ids()
    await put({ rules: [{ event: "bulky-booking-booked", templateId: collected.id }, { event: "bulky-booking-cancelled", templateId: booked.id }] })
    const now = await ids()
    assert.equal(now.get("bulky-booking-booked"), before.get("bulky-booking-booked"), "kept, its template moved")
    assert.equal(now.has("bulky-booking-collected"), false, "left out, gone")
    assert.deepEqual((await read(viewer)).rules, [
      { event: "bulky-booking-booked", templateId: collected.id, planningAreaIds: [] },
      { event: "bulky-booking-cancelled", templateId: booked.id, planningAreaIds: [] },
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

  test("hold a template to the values its notice fills", async () => {
    const at = (response: Response) => refused(response, 400).then((problem) => problem.errors)
    assert.deepEqual(await at(await put({ rules: [{ event: "bulky-booking-booked", templateId: replied.id }] })), [{ path: "rules.0.templateId", message: notFilledByNotice("Ticket reply", ["ticketNumber", "replyText"]) }], "a booking fills no ticket's values")
    assert.deepEqual(await at(await put({ rules: [{ event: "ticket-completed", templateId: replied.id }] })), [{ path: "rules.0.templateId", message: notFilledByNotice("Ticket reply", ["replyText"]) }], "a completion has no reply's words")
    assert.deepEqual(await at(await put({ rules: [{ event: "ticket-replied", templateId: booked.id }] })), [{ path: "rules.0.templateId", message: notFilledByNotice("Bulky booked", ["collectionDate"]) }])
    const response = await put({ rules: [{ event: "ticket-replied", templateId: replied.id }, { event: "collection-reminder", templateId: late.id }] })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  })

  test("name a broadcast's areas, the project's notification areas alone, and replace them with the rule", async () => {
    const at = (response: Response) => refused(response, 400).then((problem) => problem.errors)
    assert.deepEqual(await at(await put({ rules: [{ event: "route-late", templateId: late.id, planningAreaIds: [routing] }] })), [{ path: "rules.0.planningAreaIds", message: A_NOTIFICATION_AREA }], "a routing area is not a notification area")
    assert.deepEqual((await at(await put({ rules: [{ event: "collection-reminder", templateId: late.id, planningAreaIds: [north] }] })))?.map((issue) => issue.message), [AREAS_ARE_A_BROADCASTS])

    const first = await put({ rules: [{ event: "route-late", templateId: late.id, planningAreaIds: [south, north] }, { event: "route-cancelled", templateId: late.id }] })
    assert.equal(first.status, 200, JSON.stringify(await first.clone().json()))
    assert.deepEqual(NotificationRules.parse(await first.json()).rules, [
      { event: "route-cancelled", templateId: late.id, planningAreaIds: [] },
      { event: "route-late", templateId: late.id, planningAreaIds: [north, south].sort() },
    ], "no area is the whole project")
    await put({ rules: [{ event: "route-late", templateId: late.id, planningAreaIds: [north] }, { event: "route-cancelled", templateId: late.id, planningAreaIds: [south] }] })
    assert.deepEqual((await read()).rules.map((rule) => [rule.event, rule.planningAreaIds]), [["route-cancelled", [south]], ["route-late", [north]]])
    assert.equal((await put({ rules: [] })).status, 200, "a rule's areas go with it")
    assert.deepEqual((await read()).rules, [])
  })

  test("are written by a role granted to, and another company's or another project's are nobody's here", async () => {
    await refused(await put({ rules: [] }, viewer), 403)
    await refused(await other(path()), 404)
    await refused(await viewer(`/projects/${a.projects.harbor.id}/notification-rules`), 404)
  })
})
