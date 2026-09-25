// Who is served (Issue #78): one record for a person and an organisation
// alike, which the prototype called "Contacts & Companies". `GET /customers`
// lists them, `POST /customers` registers one, `GET /customers/:id` reads one
// and `PATCH /customers/:id` changes one. There is no delete: a customer who
// has been served is behind properties, agreements and invoices, and
// `status: "inactive"` is what "remove a customer" means here.
//
// A Customer is the company's, not a project's — the same housing
// administrator is a customer of every project the company runs — so the
// scope is the tenant alone and there is no `inProjects` here. Where a
// customer is served is the Property's business, and a party row says what
// they are to it.
//
// Everything but the kind, the name and the status is optional: a sole trader
// has no registration number, and a customer who never gave a phone number
// still has to be billable. The registration number, where there is one, is
// one customer's inside the company — a partial unique index, since most rows
// have none and a null is not a duplicate of another null, so Postgres names
// the index and not a constraint when it refuses one (`refuseDuplicate` reads
// whichever name it gives). The e-mail is lowercased here, before the
// database sees it, the way an invitation's is (users.ts): the column's check
// is the backstop, not the rule. It is not unique — a housing
// administrator's address serves many organisations.
//
// The grant is `customers.contacts`, the surface's own.
import { Customer, CustomerCreate, CustomerPatch, type CustomerKind, type CustomerStatus } from "@waste/contracts/customers"
import { Page, PageRequest } from "@waste/contracts/pagination"
import { customer } from "@waste/db/schema/customers"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { created, describeCreated, describeJson, IdParam, refuseDuplicate, stampsOf } from "./shared"

const MODULE = "customers.contacts"
const CustomerPage = Page(Customer)

const columns = {
  id: customer.id,
  kind: customer.kind,
  name: customer.name,
  registrationNumber: customer.registrationNumber,
  email: customer.email,
  phone: customer.phone,
  billingAddress: customer.billingAddress,
  serviceMessagesAllowed: customer.serviceMessagesAllowed,
  status: customer.status,
  createdAt: customer.createdAt,
  updatedAt: customer.updatedAt,
}

type Row = Pick<typeof customer.$inferSelect, keyof typeof columns>

/** The row on the wire. `kind` and `status` are text with a CHECK in the database and an enum here; the vocabulary holds the two in lockstep. */
function customerOf(row: Row): Customer {
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
    ...stampsOf(row),
  }
}

/** The partial unique index `(company_id, registration_number) where registration_number is not null`, which Postgres names as the constraint it refused with. */
const REGISTRATION_TAKEN = "customer_registration_number_idx"
const registrationTaken = (registrationNumber: string) =>
  `This company already has a customer with registration number ${registrationNumber}`

const noSuchCustomer = (id: string) => problem(404, { detail: `No customer ${id} in this company` })

/** The one sentence a collision here can earn, and only when the body gave a number to collide on. */
const collisions = (registrationNumber: string | null | undefined): Record<string, string> =>
  registrationNumber == null ? {} : { [REGISTRATION_TAKEN]: registrationTaken(registrationNumber) }

/** The e-mail as it is stored: lowercase, so the address is written the way it is compared. */
const lowercased = <T extends { email?: string | null }>(values: T): T =>
  values.email == null ? values : { ...values, email: values.email.toLowerCase() }

export function customerRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/customers",
      describeRoute({
        operationId: "listCustomers",
        summary: "The company's customers",
        description:
          "One page of the company's customers, people and organisations alike, oldest first (ids are time-ordered). Hand `nextCursor` back as `cursor` for the next page; `nextCursor` is null on the last one.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of customers.", CustomerPage),
          400: describeProblem("The page size is outside 1..200, or the cursor is not one this API wrote."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `customers.contacts`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", PageRequest),
      async (c) => {
        const { limit, cursor } = c.req.valid("query")
        const after = afterCursor(cursor)
        const rows = await c
          .get("tx")
          .select(columns)
          .from(customer)
          .where(and(eq(customer.companyId, c.get("principal").companyId), after === undefined ? undefined : gt(customer.id, after)))
          .orderBy(asc(customer.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(customerOf), limit))
      },
    )
    .post(
      "/customers",
      describeRoute({
        operationId: "createCustomer",
        summary: "Register a customer",
        description:
          "Registers a person or an organisation in the caller's company. Only the kind and the name are required: a sole trader has no registration number, and a customer who gave no phone number still has to be billable. The status defaults to `active` and service messages to allowed. A registration number, where given, is one customer's inside the company. The e-mail is stored lowercase. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The customer as it was written.", Customer),
          400: describeProblem("The body is missing a field, holds a value of the wrong shape, or names one the server owns."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `customers.contacts`."),
          409: describeProblem("The company already has a customer with that registration number."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", CustomerCreate),
      async (c) => {
        const values = lowercased(c.req.valid("json"))
        const [row] = await refuseDuplicate(collisions(values.registrationNumber), () =>
          c
            .get("tx")
            .insert(customer)
            .values({ ...values, id: newId(), companyId: c.get("principal").companyId })
            .returning(columns),
        )
        return created(c, "/customers", customerOf(row))
      },
    )
    .get(
      "/customers/:id",
      describeRoute({
        operationId: "getCustomer",
        summary: "One customer",
        description: "One customer of the caller's company. Another company's customer is a customer that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The customer.", Customer),
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
        const [row] = await c
          .get("tx")
          .select(columns)
          .from(customer)
          .where(and(eq(customer.companyId, c.get("principal").companyId), eq(customer.id, id)))
          .limit(1)
        if (row === undefined) throw noSuchCustomer(id)
        return c.json(customerOf(row))
      },
    )
    .patch(
      "/customers/:id",
      describeRoute({
        operationId: "patchCustomer",
        summary: "Change a customer",
        description:
          "Changes one customer of the caller's company; every field is optional and at least one must be given. A null clears an optional field, and a new e-mail is stored lowercase like the first one.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The customer as it now stands.", Customer),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a field the caller does not own, or holds a value of the wrong shape."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `customers.contacts`."),
          404: describeProblem("No customer with that id in this company."),
          409: describeProblem("The company already has another customer with that registration number."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", CustomerPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = lowercased(c.req.valid("json"))
        const [row] = await refuseDuplicate(collisions(patch.registrationNumber), () =>
          c
            .get("tx")
            .update(customer)
            .set(patch)
            .where(and(eq(customer.companyId, c.get("principal").companyId), eq(customer.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchCustomer(id)
        return c.json(customerOf(row))
      },
    )
}
