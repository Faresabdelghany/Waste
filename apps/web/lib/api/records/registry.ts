// The Registry's first switched module (Issue #81): the Customer as the
// `customers.contacts` module — the prototype's "Contacts & Companies", one
// wire resource for a person and an organisation alike
// (`@waste/contracts/customers`, `Customer`; apps/api/src/routes/customers.ts).
// A Customer is the company's and not a project's, so the record carries no
// project of its own and shows in every scope, which is what
// `isInProjectScope` does with a record that has none.
//
// A customer's web id carries the prefix of its kind — `contact-` for a
// person and `company-` for an organisation — and the workspace reads a
// party's kind off exactly that prefix (`business-workspace.tsx`,
// `getFormRelationOptions`: a `customerId` field offers `company-` records,
// a `…ContactId` field `contact-` ones).
// The `company-` prefix is shared with the tenant's own record in
// `configure.organization`: the glossary keeps the
// two apart — a Company is the tenant, never a customer (CONTEXT.md) — and so
// does the code: `owns` here is asked of the customers module's records
// only, and the tenant's row is found by the company adapter's `owns` and
// its `recordKind` (`isCompanyRecord`, organisation.ts), never by the prefix.
//
// The form (`customers.contacts`) says more than the wire carries: a
// relationship role, a connected property and company, effective dates, a
// project scope. Those describe a `property_party` row (Issue #78), which the
// Properties module writes; here they stay on the record's typed values, and
// only the Customer's own fields travel. The status is the wire's two
// (`active`, `inactive`), listed as the adapter's `statuses`; the module's
// lifecycle also lists Merged and
// Archived, which the API has no column for, so the store refuses a move
// there before the API sees it and the workspace offers neither.
import type { Customer } from "@waste/contracts/customers"
import { CUSTOMER_STATUSES } from "@waste/domain/registry/vocabulary"

import { moduleAt } from "@/lib/modules/keys"
import { type BusinessRecord } from "@/lib/data/business-modules"
import { paymentTermsLabel } from "@/lib/data/finance-settings"

import { create, listAll, patch } from "../client"
import { patchOf, type ResourceAdapter, type ServerModule } from "./adapter"
import { isLocalRefusal, statusLabel, statusToken, typed, typedFlag, webIdOf, type LocalRefusal } from "@/lib/records/fields"
import { ADD_CONTACT, ADD_CONTACT_ACTION, EDIT_CONTACT, EDIT_CONTACT_ACTION } from "./customer-contacts"
import { SEND_MESSAGE, SEND_MESSAGE_ACTION } from "./messages"
import { daysOrNoneOf, typedPaymentTerms } from "./organisation"

const refusal = (path: string, message: string): LocalRefusal => ({ path, message })

export const CUSTOMER_PREFIXES = { person: "contact", organisation: "company" } as const

const PARTY_TYPE_OF_KIND = { person: "person", organisation: "company" } as const
const KIND_OF_PARTY_TYPE: Readonly<Record<string, Customer["kind"]>> = { person: "person", company: "organisation", organisation: "organisation" }

export function customerKindOf(record: Pick<BusinessRecord, "id" | "submittedValues">): Customer["kind"] | undefined {
  // The form's party type first: a record the workspace just made carries the module's minted id and says its kind there.
  const partyType = typed(record, "partyType")
  if (partyType !== undefined && KIND_OF_PARTY_TYPE[partyType]) return KIND_OF_PARTY_TYPE[partyType]
  if (record.id.startsWith(`${CUSTOMER_PREFIXES.person}-`)) return "person"
  if (record.id.startsWith(`${CUSTOMER_PREFIXES.organisation}-`)) return "organisation"
  return undefined
}

/** What the record says the customer's fields are, as the wire spells them; undefined leaves a field alone, null clears it. */
function customerFields(record: BusinessRecord) {
  const said = (key: string): string | null | undefined => {
    if (record.submittedValues === undefined || !(key in record.submittedValues)) return undefined
    return typed(record, key) ?? null
  }
  return {
    kind: customerKindOf(record),
    name: typed(record, "displayName") ?? record.name,
    registrationNumber: said("organizationId"),
    email: said("email"),
    phone: said("phone"),
    billingAddress: said("billingAddress"),
    serviceMessagesAllowed: typedFlag(record, "serviceMessagesAllowed"),
    // Its own payment terms (#291 C4); a blank is none of its own, the project's.
    paymentTermsDays: daysOrNoneOf(typedPaymentTerms(record, "cleared")),
    // The record's own status label is what the workspace shows and a
    // controlled action moves; the wire's two are what it may say.
    status: CUSTOMER_STATUSES.find((candidate) => candidate === statusToken(record.status)),
  }
}

export const customerAdapter: ResourceAdapter<Customer> = {
  prefix: "customer",
  auditTable: "customer",
  // Both prefixes, and nothing else the module could hold.
  owns: (record) => customerKindOf(record) !== undefined,
  statuses: CUSTOMER_STATUSES,
  list: (client) => listAll<Customer>(client, "/customers"),
  toRecord: (customer) => {
    const prefix = CUSTOMER_PREFIXES[customer.kind]
    const facts: Record<string, string> = { Kind: customer.kind === "person" ? "Person" : "Organisation" }
    const fact = (label: string, value: string | null) => {
      if (value === null) delete facts[label]
      else facts[label] = value
    }
    fact("CVR", customer.registrationNumber)
    fact("Email", customer.email)
    fact("Phone", customer.phone)
    fact("Billing address", customer.billingAddress)
    fact("Payment terms", customer.paymentTermsDays === null ? null : paymentTermsLabel(customer.paymentTermsDays))
    facts.Consent = customer.serviceMessagesAllowed ? "Service messages" : "No service messages"
    return {
      id: webIdOf(prefix, customer.id),
      name: customer.name,
      context: customer.kind === "person" ? "Person · customer" : "Customer organisation",
      status: statusLabel(customer.status),
      facts,
      // A Customer is the company's (Issue #78), so it carries no project and shows in every scope.
      recordKind: "Contact or Customer Organization",
      submittedValues: {
        partyType: PARTY_TYPE_OF_KIND[customer.kind],
        displayName: customer.name,
        organizationId: customer.registrationNumber ?? "",
        email: customer.email ?? "",
        phone: customer.phone ?? "",
        billingAddress: customer.billingAddress ?? "",
        serviceMessagesAllowed: customer.serviceMessagesAllowed,
        paymentTermsDays: customer.paymentTermsDays === null ? "" : String(customer.paymentTermsDays),
      },
    }
  },
  toCreateBody: (record) => {
    const terms = typedPaymentTerms(record, "cleared")
    if (isLocalRefusal(terms)) return terms
    const fields = customerFields(record)
    if (fields.kind === undefined) return refusal("partyType", "Say whether this is a person or an organisation")
    if (!fields.name) return refusal("displayName", "A customer needs a name")
    const body: Record<string, unknown> = { kind: fields.kind, name: fields.name }
    // A create says a field only where the form gave one; the API's defaults do the rest.
    if (fields.registrationNumber) body.registrationNumber = fields.registrationNumber
    if (fields.email) body.email = fields.email
    if (fields.phone) body.phone = fields.phone
    if (fields.billingAddress) body.billingAddress = fields.billingAddress
    if (fields.serviceMessagesAllowed !== undefined) body.serviceMessagesAllowed = fields.serviceMessagesAllowed
    if (typeof fields.paymentTermsDays === "number") body.paymentTermsDays = fields.paymentTermsDays
    if (fields.status !== undefined && fields.status !== "active") body.status = fields.status
    return body
  },
  toPatchBody: (before, after) => {
    const terms = typedPaymentTerms(after, "cleared")
    if (isLocalRefusal(terms)) return terms
    return patchOf(before, after, customerFields)
  },
  create: (client, body) => create<Customer>(client, "/customers", body).then((created) => created.body),
  update: (client, serverId, body) => patch<Customer>(client, `/customers/${serverId}`, body),
  // Its Contact Persons (#291 C14), one at a time, and a message sent to it or to one of them (#291 C15): each answers another resource, so actions (records/customer-contacts.ts, records/messages.ts).
  actions: {
    [ADD_CONTACT]: ADD_CONTACT_ACTION,
    [EDIT_CONTACT]: EDIT_CONTACT_ACTION,
    [SEND_MESSAGE]: SEND_MESSAGE_ACTION,
  },
}

/** Customers → Contacts & Companies. */
export const customersModule = {
  ...moduleAt("customers.contacts"),
  resources: [customerAdapter],
} satisfies ServerModule
