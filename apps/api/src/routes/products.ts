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
// scope the key allows: a container type and a waste fraction are the
// company's, and a service frequency is the *project's*, since a cadence
// belongs to one project (`project_id` leads its key). All three are
// optional — only a container collection has a container and a fraction, and
// the frequency is a default a placement may override — so a null or an
// absent field is nothing to check. The foreign keys are the backstop; they
// would answer 23503, which is a 500 saying nothing, where a 400 naming the
// field says which id to fix. And since the fence hides another company's
// row, "it is not yours" and "it does not exist" are the same sentence here.
//
// The grant is the Price Engine's own, `commercial.products`: the master data
// a product points at is `configure.master`'s, written through the catalogue
// routes, and nothing here widens that.
import { Product, ProductCreate, ProductPatch, type ProductKind, type ProductStatus, type ProductUnit } from "@waste/contracts/catalogue"
import { Page } from "@waste/contracts/pagination"
import { ProjectScopedListQuery } from "@waste/contracts/queries"
import type { Tx } from "@waste/db/client"
import { containerType, product, serviceFrequency, wasteFraction } from "@waste/db/schema/catalogue"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { describeJson, IdParam, refuseDuplicate, requireRow, stampsOf } from "./shared"

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
    ...stampsOf(row),
  }
}

/** `unique (company_id, project_id, name)`: a product's name is one product's inside a project, and free in the next. */
const NAME_TAKEN = "product_project_id_name_key"
const nameTaken = (name: string) => `This project already has a product called ${JSON.stringify(name)}`

const noSuchProduct = (id: string) => problem(404, { detail: `No product ${id} in the projects this account works in` })

/** The rows of this company, in the projects the caller works in: what every product statement is bounded by. */
const scope = (principal: Principal) => and(eq(product.companyId, principal.companyId), inProjects(product.projectId, principal))

/** What the body points at, held to this company and this project. A null or an absent field points at nothing. */
type References = { containerTypeId?: string | null; wasteFractionId?: string | null; serviceFrequencyId?: string | null }

/**
 * The three ids a product may name, each held to the scope its key allows:
 * the container type and the waste fraction to the company, the cadence to
 * the project as well, since a service frequency belongs to one project. The
 * sentences are here because they name the thing; the lookup is
 * `requireRow`'s (routes/shared.ts).
 */
async function requireReferences(tx: Tx, companyId: string, projectId: string, values: References): Promise<void> {
  if (values.containerTypeId != null) {
    await requireRow(tx, containerType, { companyId, id: values.containerTypeId }, {
      path: "containerTypeId",
      message: "Not a container type of this company",
    })
  }
  if (values.wasteFractionId != null) {
    await requireRow(tx, wasteFraction, { companyId, id: values.wasteFractionId }, {
      path: "wasteFractionId",
      message: "Not a waste fraction of this company",
    })
  }
  if (values.serviceFrequencyId != null) {
    await requireRow(
      tx,
      serviceFrequency,
      { companyId, id: values.serviceFrequencyId, also: eq(serviceFrequency.projectId, projectId) },
      { path: "serviceFrequencyId", message: "Not a service frequency of this project" },
    )
  }
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
          "Adds a product to one project, which must be a project the caller works in. The name is unique inside the project and the status defaults to `draft`. The container type and the waste fraction, where given, must be this company's, and the service frequency must be one of the named project's; all three are optional, since only a container collection has a container and a fraction and the cadence is a default a placement may override. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The product as it was written.", Product),
          400: describeProblem(
            "The body is missing a field, names a member the server owns, names a project this account does not work in, or points at a container type, waste fraction or service frequency that is not this company's or this project's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `commercial.products`."),
          409: describeProblem("The project already has a product with that name."),
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
        await requireReferences(tx, principal.companyId, values.projectId, values)
        const [row] = await refuseDuplicate({ [NAME_TAKEN]: nameTaken(values.name) }, () =>
          tx
            .insert(product)
            .values({ ...values, id: newId(), companyId: principal.companyId })
            .returning(columns),
        )
        return c.json(productOf(row), 201)
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
          "Changes one product of a project the caller works in; every field is optional and at least one must be given. What the patch points at is held to the stored row's project, not to a project the body names: the project is not patchable, since a record does not move between projects. A null clears a reference.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The product as it now stands.", Product),
          400: describeProblem(
            "The path does not hold an id, or the patch is empty, names a field the caller does not own (the project included), or points at a container type, waste fraction or service frequency that is not this company's or this product's project's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `commercial.products`."),
          404: describeProblem("No product with that id in the projects this account works in."),
          409: describeProblem("The project already has another product with that name."),
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
        await requireReferences(tx, principal.companyId, current.projectId, patch)

        const sentences: Record<string, string> = patch.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(patch.name) }
        const [row] = await refuseDuplicate(sentences, () =>
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
