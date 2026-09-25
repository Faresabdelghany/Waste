// The Registry's first switched module (Issue #81): the Customer as the
// `customers.contacts` module — the prototype's "Contacts & Companies", one
// wire resource for a person and an organisation alike
// (`@waste/contracts/customers`, `Customer`; apps/api/src/routes/customers.ts).
// A Customer is the company's and not a project's, so the record carries no
// project of its own and shows in every scope, which is what
// `isInProjectScope` does with a record that has none.
//
// The fixture ids the seed derived the demo customers from carry two
// prefixes — `contact-` for a person (`contact-mikkel`) and `company-` for
// an organisation (`company-osterbro-housing`) — and the workspace reads a
// party's kind off exactly that prefix (`business-workspace.tsx`,
// `getFormRelationOptions`: a `customerId` field offers `company-` records,
// a `…ContactId` field `contact-` ones), so a server customer takes the
// prefix of its kind, and a fixture is matched by name within the module.
//
// The form (`customers.contacts`) says more than the wire carries: a
// relationship role, a connected property and company, effective dates, a
// project scope. Those describe a `property_party` row (Issue #78) and land
// with the Properties module; here they stay on the record's typed values
// for the day that module is switched, and only the Customer's own fields
// travel. The status is the wire's two (`active`, `inactive`); the module's
// lifecycle also lists Merged and Archived, which the API has no column for,
// and a controlled action that moves a customer there is refused with the
// API's own 400.
import type { Customer } from "@waste/contracts/customers"

import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"

import { create, listAll, patch } from "../client"
import {
  fixtureNamed,
  inheritedPresentation,
  patchOf,
  stampFacts,
  statusLabel,
  statusToken,
  typed,
  typedFlag,
  webIdOf,
  type LocalRefusal,
  type ResourceAdapter,
  type ServerModule,
} from "./adapter"

const refusal = (path: string, message: string): LocalRefusal => ({ path, message })

/** The web id prefix of each kind: the fixtures' own two. */
export const CUSTOMER_PREFIXES = { person: "contact", organisation: "company" } as const

/** The form's `partyType` option for each wire kind, and back. */
const PARTY_TYPE_OF_KIND = { person: "person", organisation: "company" } as const
const KIND_OF_PARTY_TYPE: Readonly<Record<string, Customer["kind"]>> = { person: "person", company: "organisation", organisation: "organisation" }

/** The kind a customer record is, read off its typed party type first and its id prefix otherwise. */
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
    // The record's own status label is what the workspace shows and a
    // controlled action moves; the wire's two are what it may say.
    status: CUSTOMER_STATUSES.find((candidate) => candidate === statusToken(record.status)),
  }
}

/** The wire's customer statuses (`@waste/contracts/customers`, `CustomerStatus`); the module's lifecycle also lists Merged and Archived, which the API has no column for. */
const CUSTOMER_STATUSES: readonly Customer["status"][] = ["active", "inactive"]

export const customerAdapter: ResourceAdapter<Customer> = {
  prefix: "customer",
  // Both fixture prefixes, and nothing else the module could hold.
  owns: (record) => customerKindOf(record) !== undefined,
  list: (client) => listAll<Customer>(client, "/customers"),
  toRecord: (customer, context) => {
    const prefix = CUSTOMER_PREFIXES[customer.kind]
    const fixture = fixtureNamed(context.fixtures, prefix, [customer.name])
    const facts: Record<string, string> = { ...fixture?.facts, Kind: customer.kind === "person" ? "Person" : "Organisation" }
    const fact = (label: string, value: string | null) => {
      if (value === null) delete facts[label]
      else facts[label] = value
    }
    fact("CVR", customer.registrationNumber)
    fact("Email", customer.email)
    fact("Phone", customer.phone)
    fact("Billing address", customer.billingAddress)
    facts.Consent = customer.serviceMessagesAllowed ? "Service messages" : "No service messages"
    return {
      id: fixture?.id ?? webIdOf(prefix, customer.id),
      name: customer.name,
      context: fixture?.context ?? (customer.kind === "person" ? "Person · customer" : "Customer organisation"),
      status: statusLabel(customer.status),
      ...inheritedPresentation(fixture),
      ...stampFacts(customer, context.now),
      facts,
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      // A Customer is the company's (Issue #78), so it carries no project and
      // shows in every scope — whatever project the fixture happened to be
      // filed under.
      recordKind: "Contact or Customer Organization",
      submittedValues: {
        ...fixture?.submittedValues,
        partyType: PARTY_TYPE_OF_KIND[customer.kind],
        displayName: customer.name,
        organizationId: customer.registrationNumber ?? "",
        email: customer.email ?? "",
        phone: customer.phone ?? "",
        billingAddress: customer.billingAddress ?? "",
        serviceMessagesAllowed: customer.serviceMessagesAllowed,
      },
    }
  },
  toCreateBody: (record) => {
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
    if (fields.status !== undefined && fields.status !== "active") body.status = fields.status
    return body
  },
  toPatchBody: (before, after) => patchOf(before, after, customerFields),
  create: (client, body) => create<Customer>(client, "/customers", body).then((created) => created.body),
  update: (client, serverId, body) => patch<Customer>(client, `/customers/${serverId}`, body),
}

/** Customers → Contacts & Companies. */
export const customersModule: ServerModule = {
  workspaceId: "customers",
  moduleId: "contacts",
  resources: [customerAdapter],
}
