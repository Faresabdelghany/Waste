// A Customer's writes (Issue #78), the one spelling `POST /customers`,
// `PATCH /customers/:id` and the CSV import (#291 slice 12) all run, so an
// imported customer is written exactly as a registered one: the e-mail
// lowercased before the database sees it, a registration number one
// customer's inside the company in the route's own sentence. Each takes the
// request's transaction, or a savepoint of it, and the caller; the grant is
// the caller's to have checked. The finders are the keys a person knows a
// customer by — the registration number, which is unique, and the e-mail,
// which is not: a housing administrator's address serves many organisations.
import type { Customer, CustomerCreate, CustomerPatch } from "@waste/contracts/customers"
import type { CustomerKind } from "@waste/domain/registry/vocabulary"
import type { Tx } from "@waste/db/client"
import { customer, customerContact } from "@waste/db/schema/customers"
import { and, asc, count, eq } from "drizzle-orm"
import { newId } from "@waste/db/ids"
import { lockRow, refuseDuplicate } from "@waste/db/commands/shared"
import { stampsOf } from "@waste/db/shapes/times"

import type { Principal } from "../auth/principal"
import { problem } from "../problem"
import { scoped } from "../scoped"

export const customerColumns = {
  id: customer.id,
  kind: customer.kind,
  name: customer.name,
  registrationNumber: customer.registrationNumber,
  email: customer.email,
  phone: customer.phone,
  billingAddress: customer.billingAddress,
  serviceMessagesAllowed: customer.serviceMessagesAllowed,
  status: customer.status,
  paymentTermsDays: customer.paymentTermsDays,
  createdAt: customer.createdAt,
  updatedAt: customer.updatedAt,
}

export type CustomerRow = Pick<typeof customer.$inferSelect, keyof typeof customerColumns>

/** The row on the wire. `kind` and `status` are text with a CHECK in the database and an enum here; the vocabulary holds the two in lockstep. */
export function customerOf(row: CustomerRow): Customer {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    registrationNumber: row.registrationNumber,
    email: row.email,
    phone: row.phone,
    billingAddress: row.billingAddress,
    serviceMessagesAllowed: row.serviceMessagesAllowed,
    status: row.status,
    paymentTermsDays: row.paymentTermsDays,
    ...stampsOf(row),
  }
}

/** The partial unique index `(company_id, registration_number) where registration_number is not null`, which Postgres names as the constraint it refused with. */
const REGISTRATION_TAKEN = "customer_registration_number_idx"
const registrationTaken = (registrationNumber: string) =>
  `This company already has a customer with registration number ${registrationNumber}`

export const { noSuch: noSuchCustomer, get: getCustomer, list: listCustomers } = scoped(customer, { noun: "customer", reach: "company", columns: customerColumns })

const collisions = (registrationNumber: string | null | undefined): Record<string, string> =>
  registrationNumber == null ? {} : { [REGISTRATION_TAKEN]: registrationTaken(registrationNumber) }

/** The e-mail as it is stored: lowercase, so the address is written the way it is compared. */
const lowercased = <T extends { email?: string | null }>(values: T): T =>
  values.email == null ? values : { ...values, email: values.email.toLowerCase() }

export async function createCustomer(tx: Tx, principal: Principal, body: CustomerCreate): Promise<Customer> {
  const values = lowercased(body)
  const [row] = await refuseDuplicate(collisions(values.registrationNumber), () =>
    tx
      .insert(customer)
      .values({ ...values, id: newId(), companyId: principal.companyId })
      .returning(customerColumns),
  )
  return customerOf(row)
}

// Contact persons speak for an organisation (#291 C14): a person Customer is
// their own contact, so no active contact person stands under one. The rule
// has three doors, all judged here under the customer's lock, which each
// takes before it reads: a contact registered under a person, or made active
// again under one (routes/customer-contacts.ts, `refuseContactOfAPerson`),
// and an organisation made a person while a contact is active under it
// (`patchCustomer`). An inactive contact stays under the person it was left
// under, the history of who spoke for the organisation.

/** A contact registered, or made active, under a person customer. */
export const CONTACTS_ARE_AN_ORGANISATIONS = "Contact persons speak for an organisation; a person customer is their own contact"

/** An organisation that becomes a person while people still speak for it: they would be contacts of a customer who is their own. */
export const keepsActiveContacts = (contacts: number) =>
  `This organisation has ${contacts} active contact ${contacts === 1 ? "person" : "persons"}; make ${contacts === 1 ? "them" : "each"} inactive before it becomes a person, who is their own contact`

/** The customer a contact is written under, under its lock — taken before the contact's own — with the kind the rule reads; a 404 for one the company does not have. */
export async function lockedContactHolder(tx: Tx, principal: Principal, id: string): Promise<{ id: string; kind: CustomerKind }> {
  await lockRow(tx, customer, { companyId: principal.companyId, id })
  const [row] = await tx
    .select({ id: customer.id, kind: customer.kind })
    .from(customer)
    .where(and(eq(customer.companyId, principal.companyId), eq(customer.id, id)))
    .limit(1)
  if (row === undefined) throw noSuchCustomer(id)
  return row
}

/** The rule at a contact's write (409): no contact registered under a person, whatever its status, and none left active under one. */
export function refuseContactOfAPerson(holder: { kind: CustomerKind }, leavesActive = true): void {
  if (leavesActive && holder.kind !== "organisation") throw problem(409, { detail: CONTACTS_ARE_AN_ORGANISATIONS })
}

/** Changes one customer of the caller's company; a 404 for one it does not have. */
export async function patchCustomer(tx: Tx, principal: Principal, id: string, body: CustomerPatch): Promise<Customer> {
  const patch = lowercased(body)
  if (patch.kind === "person") {
    // Under the customer's lock, which a contact's every write takes too, so the count holds until the patch commits.
    await lockRow(tx, customer, { companyId: principal.companyId, id })
    const [{ active }] = await tx
      .select({ active: count() })
      .from(customerContact)
      .where(and(eq(customerContact.companyId, principal.companyId), eq(customerContact.customerId, id), eq(customerContact.status, "active")))
    if (active > 0) throw problem(409, { detail: keepsActiveContacts(active) })
  }
  const [row] = await refuseDuplicate(collisions(patch.registrationNumber), () =>
    tx
      .update(customer)
      .set(patch)
      .where(and(eq(customer.companyId, principal.companyId), eq(customer.id, id)))
      .returning(customerColumns),
  )
  if (row === undefined) throw noSuchCustomer(id)
  return customerOf(row)
}

/** The company's customers a key names: the one with this registration number, or every one with this e-mail, in creation order. */
export async function customersByKey(tx: Tx, companyId: string, key: { registrationNumber: string } | { email: string }): Promise<Customer[]> {
  const rows = await tx
    .select(customerColumns)
    .from(customer)
    .where(and(eq(customer.companyId, companyId), "registrationNumber" in key ? eq(customer.registrationNumber, key.registrationNumber) : eq(customer.email, key.email.toLowerCase())))
    .orderBy(asc(customer.id))
  return rows.map(customerOf)
}
