// Messaging on the API (#291 C15) against a real database: a project's
// templates, named once in their project, held to their channel's shape on
// a create and as a patch leaves them, and to the placeholders a message
// fills; the office's request, queued rendered to a contact's address or the
// customer's own with the worker's job sent in its transaction, refused where
// the template is inactive, the contact is not the customer's or there is no
// address; the delivery log read newest first by customer and status; the
// grants and the project fence; and a 503 where no worker has made the queue.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Customer, CustomerContact } from "@waste/contracts/customers"
import { Message, MessageTemplate, unknownPlaceholderSentence } from "@waste/contracts/messaging"
import { Page } from "@waste/contracts/pagination"
import { createDb, type Database } from "@waste/db/client"
import { CONTACT_NOT_THE_CUSTOMERS, noAddress, SEND_MESSAGE_QUEUE, templateInactive } from "@waste/db/commands/messaging"
import { QueueMissing } from "@waste/db/jobs"
import { unfilledSentence } from "@waste/domain/messaging/template"
import { PGBOSS_SCHEMA } from "@waste/db/sql/pgboss"
import { sql } from "drizzle-orm"
import { PgBoss } from "pg-boss"

import { createApp } from "../app"
import { WORKER_QUEUE_MISSING } from "../routes/generation"
import { nameTaken } from "../routes/message-templates"
import { PICK_A_TEMPLATE } from "../routes/messages"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const owner = ownerUnderTest()
const TemplatePage = Page(MessageTemplate)
const MessagePage = Page(Message)

describe("messaging", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let boss: PgBoss
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role with Project Access to Copenhagen Central only, granted view on both modules: it reads and writes nothing. */
  let viewer: Call
  let other: Call
  let housing: Customer
  let hanne: CustomerContact
  let email: MessageTemplate
  let sms: MessageTemplate

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    boss = new PgBoss({ connectionString: owner.url, schema: PGBOSS_SCHEMA, migrate: false, supervise: false, schedule: false })
    await boss.start()
    await boss.createQueue(SEND_MESSAGE_QUEUE)
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [
      { moduleKey: "configure.templates", actions: ["view"] },
      { moduleKey: "customers.contacts", actions: ["view"] },
    ])
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    housing = await created(olivia, "/customers", await olivia("/customers", { method: "POST", body: { kind: "organisation", name: "Østerbro Boligforening", email: "kontor@osterbro.example" } }), Customer)
    hanne = await created(olivia, "/customer-contacts", await olivia(`/customers/${housing.id}/contacts`, { method: "POST", body: { name: "Hanne Holm", role: "billing", phone: "+45 20 30 40 50" } }), CustomerContact)
  })
  after(async () => {
    if (ownerPool && a) await ownerPool.db.execute(sql`delete from ${sql.raw(PGBOSS_SCHEMA)}.job where name = ${SEND_MESSAGE_QUEUE} and data->>'companyId' in (${a.companyId}, ${b?.companyId ?? a.companyId})`)
    await boss?.stop({ graceful: false, close: true })
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await ownerPool?.close()
    await pool?.close()
  })

  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const writeTemplate = async (body: unknown) => created(olivia, "/message-templates", await olivia("/message-templates", { method: "POST", body }), MessageTemplate)
  const sendMessage = async (body: unknown) => created(olivia, "/messages", await olivia("/messages", { method: "POST", body }), Message)

  describe("the templates", () => {
    test("are a project's, an e-mail with its subject and a text message without, active unless said otherwise", async () => {
      email = await writeTemplate({ projectId: a.projects.copenhagen.id, name: "Collection moved", purpose: "service", channel: "email", subject: "About {{customerName}}", body: "Dear {{recipientName}},\nyour collection moves.\n{{companyName}}" })
      assert.equal(email.status, "active")
      sms = await writeTemplate({ projectId: a.projects.harbor.id, name: "Invoice due", purpose: "billing", channel: "sms", body: "{{recipientName}}: your invoice is due" })
      assert.equal(sms.subject, null)
      const page = TemplatePage.parse(await (await viewer("/message-templates")).json())
      assert.deepEqual(page.items.map((template) => template.name), ["Collection moved"], "the viewer works in Copenhagen alone")
    })

    test("refuse a name taken in the project, a placeholder no message fills, a project the caller does not work in, and a channel moved without its subject", async () => {
      const taken = await refused(await olivia("/message-templates", { method: "POST", body: { projectId: a.projects.copenhagen.id, name: "Collection moved", purpose: "service", channel: "sms", body: "Hi" } }), 409)
      assert.equal(taken.detail, nameTaken("Collection moved"))
      const unknown = await refused(await olivia("/message-templates", { method: "POST", body: { projectId: a.projects.copenhagen.id, name: "Bad", purpose: "service", channel: "sms", body: "Invoice {{invoiceNumber}}" } }), 400)
      assert.deepEqual(unknown.errors, [{ path: "body", message: unknownPlaceholderSentence(["invoiceNumber"]) }])
      await refused(await other("/message-templates", { method: "POST", body: { projectId: a.projects.copenhagen.id, name: "Theirs", purpose: "service", channel: "sms", body: "Hi" } }), 400)
      const moved = await refused(await olivia(`/message-templates/${sms.id}`, { method: "PATCH", body: { channel: "email" } }), 400)
      assert.deepEqual(moved.errors, [{ path: "subject", message: "An e-mail template has a subject" }])
      const both = await olivia(`/message-templates/${sms.id}`, { method: "PATCH", body: { channel: "email", subject: "Your invoice" } })
      assert.equal(both.status, 200)
      const back = await olivia(`/message-templates/${sms.id}`, { method: "PATCH", body: { channel: "sms", subject: null } })
      assert.equal(MessageTemplate.parse(await back.json()).channel, "sms")
    })

    test("are written by a role granted to, and are another company's to nobody", async () => {
      await refused(await viewer("/message-templates", { method: "POST", body: { projectId: a.projects.copenhagen.id, name: "X", purpose: "service", channel: "sms", body: "Hi" } }), 403)
      await refused(await viewer(`/message-templates/${email.id}`, { method: "PATCH", body: { name: "Renamed" } }), 403)
      await refused(await other(`/message-templates/${email.id}`), 404)
      await refused(await viewer(`/message-templates/${sms.id}`), 404)
    })
  })

  describe("the office's request and the delivery log", () => {
    test("queues a template rendered to the customer's own address, with the worker's job sent in its transaction", async () => {
      const queued = await sendMessage({ templateId: email.id, customerId: housing.id })
      assert.deepEqual([queued.status, queued.channel, queued.purpose, queued.recipient, queued.subject, queued.contactId, queued.attempts, queued.projectId], ["queued", "email", "service", "kontor@osterbro.example", "About Østerbro Boligforening", null, 0, a.projects.copenhagen.id])
      assert.match(queued.body, /^Dear Østerbro Boligforening,\nyour collection moves\.\n/)
      const jobs = await ownerPool.db.execute<{ data: { companyId: string; messageId: string } }>(sql`select data from ${sql.raw(PGBOSS_SCHEMA)}.job where name = ${SEND_MESSAGE_QUEUE} and data->>'messageId' = ${queued.id}`)
      assert.deepEqual(jobs.map((job) => job.data), [{ companyId: a.companyId, messageId: queued.id }])
    })

    test("goes to a contact person's address where one is named", async () => {
      const queued = await sendMessage({ templateId: sms.id, customerId: housing.id, contactId: hanne.id })
      assert.deepEqual([queued.recipient, queued.body, queued.contactId, queued.projectId], ["+45 20 30 40 50", "Hanne Holm: your invoice is due", hanne.id, a.projects.harbor.id])
    })

    test("is refused where the recipient has no address, the contact is not the customer's, or the template is inactive", async () => {
      const noPhone = await refused(await olivia("/messages", { method: "POST", body: { templateId: sms.id, customerId: housing.id } }), 409)
      assert.equal(noPhone.detail, noAddress("Østerbro Boligforening", "sms"))
      const person = await created(olivia, "/customers", await olivia("/customers", { method: "POST", body: { kind: "person", name: "Anna Jensen", email: "anna@example.dk" } }), Customer)
      const notTheirs = await refused(await olivia("/messages", { method: "POST", body: { templateId: email.id, customerId: person.id, contactId: hanne.id } }), 400)
      assert.deepEqual(notTheirs.errors, [{ path: "contactId", message: CONTACT_NOT_THE_CUSTOMERS }])
      await olivia(`/message-templates/${email.id}`, { method: "PATCH", body: { status: "inactive" } })
      try {
        const inactive = await refused(await olivia("/messages", { method: "POST", body: { templateId: email.id, customerId: person.id } }), 409)
        assert.equal(inactive.detail, templateInactive("Collection moved"))
      } finally {
        await olivia(`/message-templates/${email.id}`, { method: "PATCH", body: { status: "active" } })
      }
      const theirs = await refused(await other("/messages", { method: "POST", body: { templateId: email.id, customerId: housing.id } }), 400)
      assert.deepEqual(theirs.errors, [{ path: "templateId", message: PICK_A_TEMPLATE }])
      // A booking notice's template names the collection's day, which the office's send has none of (O16 of #290, part b).
      const notice = await writeTemplate({ projectId: a.projects.copenhagen.id, name: "Bulky booked", purpose: "service", channel: "email", subject: "On {{collectionDate}}", body: "Dear {{recipientName}}" })
      const unfilled = await refused(await olivia("/messages", { method: "POST", body: { templateId: notice.id, customerId: person.id } }), 409)
      assert.equal(unfilled.detail, unfilledSentence("Bulky booked", ["collectionDate"]))
    })

    test("is read newest first, by customer and status, inside the caller's projects", async () => {
      const log = MessagePage.parse(await (await olivia(`/messages?customerId=${housing.id}`)).json())
      assert.deepEqual(log.items.map((item) => item.recipient), ["+45 20 30 40 50", "kontor@osterbro.example"])
      assert.equal(MessagePage.parse(await (await olivia(`/messages?customerId=${housing.id}&status=sent`)).json()).items.length, 0)
      const seen = MessagePage.parse(await (await viewer(`/messages?customerId=${housing.id}`)).json())
      assert.deepEqual(seen.items.map((item) => item.recipient), ["kontor@osterbro.example"], "Harbor's message is outside the viewer's projects")
      const one = await olivia(`/messages/${log.items[0].id}`)
      assert.deepEqual(Message.parse(await one.json()), log.items[0])
      await refused(await viewer(`/messages/${log.items[0].id}`), 404)
      await refused(await viewer("/messages", { method: "POST", body: { templateId: email.id, customerId: housing.id } }), 403)
    })

    test("answers 503 and writes nothing where no worker has made the queue", async () => {
      const noWorker = callingAs(createApp({ probe: pool, pool, verifier: keys.verifier, jobs: { send: async () => Promise.reject(new QueueMissing(SEND_MESSAGE_QUEUE)) } }), keys, a.users.olivia, a.companyId)
      const before = MessagePage.parse(await (await olivia(`/messages?customerId=${housing.id}`)).json()).items.length
      const problem = await refused(await noWorker("/messages", { method: "POST", body: { templateId: email.id, customerId: housing.id } }), 503)
      assert.equal(problem.detail, WORKER_QUEUE_MISSING)
      assert.equal(MessagePage.parse(await (await olivia(`/messages?customerId=${housing.id}`)).json()).items.length, before)
    })
  })
})
