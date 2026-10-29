// An organisation's Contact Persons on the adapter (#291 C14): the dialog's
// draft as the contracts' bodies, refused here before the API where the wire
// would refuse it, sent as the customer's two actions over a scripted
// `fetch` — a new one under the customer, a change at the contact — and a
// contact as its line reads.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { CustomerContactCreate, CustomerContactPatch, REACHABLE_ON_A_CHANNEL as CONTRACTS_SENTENCE } from "@waste/contracts/customers"

import { FIXTURE_COMPANY_ID } from "../../data/business-modules"
import { ADD_CONTACT, contactBody, contactLine, draftOf, EDIT_CONTACT, NEW_CONTACT, REACHABLE_ON_A_CHANNEL, takesContacts } from "../records/customer-contacts"
import { NOTHING_RESOLVED } from "../records/adapter"
import { customerAdapter, customerKindOf, customersModule } from "../records/registry"
import { actOnRecord, loaded, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, scripted } from "./scripted-fetch"

const NOW = new Date("2026-10-01T10:00:00Z")
const CUSTOMER_ID = "01a0d2a4-a280-7004-8000-000000000101"
const CONTACT_ID = "01a0d2a4-a280-7004-8000-000000000201"
const STAMPS = { createdAt: "2026-10-01T08:00:00.000Z", updatedAt: "2026-10-01T08:00:00.000Z" }

const organisation = customerAdapter.toRecord(
  { id: CUSTOMER_ID, ...STAMPS, kind: "organisation", name: "Østerbro Boligforening", registrationNumber: null, email: null, phone: null, billingAddress: null, serviceMessagesAllowed: true, status: "active", paymentTermsDays: null },
  { fixtures: [], resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW },
)
const state: ServerRecordsState = new Map([["customers.contacts", loaded({ records: [organisation], serverIds: new Map([[organisation.id, CUSTOMER_ID]]) }, 1)]])
const hanne = { id: CONTACT_ID, ...STAMPS, customerId: CUSTOMER_ID, name: "Hanne Holm", role: "billing" as const, email: "hanne@example.dk", phone: null, status: "active" as const }

describe("an organisation's contact persons (#291 C14)", () => {
  test("only an organisation takes them: a person is their own contact", () => {
    assert.equal(takesContacts(customerKindOf(organisation)), true)
    assert.equal(takesContacts("person"), false)
  })

  test("a draft goes out as the wire's body, a blank channel a null, and is refused here where the wire would refuse it", () => {
    const sent = contactBody({ contact: { ...NEW_CONTACT, name: " Hanne Holm ", role: "billing", email: "hanne@example.dk" } })
    assert.ok(!("message" in sent))
    assert.deepEqual(sent.body, { name: "Hanne Holm", role: "billing", email: "hanne@example.dk", phone: null, status: "active" })
    assert.ok(CustomerContactCreate.safeParse(sent.body).success)
    assert.equal(REACHABLE_ON_A_CHANNEL, CONTRACTS_SENTENCE)
    assert.deepEqual(contactBody({ contact: { ...NEW_CONTACT, name: "Nobody" } }), { path: "email", message: REACHABLE_ON_A_CHANNEL })
    assert.deepEqual(contactBody({ contact: { ...NEW_CONTACT, email: "x@example.dk" } }), { path: "name", message: "A contact needs a name" })
    const edit = contactBody({ contact: { ...draftOf(hanne), status: "inactive" } })
    assert.ok(!("message" in edit))
    assert.equal(edit.contactId, CONTACT_ID)
    assert.ok(CustomerContactPatch.safeParse(edit.body).success)
  })

  test("a new contact is posted under its customer and a change patched at the contact, the customer's row as it was", async () => {
    const { fetch, calls } = scripted([() => json(hanne, 201, { location: `/customer-contacts/${CONTACT_ID}` }), () => json({ ...hanne, status: "inactive" })])
    const current = state.get("customers.contacts")
    assert.ok(current !== undefined)
    const added = await actOnRecord(clientOver(fetch), customersModule, current, organisation, ADD_CONTACT, { contact: { ...NEW_CONTACT, name: "Hanne Holm", role: "billing", email: "hanne@example.dk" } }, { fixtures: [], state, now: NOW })
    assert.equal(added.kind, "done")
    const retired = await actOnRecord(clientOver(fetch), customersModule, current, organisation, EDIT_CONTACT, { contact: { ...draftOf(hanne), status: "inactive" } }, { fixtures: [], state, now: NOW })
    assert.equal(retired.kind, "done")
    assert.deepEqual(
      calls.map((call) => `${call.init.method} ${call.url.replace("http://api.test", "")}`),
      [`POST /customers/${CUSTOMER_ID}/contacts`, `PATCH /customer-contacts/${CONTACT_ID}`],
    )
    assert.deepEqual(bodyOf(calls[1]), { name: "Hanne Holm", role: "billing", email: "hanne@example.dk", phone: null, status: "inactive" })
  })

  test("a contact reads its role and channels, and says so where they have left", () => {
    assert.equal(contactLine(hanne), "Billing · hanne@example.dk")
    assert.equal(contactLine({ role: "on-site", email: null, phone: "+45 20 30 40 50", status: "inactive" }), "On site · +45 20 30 40 50 · Inactive")
  })
})
