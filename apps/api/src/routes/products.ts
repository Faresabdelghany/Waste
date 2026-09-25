// What a customer subscribes to (Issue #78): a container collection, a
// recurring service or an additional service, offered inside one project.
// `GET /products` lists them, `POST /products` adds one, `GET /products/:id`
// reads one and `PATCH /products/:id` changes one. No delete: a product a
// Subscription named is quoted by a row that outlives it, and taking one out
// of the catalogue is `status: "inactive"`.
//
// Prices are not here. A Price List, its rows and a product's invoice name,
// code and VAT are Finance & Contracting's, and the Registry's job is to say
// what the thing is, not what it costs.
//
// A Product is project-scoped, so every statement carries the tenant and
// `inProjects` (auth/projects.ts): a caller reads the products of the
// projects it works in, a create names one of those in the body (400 on
// `projectId`), and the project is not patchable — a record does not move
// between projects.
//
// What a product points at is checked before the insert, each against the
// scope the key allows (routes/references.ts): a container type and a waste
// fraction are the company's, and a service frequency is the *project's*,
// since a cadence belongs to one project (`project_id` leads its key). All
// three are optional — only a container collection has a container and a
// fraction, and the frequency is a default a placement may override — so a
// null or an absent field is nothing to check.
//
// The grant is the Price Engine's own, `commercial.products`: the master data
// a product points at is `configure.master`'s, written through the catalogue
// routes, and nothing here widens that.
import { Product, ProductCreate, ProductPatch, type ProductKind, type ProductStatus, type ProductUnit } from "@waste/contracts/catalogue"
import { Page } from "@waste/contracts/pagination"
import { ProjectScopedListQuery } from "@waste/contracts/queries"
import type { Tx } from "@waste/db/client"
import { product } from "@waste/db/schema/catalogue"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { requireContainerType, requireServiceFrequency, requireWasteFraction } from "./references"
import { created, describeCreated, describeJson, IdParam, refuseDuplicate, stampsOf } from "./shared"

const MODULE = "commercial.products"
const ProductPage = Page(Product)

const columns = {
  id: product.id,
  projectId: product.projectId,
  name: product.name,
  kind: product.kind,
  status: product.status,
  unit: product.unit,
  containerTypeId: product.containerTypeId,
  wasteFractionId: product.wasteFractionId,
  serviceFrequencyId: product.serviceFrequencyId,
  // The invoicing fields Finance gave the product (Issue #112): read here; the create and the patch hold them from slice 3 on.
  invoiceName: product.invoiceName,
  invoiceCode: product.invoiceCode,
  vatPercent: product.vatPercent,
  createdAt: product.createdAt,
  updatedAt: product.updatedAt,
}

type Row = Pick<typeof product.$inferSelect, keyof typeof columns>

/** The row on the wire. The three coded fields are text with a CHECK in the database and an enum here; the vocabulary holds the two in lockstep. */
function productOf(row: Row): Product {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    kind: row.kind as ProductKind,
    status: row.status as ProductStatus,
    unit: row.unit as ProductUnit,
    containerTypeId: row.containerTypeId,
    wasteFractionId: row.wasteFractionId,
    serviceFrequencyId: row.serviceFrequencyId,
    invoiceName: row.invoiceName,
    invoiceCode: row.invoiceCode,
    vatPercent: row.vatPercent,
    ...stampsOf(row),
  }
}

/** `unique (company_id, project_id, name)`: a product's name is one product's inside a project, and free in the next. */
const NAME_TAKEN = "product_project_id_name_key"
const nameTaken = (name: string) => `This project already has a product called ${JSON.stringify(name)}`

/** `unique (company_id, project_id, invoice_code) where invoice_code is not null` (Issue #112): the code an external ledger books the product under is one product's inside a project. */
const INVOICE_CODE_TAKEN = "product_invoice_code_idx"
export const invoiceCodeTaken = (code: string) => `This project already has a product with invoice code ${code}`

/** The unique constraints a write can meet, each with its sentence; the invoice code's only when the body carries one. */
const collisions = (values: { name?: string; invoiceCode?: string | null }): Record<string, string> => ({
  ...(values.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(values.name) }),
  ...(values.invoiceCode == null ? {} : { [INVOICE_CODE_TAKEN]: invoiceCodeTaken(values.invoiceCode) }),
})

const noSuchProduct = (id: string) => problem(404, { detail: `No product ${id} in the projects this account works in` })

/** The rows of this company, in the projects the caller works in: what every product statement is bounded by. */
const scope = (principal: Principal) => and(eq(product.companyId, principal.companyId), inProjects(product.projectId, principal))

/** What the body points at, held to this company and this project. A null or an absent field points at nothing. */
type References = { containerTypeId?: string | null; wasteFractionId?: string | null; serviceFrequencyId?: string | null }

/** The three ids a product may name, each held to the scope its key allows (routes/references.ts). */
async function requireReferences(tx: Tx, within: { companyId: string; projectId: string }, values: References): Promise<void> {
  await requireContainerType(tx, within.companyId, values.containerTypeId)
  await requireWasteFraction(tx, within.companyId, values.wasteFractionId)
  await requireServiceFrequency(tx, within, values.serviceFrequencyId)
}

/** One product of this company by id, inside the caller's projects; undefined when it is neither. */
async function findProduct(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(product)
    .where(and(scope(principal), eq(product.id, id)))
    .limit(1)
  return row
}

export function productRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/products",
      describeRoute({
        operationId: "listProducts",
        summary: "The products the caller's projects offer",
        description:
          "One page of products, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of products.", ProductPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `commercial.products`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", ProjectScopedListQuery),
      async (c) => {
        const { limit, cursor, projectId } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await c
          .get("tx")
          .select(columns)
          .from(product)
          .where(
            and(
              scope(principal),
              projectId === undefined ? undefined : eq(product.projectId, projectId),
              after === undefined ? undefined : gt(product.id, after),
            ),
          )
          .orderBy(asc(product.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(productOf), limit))
      },
    )
    .post(
      "/products",
      describeRoute({
        operationId: "createProduct",
        summary: "Add a product",
        description:
          "Adds a product to one project, which must be a project the caller works in. The name is unique inside the project and the status defaults to `draft`. The container type and the waste fraction, where given, must be this company's, and the service frequency must be one of the named project's; all three are optional, since only a container collection has a container and a fraction and the cadence is a default a placement may override. The three invoicing fields are Finance's (Issue #112) and optional: `invoiceName` is what an invoice line calls the product (its name when null), `invoiceCode` the code an external ledger books it under, one product's inside the project (409, `This project already has a product with invoice code 4010`), and `vatPercent` the rate a billable event is priced at, a whole percent from 0 (exempt) to 100 — a product without one blocks its events with `no-vat-rate`. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The product as it was written.", Product),
          400: describeProblem(
            "The body is missing a field, names a member the server owns, names a project this account does not work in, gives a VAT rate outside 0..100, or points at a container type, waste fraction or service frequency that is not this company's or this project's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `commercial.products`."),
          409: describeProblem("The project already has a product with that name, or one with that invoice code."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", ProductCreate),
      async (c) => {
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        await requireReferences(tx, { companyId: principal.companyId, projectId: values.projectId }, values)
        const [row] = await refuseDuplicate(collisions(values), () =>
          tx
            .insert(product)
            .values({ ...values, id: newId(), companyId: principal.companyId })
            .returning(columns),
        )
        return created(c, "/products", productOf(row))
      },
    )
    .get(
      "/products/:id",
      describeRoute({
        operationId: "getProduct",
        summary: "One product",
        description:
          "One product of a project the caller works in. A product of another company, or of a project this account does not work in, is a product that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The product.", Product),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `commercial.products`."),
          404: describeProblem("No product with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findProduct(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchProduct(id)
        return c.json(productOf(row))
      },
    )
    .patch(
      "/products/:id",
      describeRoute({
        operationId: "patchProduct",
        summary: "Change a product",
        description:
          "Changes one product of a project the caller works in; every field is optional and at least one must be given. What the patch points at is held to the stored row's project, not to a project the body names: the project is not patchable, since a record does not move between projects. A null clears a reference, and clears an invoice name, an invoice code or a VAT rate too (Issue #112); the invoice code stays one product's inside the project (409, `This project already has a product with invoice code 4010`). A VAT rate changed here prices the events recorded from then on and moves none already priced.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The product as it now stands.", Product),
          400: describeProblem(
            "The path does not hold an id, or the patch is empty, names a field the caller does not own (the project included), gives a VAT rate outside 0..100, or points at a container type, waste fraction or service frequency that is not this company's or this product's project's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `commercial.products`."),
          404: describeProblem("No product with that id in the projects this account works in."),
          409: describeProblem("The project already has another product with that name, or another with that invoice code."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ProductPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        const current = await findProduct(tx, principal, id)
        if (current === undefined) throw noSuchProduct(id)
        await requireReferences(tx, { companyId: principal.companyId, projectId: current.projectId }, patch)

        const [row] = await refuseDuplicate(collisions(patch), () =>
          tx
            .update(product)
            .set(patch)
            .where(and(scope(principal), eq(product.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchProduct(id)
        return c.json(productOf(row))
      },
    )
}
