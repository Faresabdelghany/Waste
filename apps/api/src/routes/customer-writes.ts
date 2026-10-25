// A Customer's writes (Issue #78), the one spelling `POST /customers`,
// `PATCH /customers/:id` and the CSV import (#291 slice 12) all run, so an
// imported customer is written exactly as a registered one: the e-mail
// lowercased before the database sees it, a registration number one
// customer's inside the company in the route's own sentence. Each takes the
// request's transaction, or a savepoint of it, and the caller; the grant is
// the caller's to have checked. The finders are the keys a person knows a
// customer by — the registration number, which is unique, and the e-mail,
// which is not: a housing administrator's address serves many organisations.
import type { Customer, CustomerCreate, CustomerKind, CustomerPatch, CustomerStatus } from "@waste/contracts/customers"
import type { Tx } from "@waste/db/client"
import { customer } from "@waste/db/schema/customers"
import { and, asc, eq } from "drizzle-orm"

import type { Principal } from "../auth/principal"
import { newId } from "../ids"
import { problem } from "../problem"
import { refuseDuplicate, stampsOf } from "./shared"

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
    kind: row.kind as CustomerKind,
    name: row.name,
    registrationNumber: row.registrationNumber,
    email: row.email,
    phone: row.phone,
    billingAddress: row.billingAddress,
    serviceMessagesAllowed: row.serviceMessagesAllowed,
    status: row.status as CustomerStatus,
    paymentTermsDays: row.paymentTermsDays,
    ...stampsOf(row),
  }
}

/** The partial unique index `(company_id, registration_number) where registration_number is not null`, which Postgres names as the constraint it refused with. */
const REGISTRATION_TAKEN = "customer_registration_number_idx"
const registrationTaken = (registrationNumber: string) =>
  `This company already has a customer with registration number ${registrationNumber}`

export const noSuchCustomer = (id: string) => problem(404, { detail: `No customer ${id} in this company` })

/** The one sentence a collision here can earn, and only when the body gave a number to collide on. */
const collisions = (registrationNumber: string | null | undefined): Record<string, string> =>
  registrationNumber == null ? {} : { [REGISTRATION_TAKEN]: registrationTaken(registrationNumber) }

/** The e-mail as it is stored: lowercase, so the address is written the way it is compared. */
const lowercased = <T extends { email?: string | null }>(values: T): T =>
  values.email == null ? values : { ...values, email: values.email.toLowerCase() }

/** Registers a customer in the caller's company. */
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

/** Changes one customer of the caller's company; a 404 for one it does not have. */
export async function patchCustomer(tx: Tx, principal: Principal, id: string, body: CustomerPatch): Promise<Customer> {
  const patch = lowercased(body)
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
