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
// The grant is `customers.contacts`, the surface's own. The writes are
// customer-writes.ts's, which the CSV import runs too.
import { Customer, CustomerCreate, CustomerPatch } from "@waste/contracts/customers"
import { Page, PageRequest } from "@waste/contracts/pagination"
import type { RouteDeps } from "../deps"
import { created, describeCreated, describeJson, IdParam, routes } from "../operation"
import { mapPage, pageAt } from "../pagination"
import { describeProblem } from "../problem"
import { createCustomer, customerOf, getCustomer, listCustomers, patchCustomer } from "./customer-writes"

const MODULE = "customers.contacts"
const CustomerPage = Page(Customer)

export function customerRoutes(deps: RouteDeps) {
  return routes(deps)
    .get(
      "/customers",
      {
        operationId: "listCustomers",
        summary: "The company's customers",
        description:
          "One page of the company's customers, people and organisations alike, oldest first (ids are time-ordered). Hand `nextCursor` back as `cursor` for the next page; `nextCursor` is null on the last one.",
        module: MODULE,
        action: "view",
        query: PageRequest,
        responses: {
          200: describeJson("One page of customers.", CustomerPage),
        },
      },
      async (c) => {
        const { limit, cursor } = c.req.valid("query")
        const at = pageAt({ cursor, limit })
        const page = await listCustomers(c.get("tx"), c.get("principal"), at)
        return c.json(mapPage(page, customerOf))
      },
    )
    .post(
      "/customers",
      {
        operationId: "createCustomer",
        summary: "Register a customer",
        description:
          "Registers a person or an organisation in the caller's company. Only the kind and the name are required: a sole trader has no registration number, and a customer who gave no phone number still has to be billable. The status defaults to `active` and service messages to allowed. A registration number, where given, is one customer's inside the company. The e-mail is stored lowercase. The server mints the id.",
        module: MODULE,
        action: "create",
        body: CustomerCreate,
        invalid: ["the body is missing a field, holds a value of the wrong shape, or names one the server owns"],
        responses: {
          201: describeCreated("The customer as it was written.", Customer),
          409: describeProblem("The company already has a customer with that registration number."),
        },
      },
      async (c) => created(c, "/customers", await createCustomer(c.get("tx"), c.get("principal"), c.req.valid("json"))),
    )
    .get(
      "/customers/:id",
      {
        operationId: "getCustomer",
        summary: "One customer",
        description: "One customer of the caller's company. Another company's customer is a customer that does not exist here.",
        module: MODULE,
        action: "view",
        params: IdParam,
        responses: {
          200: describeJson("The customer.", Customer),
          404: describeProblem("No customer with that id in this company."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await getCustomer(c.get("tx"), c.get("principal"), id)
        return c.json(customerOf(row))
      },
    )
    .patch(
      "/customers/:id",
      {
        operationId: "patchCustomer",
        summary: "Change a customer",
        description:
          "Changes one customer of the caller's company; every field is optional and at least one must be given. A null clears an optional field, and a new e-mail is stored lowercase like the first one.",
        module: MODULE,
        action: "edit",
        params: IdParam,
        body: CustomerPatch,
        invalid: ["the patch is empty, names a field the caller does not own, or holds a value of the wrong shape"],
        responses: {
          200: describeJson("The customer as it now stands.", Customer),
          404: describeProblem("No customer with that id in this company."),
          409: describeProblem("The company already has another customer with that registration number, or an organisation with active contact persons is made a person."),
        },
      },
      async (c) => c.json(await patchCustomer(c.get("tx"), c.get("principal"), c.req.valid("param").id, c.req.valid("json"))),
    )
}
