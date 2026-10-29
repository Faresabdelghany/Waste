// A Customer's Contact Persons (#291 C14): the named people who speak for an
// organisation Customer, each with a role and the channels they are reached
// on, which messaging (C15) addresses. `GET /customers/:id/contacts` lists a
// customer's, every one, `POST /customers/:id/contacts` registers one, and
// `GET`/`PATCH /customer-contacts/:id` read and change one. There is no
// delete: a contact who has left is made `inactive`, since a message sent to
// them stays on its ledger naming them.
//
// The rules: contact persons are an organisation's, a person Customer being
// their own contact (a 409 on the customer's state, under its lock, which a
// customer's kind change takes too — customer-writes.ts); a contact is reached
// on an e-mail or a phone at least, which the create body holds and a patch is
// held to against the stored row (a 400 at `email`), with the table's check as
// the backstop; and the e-mail is stored lowercase, as a customer's is.
//
// A Customer is the company's, so the scope is the tenant alone. The grant is
// the customer's own module, `customers.contacts`: `view` to read, `edit` for
// every write, since a contact is part of the customer it speaks for.
import { CustomerContact, CustomerContactCreate, CustomerContactPatch, CustomerContacts, REACHABLE_ON_A_CHANNEL, type ContactRole, type ContactStatus } from "@waste/contracts/customers"
import type { Tx } from "@waste/db/client"
import { customer, customerContact } from "@waste/db/schema/customers"
import { and, asc, eq } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { noSuchCustomer } from "./customer-writes"
import { created, describeCreated, describeJson, IdParam, lockRow, refuseCheck, stampsOf } from "./shared"

const MODULE = "customers.contacts"

/** A person Customer is their own contact: contact persons are an organisation's. */
export const CONTACTS_ARE_AN_ORGANISATIONS = "Contact persons speak for an organisation; a person customer is their own contact"

const noSuchContact = (id: string) => problem(404, { detail: `No contact person ${id} in this company` })

const columns = {
  id: customerContact.id,
  customerId: customerContact.customerId,
  name: customerContact.name,
  role: customerContact.role,
  email: customerContact.email,
  phone: customerContact.phone,
  status: customerContact.status,
  createdAt: customerContact.createdAt,
  updatedAt: customerContact.updatedAt,
}

type Row = Pick<typeof customerContact.$inferSelect, keyof typeof columns>

/** The row on the wire; `role` and `status` are text with a CHECK over the same tuples the contract's enums read. */
export const contactOf = (row: Row): CustomerContact => ({
  id: row.id,
  customerId: row.customerId,
  name: row.name,
  role: row.role as ContactRole,
  email: row.email,
  phone: row.phone,
  status: row.status as ContactStatus,
  ...stampsOf(row),
})

/** The table's check, the backstop under the body's and the patch's rule. */
const UNREACHABLE = { customer_contact_channel_shape: { path: "email", message: REACHABLE_ON_A_CHANNEL } }

const lowercased = <T extends { email?: string | null }>(values: T): T => (values.email == null ? values : { ...values, email: values.email.toLowerCase() })

/** The customer a contact is written under, locked, with the kind its rule reads; a 404 for one the company does not have. */
async function lockedCustomer(tx: Tx, principal: Principal, id: string): Promise<{ id: string; kind: string }> {
  await lockRow(tx, customer, { companyId: principal.companyId, id })
  const [row] = await tx
    .select({ id: customer.id, kind: customer.kind })
    .from(customer)
    .where(and(eq(customer.companyId, principal.companyId), eq(customer.id, id)))
    .limit(1)
  if (row === undefined) throw noSuchCustomer(id)
  return row
}

async function findContact(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(customerContact)
    .where(and(eq(customerContact.companyId, principal.companyId), eq(customerContact.id, id)))
    .limit(1)
  return row
}

/** A customer's contacts, every one, oldest first. */
export async function contactsOf(tx: Tx, companyId: string, customerId: string): Promise<CustomerContact[]> {
  const rows = await tx
    .select(columns)
    .from(customerContact)
    .where(and(eq(customerContact.companyId, companyId), eq(customerContact.customerId, customerId)))
    .orderBy(asc(customerContact.id))
  return rows.map(contactOf)
}

export function customerContactRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/customers/:id/contacts",
      describeRoute({
        operationId: "listCustomerContacts",
        summary: "A customer's contact persons",
        description: "Every contact person of one customer, active and inactive alike, oldest first: an organisation has a handful, never a page's worth. A person customer has none.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The customer's contact persons.", CustomerContacts),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `customers.contacts`."),
          404: describeProblem("No customer with that id in this company."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const { companyId } = c.get("principal")
        const [found] = await tx.select({ id: customer.id }).from(customer).where(and(eq(customer.companyId, companyId), eq(customer.id, id))).limit(1)
        if (found === undefined) throw noSuchCustomer(id)
        return c.json({ items: await contactsOf(tx, companyId, id) })
      },
    )
    .post(
      "/customers/:id/contacts",
      describeRoute({
        operationId: "createCustomerContact",
        summary: "Register a contact person under a customer",
        description:
          "Registers a named person who speaks for an organisation customer, with a role and an e-mail or a phone or both. The status defaults to `active`, and the e-mail is stored lowercase. A person customer is their own contact and takes none. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The contact person as it was written.", CustomerContact),
          400: describeProblem("The path does not hold an id, or the body is missing a field, gives neither an e-mail nor a phone, holds a value of the wrong shape, or names one the server owns."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `customers.contacts`."),
          404: describeProblem("No customer with that id in this company."),
          409: describeProblem("The customer is a person, who is their own contact."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", CustomerContactCreate),
      async (c) => {
        const tx = c.get("tx")
        const principal = c.get("principal")
        const parent = await lockedCustomer(tx, principal, c.req.valid("param").id)
        if (parent.kind !== "organisation") throw problem(409, { detail: CONTACTS_ARE_AN_ORGANISATIONS })
        const [row] = await refuseCheck(UNREACHABLE, () =>
          tx
            .insert(customerContact)
            .values({ ...lowercased(c.req.valid("json")), id: newId(), companyId: principal.companyId, customerId: parent.id })
            .returning(columns),
        )
        return created(c, "/customer-contacts", contactOf(row))
      },
    )
    .get(
      "/customer-contacts/:id",
      describeRoute({
        operationId: "getCustomerContact",
        summary: "One contact person",
        description: "One contact person of a customer of the caller's company.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The contact person.", CustomerContact),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `customers.contacts`."),
          404: describeProblem("No contact person with that id in this company."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findContact(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchContact(id)
        return c.json(contactOf(row))
      },
    )
    .patch(
      "/customer-contacts/:id",
      describeRoute({
        operationId: "patchCustomerContact",
        summary: "Change a contact person",
        description:
          "Changes one contact person; every field is optional and at least one must be given. A null clears a channel, so long as the other is left; `status: inactive` is how a contact who has left is retired, since none is ever deleted.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The contact person as it now stands.", CustomerContact),
          400: describeProblem("The path does not hold an id, or the patch is empty, would leave the contact with neither an e-mail nor a phone, names a field the caller does not own, or holds a value of the wrong shape."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `customers.contacts`."),
          404: describeProblem("No contact person with that id in this company."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", CustomerContactPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const found = await findContact(tx, principal, id)
        if (found === undefined) throw noSuchContact(id)
        // The customer's lock first, parent before child, as a create takes it.
        await lockRow(tx, customer, { companyId: principal.companyId, id: found.customerId })
        await lockRow(tx, customerContact, { companyId: principal.companyId, id })
        const current = await findContact(tx, principal, id)
        if (current === undefined) throw noSuchContact(id)
        const patch = lowercased(c.req.valid("json"))
        const email = patch.email === undefined ? current.email : patch.email
        const phone = patch.phone === undefined ? current.phone : patch.phone
        if (email === null && phone === null) throw invalidRequest("body", [{ path: patch.email === undefined ? "phone" : "email", message: REACHABLE_ON_A_CHANNEL }])
        const [row] = await refuseCheck(UNREACHABLE, () =>
          tx
            .update(customerContact)
            .set(patch)
            .where(and(eq(customerContact.companyId, principal.companyId), eq(customerContact.id, id)))
            .returning(columns),
        )
        return c.json(contactOf(row))
      },
    )
}
