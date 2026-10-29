// A message sent (#291 C15), on the shared local database with a tenant of
// this file's own: `queueMessage` writes the row `queued` and sends the job
// in its transaction, to a contact's address or the customer's own; the job
// sends it through the provider and records it `sent`; a service message to
// a customer who allows none is `withheld` and never reaches the provider,
// while a billing one is sent; a failing provider is tried again until the
// last attempt marks it `failed`; a message no longer queued writes nothing;
// and the log-only sender sends nothing and logs the address masked.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import type { Database } from "@waste/db/client"
import { createDb } from "@waste/db/client"
import { noAddress, queueMessage, SEND_MESSAGE_QUEUE, type SendMessageData } from "@waste/db/commands/messaging"
import { Refused } from "@waste/db/commands/shared"
import type { Send } from "@waste/db/jobs"
import { customer, customerContact } from "@waste/db/schema/customers"
import { message, messageTemplate } from "@waste/db/schema/messaging"
import { withCompany } from "@waste/db/tenant"
import { eq } from "drizzle-orm"

import { JOBS } from "../jobs"
import type { JobContext } from "../jobs/definition"
import { MAX_ATTEMPTS, NO_CONSENT, sendMessage } from "../jobs/send-message"
import { LogOnlyProvider } from "../messaging/log-only"
import type { MessagingProvider, OutgoingMessage } from "../messaging/provider"
import { messagingProviderFromEnv } from "../messaging/select"
import { at, dropConsumerTenant, seedConsumerTenant, testId, type ConsumerTenant } from "./consumer-fixtures"
import { databaseUnderTest, ownerUnderTest } from "./database"

const api = databaseUnderTest()
const owner = ownerUnderTest()

/** A provider that records what it was handed and answers as told. */
function scripted(answers: Array<"ok" | Error>): MessagingProvider & { handed: OutgoingMessage[] } {
  const handed: OutgoingMessage[] = []
  return {
    name: "scripted",
    handed,
    send: async (outgoing) => {
      handed.push(outgoing)
      const answer = answers.shift() ?? "ok"
      if (answer instanceof Error) throw answer
      return { providerMessageId: `scripted-${handed.length}` }
    },
  }
}

describe("messaging.send", { skip: api.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let tenant: ConsumerTenant
  const NOW = at("13:30")
  const lines: string[] = []
  const sent: Array<{ name: string; data: unknown }> = []
  const send: Send = async (name, data) => {
    sent.push({ name, data })
    return testId()
  }
  const context = (messaging?: MessagingProvider) => ({ api: pool, now: () => NOW, log: (line: string) => void lines.push(line), ...(messaging === undefined ? {} : { messaging }) }) as JobContext
  let serviceEmail: string
  let billingSms: string
  let hanne: string

  const queue = (templateId: string, contactId: string | null = null) =>
    withCompany(pool.db, tenant.companyId, (tx) => queueMessage(tx, send, { id: testId(), companyId: tenant.companyId, templateId, customerId: tenant.customerId, contactId }))
  const read = async (id: string) => {
    const [row] = await withCompany(pool.db, tenant.companyId, (tx) => tx.select().from(message).where(eq(message.id, id)))
    return row
  }
  const consent = (allowed: boolean) => withCompany(pool.db, tenant.companyId, (tx) => tx.update(customer).set({ serviceMessagesAllowed: allowed }).where(eq(customer.id, tenant.customerId)))

  before(async () => {
    pool = createDb(api.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    tenant = await seedConsumerTenant(pool)
    serviceEmail = testId()
    billingSms = testId()
    hanne = testId()
    await withCompany(pool.db, tenant.companyId, async (tx) => {
      await tx.update(customer).set({ email: "office@parkvej.example", phone: null }).where(eq(customer.id, tenant.customerId))
      await tx.insert(customerContact).values({ id: hanne, companyId: tenant.companyId, customerId: tenant.customerId, name: "Hanne Holm", role: "billing", email: "hanne@parkvej.example", phone: "+45 20 30 40 50", status: "active" })
      await tx.insert(messageTemplate).values([
        { id: serviceEmail, companyId: tenant.companyId, projectId: tenant.projectId, name: "Collection moved", purpose: "service", channel: "email", subject: "About {{customerName}}", body: "Dear {{recipientName}}, from {{companyName}}", status: "active" },
        { id: billingSms, companyId: tenant.companyId, projectId: tenant.projectId, name: "Invoice due", purpose: "billing", channel: "sms", subject: null, body: "{{recipientName}}: your invoice is due", status: "active" },
      ])
    })
  })
  after(async () => {
    if (tenant !== undefined) await dropConsumerTenant(pool, ownerPool, tenant.companyId)
    await pool?.close()
    await ownerPool?.close()
  })

  test("is a job of the registry, retried twice", () => {
    const job = JOBS.find((candidate) => candidate.queue === SEND_MESSAGE_QUEUE)
    assert.ok(job !== undefined)
    assert.equal(job.queueOptions?.retryLimit, MAX_ATTEMPTS - 1)
  })

  test("a message is queued rendered, to the contact's address or the customer's own, with its job sent beside it", async () => {
    const toCustomer = await queue(serviceEmail)
    const row = await read(toCustomer.id)
    assert.deepEqual([row.status, row.recipient, row.subject, row.attempts, row.projectId], ["queued", "office@parkvej.example", "About Parkvej Boligforening", 0, tenant.projectId])
    assert.match(row.body, /^Dear Parkvej Boligforening, from Consumer Test /)
    const toHanne = await queue(billingSms, hanne)
    assert.deepEqual([(await read(toHanne.id)).recipient, (await read(toHanne.id)).body], ["+45 20 30 40 50", "Hanne Holm: your invoice is due"])
    assert.deepEqual(sent.slice(-2), [
      { name: SEND_MESSAGE_QUEUE, data: { companyId: tenant.companyId, messageId: toCustomer.id } },
      { name: SEND_MESSAGE_QUEUE, data: { companyId: tenant.companyId, messageId: toHanne.id } },
    ])
  })

  test("a recipient with no address on the channel is refused, and nothing is queued", async () => {
    await assert.rejects(queue(billingSms), (error) => error instanceof Refused && error.status === 409 && error.message === noAddress("Parkvej Boligforening", "sms"))
  })

  test("the provider sends it and the log says sent, by whom and when", async () => {
    const queued = await queue(serviceEmail, hanne)
    const provider = scripted(["ok"])
    assert.equal(await sendMessage({ companyId: tenant.companyId, messageId: queued.id }, context(provider)), "sent")
    assert.deepEqual(provider.handed, [{ id: queued.id, channel: "email", to: "hanne@parkvej.example", subject: "About Parkvej Boligforening", body: (await read(queued.id)).body }])
    const row = await read(queued.id)
    assert.deepEqual([row.status, row.attempts, row.provider, row.providerMessageId, row.sentAt?.toISOString(), row.reason], ["sent", 1, "scripted", "scripted-1", NOW.toISOString(), null])
    assert.equal(await sendMessage({ companyId: tenant.companyId, messageId: queued.id }, context(provider)), "settled", "a redelivered job writes nothing")
    assert.equal(provider.handed.length, 1)
  })

  test("a service message to a customer who allows none is withheld and never reaches the provider; a billing one is sent", async () => {
    await consent(false)
    try {
      const service = await queue(serviceEmail)
      const billing = await queue(billingSms, hanne)
      const provider = scripted([])
      assert.equal(await sendMessage({ companyId: tenant.companyId, messageId: service.id }, context(provider)), "withheld")
      assert.equal(await sendMessage({ companyId: tenant.companyId, messageId: billing.id }, context(provider)), "sent")
      assert.deepEqual(provider.handed.map((handed) => handed.id), [billing.id])
      const withheld = await read(service.id)
      assert.deepEqual([withheld.status, withheld.reason, withheld.attempts, withheld.sentAt], ["withheld", NO_CONSENT, 0, null])
    } finally {
      await consent(true)
    }
  })

  test("a failing provider is tried again until the last attempt marks the message failed", async () => {
    const queued = await queue(serviceEmail)
    const data: SendMessageData = { companyId: tenant.companyId, messageId: queued.id }
    const provider = scripted([new Error("Mailbox unavailable"), new Error("Mailbox unavailable"), new Error("Mailbox full")])
    await assert.rejects(sendMessage(data, context(provider)), /Mailbox unavailable/)
    assert.deepEqual([(await read(queued.id)).status, (await read(queued.id)).attempts, (await read(queued.id)).reason], ["queued", 1, "Mailbox unavailable"])
    await assert.rejects(sendMessage(data, context(provider)), /Mailbox unavailable/)
    assert.equal(await sendMessage(data, context(provider)), "failed")
    const row = await read(queued.id)
    assert.deepEqual([row.status, row.attempts, row.reason, row.sentAt], ["failed", MAX_ATTEMPTS, "Mailbox full", null])
  })

  test("the log-only sender is the default: it sends nothing and logs the address masked", async () => {
    const queued = await queue(serviceEmail, hanne)
    lines.length = 0
    assert.equal(await sendMessage({ companyId: tenant.companyId, messageId: queued.id }, context()), "sent")
    const row = await read(queued.id)
    assert.deepEqual([row.provider, row.providerMessageId], ["log", `log-${queued.id}`])
    assert.deepEqual(lines, [`messaging: log-only sender: email ${queued.id} to h***@parkvej.example, not sent`])
    assert.ok(!lines.join("").includes("Hanne"), "nothing the message says")
  })
})

describe("the messaging provider switch", () => {
  test("unset or log is the log-only sender; any other name stops the start", () => {
    assert.ok(messagingProviderFromEnv(undefined) instanceof LogOnlyProvider)
    assert.ok(messagingProviderFromEnv("log") instanceof LogOnlyProvider)
    assert.throws(() => messagingProviderFromEnv("sendgrid"), /MESSAGING_PROVIDER=sendgrid names no provider here/)
  })
})
