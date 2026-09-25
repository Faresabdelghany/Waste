// The Customer mapping (Issue #81): the prototype's two customer prefixes,
// the fixture matched by name, and the create and patch bodies held against
// the contracts' `CustomerCreate` and `CustomerPatch`.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { CustomerCreate, CustomerPatch, type Customer } from "@waste/contracts/customers"

import { getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { isInProjectScope } from "../../data/project-scope"
import { NOTHING_RESOLVED, type MappingContext } from "../records/adapter"
import { CUSTOMER_PREFIXES, customerAdapter, customerKindOf, customersModule } from "../records/registry"

const NOW = new Date("2026-09-25T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }

const module = getModuleDefinition({ workspaceId: "customers", moduleId: "contacts" })
if (!module) throw new Error("customers.contacts is not a registered module")
const fixtures = module.records
const context: MappingContext = { fixtures, resolve: NOTHING_RESOLVED, companyRecordId: "company-kystbyen-dk", now: NOW }

// The seeded rows as the API answers them (packages/db/src/seed/registry.ts).
const mikkel: Customer = { id: "01a0d2a4-a280-700b-8000-000000000001", ...STAMPS, kind: "person", name: "Mikkel Sørensen", registrationNumber: null, email: "mikkel.sorensen@example.dk", phone: "+45 20 11 88 04", billingAddress: null, serviceMessagesAllowed: true, status: "active" }
const osterbro: Customer = { id: "01a0d2a4-a280-700b-8000-000000000002", ...STAMPS, kind: "organisation", name: "Østerbro Housing", registrationNumber: "38112009", email: "service@osterbro-housing.example", phone: null, billingAddress: null, serviceMessagesAllowed: true, status: "active" }
const kab: Customer = { ...osterbro, id: "01a0d2a4-a280-700b-8000-000000000004", name: "KAB Bolig", registrationNumber: null, email: null, status: "inactive" }

describe("a customer on the prototype's record", () => {
  test("a seeded person is the contact- fixture, by name, with the wire's fields over the fixture's facts", () => {
    const record = customerAdapter.toRecord(mikkel, context)
    assert.equal(record.id, "contact-mikkel")
    assert.equal(record.name, "Mikkel Sørensen")
    assert.equal(record.status, "Active")
    assert.equal(record.facts.Kind, "Person")
    assert.equal(record.facts.Email, "mikkel.sorensen@example.dk")
    assert.equal(record.facts.Phone, "+45 20 11 88 04")
    assert.equal(record.facts.CVR, undefined, "a null on the wire clears the fact")
    assert.equal(record.facts.Portal, "Enabled", "a fact only the fixture knows stays")
    assert.equal(record.owner, "Østerbro Housing")
    assert.equal(record.submittedValues?.partyType, "person")
    assert.equal(record.updated, "Today")
    assert.ok(isInProjectScope(record, "project-copenhagen"))
    assert.ok(isInProjectScope(record, "project-cairo"), "the company's customer shows in every scope")
  })

  test("a seeded organisation is the company- fixture", () => {
    const record = customerAdapter.toRecord(osterbro, context)
    assert.equal(record.id, "company-osterbro-housing")
    assert.equal(record.facts.CVR, "38112009")
    assert.equal(record.facts.Kind, "Organisation")
    assert.equal(record.submittedValues?.partyType, "company")
    assert.equal(record.submittedValues?.organizationId, "38112009")
  })

  test("a customer no fixture names takes its kind's prefix and no fixture presentation", () => {
    const record = customerAdapter.toRecord(kab, context)
    assert.equal(record.id, `${CUSTOMER_PREFIXES.organisation}-${kab.id}`)
    assert.equal(record.status, "Inactive")
    assert.equal(record.owner, "")
    assert.equal(record.context, "Customer organisation")
    assert.equal(record.facts.Consent, "Service messages")
    assert.equal(record.projectIds, undefined)
  })

  test("the kind is read off the party type first and the id prefix otherwise", () => {
    assert.equal(customerKindOf({ id: "contact-x", submittedValues: {} }), "person")
    assert.equal(customerKindOf({ id: "company-x" }), "organisation")
    assert.equal(customerKindOf({ id: "contacts-contact-or-customer-organization-1", submittedValues: { partyType: "company" } }), "organisation")
    assert.equal(customerKindOf({ id: "agreement-2408" }), undefined)
    assert.ok(customerAdapter.owns({ id: "contact-mikkel" } as BusinessRecord))
    assert.ok(!customerAdapter.owns({ id: "property-parkvej-18" } as BusinessRecord))
  })

  test("the form's record becomes a CustomerCreate the contracts accept, saying only what the form gave", () => {
    const record: BusinessRecord = {
      ...customerAdapter.toRecord(kab, context),
      id: "contacts-contact-or-customer-organization-1700000000000",
      name: "Nørrebro Boligselskab",
      status: "Active",
      submittedValues: { partyType: "company", displayName: "Nørrebro Boligselskab", organizationId: "12345670", email: "", phone: "", billingAddress: "Nørrebrogade 1", serviceMessagesAllowed: false, relationshipRole: "owner", projectScope: "company" },
    }
    const body = customerAdapter.toCreateBody?.(record, context)
    assert.deepEqual(body, { kind: "organisation", name: "Nørrebro Boligselskab", registrationNumber: "12345670", billingAddress: "Nørrebrogade 1", serviceMessagesAllowed: false })
    const parsed = CustomerCreate.safeParse(body)
    assert.ok(parsed.success, JSON.stringify(parsed.error))
  })

  test("a create without a kind or a name is refused here, naming the field", () => {
    const record = { ...customerAdapter.toRecord(kab, context), id: "contacts-x", submittedValues: { displayName: "Someone" } }
    assert.deepEqual(customerAdapter.toCreateBody?.(record, context), { path: "partyType", message: "Say whether this is a person or an organisation" })
  })

  test("a patch says what moved, an emptied nullable field as null, and the contracts accept it", () => {
    const before = customerAdapter.toRecord(mikkel, context)
    const after = { ...before, status: "Inactive", submittedValues: { ...before.submittedValues, phone: "", email: "mikkel@example.dk" } }
    const body = customerAdapter.toPatchBody(before, after, context)
    assert.deepEqual(body, { email: "mikkel@example.dk", phone: null, status: "inactive" })
    const parsed = CustomerPatch.safeParse(body)
    assert.ok(parsed.success, JSON.stringify(parsed.error))
    assert.equal(customerAdapter.toPatchBody(before, before, context), null)
  })

  test("the module is Customers → Contacts & Companies", () => {
    assert.equal(customersModule.workspaceId, "customers")
    assert.equal(customersModule.moduleId, "contacts")
  })
})
