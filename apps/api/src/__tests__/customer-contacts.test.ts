// A Customer's Contact Persons (#291 C14) against a real database: an
// organisation's, never a person's; reached on a channel at least, on the
// create and on a patch against the stored row; lowercased; retired by
// status, never deleted; fenced by the tenant and granted under the
// customer's own module; and an organisation with active contacts is not
// made a person.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Customer, CustomerContact, CustomerContacts, REACHABLE_ON_A_CHANNEL } from "@waste/contracts/customers"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { CONTACTS_ARE_AN_ORGANISATIONS } from "../routes/customer-contacts"
import { keepsActiveContacts } from "../routes/customer-writes"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const MODULE = "customers.contacts"

describe("a customer's contact persons", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let olivia: Call
  /** A role granted `view` alone: it reads contacts and writes none. */
  let lars: Call
  let other: Call
  let housing: Customer
  let person: Customer

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.providerManager.id, [{ moduleKey: MODULE, actions: ["view"] }])
    const app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    housing = await createCustomer(olivia, { kind: "organisation", name: "Østerbro Boligforening" })
    person = await createCustomer(olivia, { kind: "person", name: "Anna Jensen" })
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  const createCustomer = async (call: Call, values: unknown): Promise<Customer> => created(call, "/customers", await call("/customers", { method: "POST", body: values }), Customer)
  const addContact = async (customerId: string, values: unknown): Promise<CustomerContact> =>
    created(olivia, "/customer-contacts", await olivia(`/customers/${customerId}/contacts`, { method: "POST", body: values }), CustomerContact)
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const contactsOf = async (call: Call, customerId: string) => {
    const response = await call(`/customers/${customerId}/contacts`)
    assert.equal(response.status, 200)
    return CustomerContacts.parse(await response.json()).items
  }

  test("an organisation takes contacts with a role and their channels, the e-mail lowercased, active unless said otherwise", async () => {
    const hanne = await addContact(housing.id, { name: "Hanne Holm", role: "billing", email: "Hanne.Holm@Example.DK" })
    assert.equal(hanne.customerId, housing.id)
    assert.equal(hanne.email, "hanne.holm@example.dk")
    assert.equal(hanne.phone, null)
    assert.equal(hanne.status, "active")
    const ole = await addContact(housing.id, { name: "Ole Vicevært", role: "on-site", phone: "+45 20 30 40 50" })
    assert.deepEqual(
      (await contactsOf(lars, housing.id)).map((contact) => contact.name),
      ["Hanne Holm", "Ole Vicevært"],
    )
    const read = await lars(`/customer-contacts/${ole.id}`)
    assert.equal(read.status, 200)
    assert.deepEqual(CustomerContact.parse(await read.json()), ole)
  })

  test("a person is their own contact, and a customer the company does not have is a 404", async () => {
    const problem = await refused(await olivia(`/customers/${person.id}/contacts`, { method: "POST", body: { name: "Someone", role: "primary", email: "s@example.dk" } }), 409)
    assert.equal(problem.detail, CONTACTS_ARE_AN_ORGANISATIONS)
    await refused(await olivia(`/customers/${testId()}/contacts`, { method: "POST", body: { name: "Someone", role: "primary", email: "s@example.dk" } }), 404)
    await refused(await olivia(`/customers/${testId()}/contacts`), 404)
    assert.deepEqual(await contactsOf(olivia, person.id), [])
  })

  test("a contact is reached on a channel at least: refused on the create, and on a patch that would leave neither", async () => {
    const problem = await refused(await olivia(`/customers/${housing.id}/contacts`, { method: "POST", body: { name: "Nobody", role: "other" } }), 400)
    assert.deepEqual(problem.errors, [{ path: "email", message: REACHABLE_ON_A_CHANNEL }])
    const mette = await addContact(housing.id, { name: "Mette", role: "operations", email: "mette@example.dk" })
    const cleared = await refused(await olivia(`/customer-contacts/${mette.id}`, { method: "PATCH", body: { email: null } }), 400)
    assert.deepEqual(cleared.errors, [{ path: "email", message: REACHABLE_ON_A_CHANNEL }])
    const swapped = await olivia(`/customer-contacts/${mette.id}`, { method: "PATCH", body: { email: null, phone: "+45 11 22 33 44" } })
    assert.equal(swapped.status, 200)
    const now = CustomerContact.parse(await swapped.json())
    assert.equal(now.email, null)
    assert.equal(now.phone, "+45 11 22 33 44")
  })

  test("a contact who has left is made inactive, never deleted, and the organisation is a person only once none is active", async () => {
    const organisation = await createCustomer(olivia, { kind: "organisation", name: "Sole trader ApS" })
    const owner = await addContact(organisation.id, { name: "Peter", role: "primary", email: "peter@example.dk" })
    const problem = await refused(await olivia(`/customers/${organisation.id}`, { method: "PATCH", body: { kind: "person" } }), 409)
    assert.equal(problem.detail, keepsActiveContacts(1))
    const retired = await olivia(`/customer-contacts/${owner.id}`, { method: "PATCH", body: { status: "inactive" } })
    assert.equal(retired.status, 200)
    assert.equal(CustomerContact.parse(await retired.json()).status, "inactive")
    assert.equal((await olivia(`/customers/${organisation.id}`, { method: "PATCH", body: { kind: "person" } })).status, 200)
    assert.deepEqual((await contactsOf(olivia, organisation.id)).map((contact) => contact.status), ["inactive"])
  })

  test("a role with view alone writes none, and another company's customer and contact do not exist here", async () => {
    await refused(await lars(`/customers/${housing.id}/contacts`, { method: "POST", body: { name: "X", role: "other", email: "x@example.dk" } }), 403)
    const [first] = await contactsOf(olivia, housing.id)
    await refused(await lars(`/customer-contacts/${first.id}`, { method: "PATCH", body: { name: "Renamed" } }), 403)
    await refused(await other(`/customer-contacts/${first.id}`), 404)
    await refused(await other(`/customer-contacts/${first.id}`, { method: "PATCH", body: { name: "Theirs now" } }), 404)
    await refused(await other(`/customers/${housing.id}/contacts`), 404)
    await refused(await olivia(`/customer-contacts/${first.id}`, { method: "PATCH", body: { customerId: person.id } }), 400)
  })

  test("a contact's changes are its customer's history", async () => {
    const [first] = await contactsOf(olivia, housing.id)
    await olivia(`/customer-contacts/${first.id}`, { method: "PATCH", body: { role: "primary" } })
    const response = await olivia(`/audit-events?table=customer_contact&rowId=${first.id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const { items } = (await response.json()) as { items: Array<{ action: string }> }
    assert.deepEqual(items.map((event) => event.action).sort(), ["insert", "update"])
  })
})
