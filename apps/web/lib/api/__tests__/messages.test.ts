// A customer's messages on the adapter (#291 C15): Send message's draft as
// the contracts' body, the customer named by the row it is sent from, sent
// as the customer's action over a scripted `fetch`; the recipient picker's
// rule; and a message as its line reads.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { CustomerContact } from "@waste/contracts/customers"
import { MessageCreate } from "@waste/contracts/messaging"

import { FIXTURE_COMPANY_ID } from "../../data/business-modules"
import { NOTHING_RESOLVED } from "../records/adapter"
import { messageBody, messageDraftOf, messageLine, recipientOptions, SEND_MESSAGE, TO_CUSTOMER } from "../records/messages"
import { customerAdapter, customersModule } from "../records/registry"
import { actOnRecord, loaded, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, scripted } from "./scripted-fetch"

const NOW = new Date("2026-10-01T10:00:00Z")
const CUSTOMER_ID = "01a0d2a4-a280-7004-8000-000000000101"
const CONTACT_ID = "01a0d2a4-a280-7004-8000-000000000201"
const TEMPLATE_ID = "01a0d2a4-a280-7099-8000-000000000001"
const STAMPS = { createdAt: "2026-10-01T08:00:00.000Z", updatedAt: "2026-10-01T08:00:00.000Z" }

const organisation = customerAdapter.toRecord(
  { id: CUSTOMER_ID, ...STAMPS, kind: "organisation", name: "Østerbro Boligforening", registrationNumber: null, email: "kontor@osterbro.example", phone: null, billingAddress: null, serviceMessagesAllowed: true, status: "active", paymentTermsDays: null },
  { fixtures: [], resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW },
)
const state: ServerRecordsState = new Map([["customers.contacts", loaded({ records: [organisation], serverIds: new Map([[organisation.id, CUSTOMER_ID]]) }, 1)]])
const contact = (values: Partial<CustomerContact>): CustomerContact => ({ id: CONTACT_ID, ...STAMPS, customerId: CUSTOMER_ID, name: "Hanne Holm", role: "billing", email: null, phone: "+45 20 30 40 50", status: "active", ...values })

describe("a customer's messages (#291 C15)", () => {
  test("a draft is the contracts' body, to the customer's own address or to a contact person", () => {
    assert.deepEqual(messageBody({ templateId: TEMPLATE_ID, recipient: TO_CUSTOMER }, CUSTOMER_ID), { templateId: TEMPLATE_ID, customerId: CUSTOMER_ID })
    const toHanne = messageBody({ templateId: TEMPLATE_ID, recipient: CONTACT_ID }, CUSTOMER_ID)
    assert.deepEqual(toHanne, { templateId: TEMPLATE_ID, customerId: CUSTOMER_ID, contactId: CONTACT_ID })
    assert.ok(MessageCreate.safeParse(toHanne).success)
    assert.deepEqual(messageDraftOf({ message: { templateId: "", recipient: "" } }), { path: "templateId", message: "Pick a template" })
    assert.deepEqual(messageDraftOf({ message: { templateId: TEMPLATE_ID, recipient: "" } }), { path: "contactId", message: "Pick who it goes to" })
  })

  test("is sent as the customer's action, and the customer's row stays as it is", async () => {
    const answer = { id: "01a0d2a4-a280-709a-8000-000000000001", ...STAMPS, projectId: CUSTOMER_ID, templateId: TEMPLATE_ID, customerId: CUSTOMER_ID, contactId: null, channel: "email", purpose: "service", recipient: "kontor@osterbro.example", subject: "S", body: "B", status: "queued", attempts: 0, provider: null, providerMessageId: null, reason: null, sentAt: null }
    const { fetch, calls } = scripted([() => json(answer, 201, { location: `/messages/${answer.id}` })])
    const current = state.get("customers.contacts")
    assert.ok(current !== undefined)
    const outcome = await actOnRecord(clientOver(fetch), customersModule, current, organisation, SEND_MESSAGE, { message: { templateId: TEMPLATE_ID, recipient: TO_CUSTOMER } }, { fixtures: [], state, now: NOW })
    assert.equal(outcome.kind, "done")
    assert.deepEqual(calls.map((call) => `${call.init.method} ${call.url.replace("http://api.test", "")}`), ["POST /messages"])
    assert.deepEqual(bodyOf(calls[0]), { templateId: TEMPLATE_ID, customerId: CUSTOMER_ID })
  })

  test("offers the customer and each active contact with an address on the template's channel", () => {
    const holder = { name: "Østerbro Boligforening", email: "kontor@osterbro.example", phone: null }
    const contacts = [contact({}), contact({ id: "01a0d2a4-a280-7004-8000-000000000202", name: "Ole", email: "ole@osterbro.example", phone: null }), contact({ id: "01a0d2a4-a280-7004-8000-000000000203", name: "Left", phone: "+45 11 11 11 11", status: "inactive" })]
    assert.deepEqual(recipientOptions("email", holder, contacts).map((option) => option.label), ["Østerbro Boligforening · kontor@osterbro.example", "Ole · ole@osterbro.example"])
    assert.deepEqual(recipientOptions("sms", holder, contacts), [{ value: CONTACT_ID, label: "Hanne Holm · +45 20 30 40 50" }])
  })

  test("a message reads its status, channel and address, with the reason where it was withheld or failed", () => {
    assert.equal(messageLine({ status: "sent", channel: "email", recipient: "kontor@osterbro.example", reason: null }), "Sent · E-mail to kontor@osterbro.example")
    assert.equal(messageLine({ status: "withheld", channel: "sms", recipient: "+45 20 30 40 50", reason: "The customer allows no service messages" }), "Withheld · Text message to +45 20 30 40 50 · The customer allows no service messages")
  })
})
