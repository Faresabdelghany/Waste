// Where service is delivered (Issue #78): the service address, who its
// customers are, and the point it stands on. `GET /properties` lists them,
// `POST /properties` registers one, `GET /properties/:id` reads one,
// `PATCH /properties/:id` changes one and `PUT /properties/:id/parties`
// replaces who its customers are. No delete: a property that has been served
// is behind containers, agreements and collections, and `status: "inactive"`
// is what "remove a property" means here.
//
// A Property is project-scoped, so every statement carries the tenant and
// `inProjects` (auth/projects.ts): a caller reads the properties of the
// projects it works in, a create names one of those in the body (400 on
// `projectId`), and the project is not patchable — a record does not move
// between projects.
//
// The parties are the set that travels with the record (routes/members.ts):
// a create may carry the list it starts with, so the form that registers a
// property with its owner is one request; a patch never touches it, because
// a patch is a field-by-field change and a membership is a set; and the PUT
// replaces it whole. A party names a Customer of this company and not of the
// project — the same housing administrator is a customer of every project —
// and the check runs before the write, as a 400 at
// `parties.N.customerId` rather than a 23503 that says nothing.
//
// `location` is the first point this system stores rather than derives. It
// goes in and comes back as GeoJSON (@waste/db/schema/geometry), and it is
// nullable because a property is registered before it is geocoded. A point
// off the globe is refused by the contracts, naming the ordinate, before the
// database is asked and long before its `st_xmin` check would answer 23514.
//
// `?customerId=` is the citizen portal's side of this resource: the
// properties a person may see are the properties a `property_party` row
// names them on, in any role, and the filter is that read model. It is one
// `exists` over the party rows, so a property with two roles for the same
// customer is one row of the page and not two.
//
// The grant is `customers.properties`, the surface's own; a Customer is
// `customers.contacts`'s and nothing here widens that.
import {
  Property,
  PropertyCreate,
  PropertyListQuery,
  PropertyPartiesSet,
  PropertyPatch,
  type PropertyKind,
  type PropertyParty,
  type PropertyPartyRole,
  type PropertyStatus,
} from "@waste/contracts/customers"
import type { FlatPoint } from "@waste/contracts/geojson"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { property, propertyParty } from "@waste/db/schema/customers"
import { and, asc, eq, exists, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import {
  entriesFor,
  entriesOf,
  replaceSet,
  requirePartyCustomers,
  writeEntries,
  type Entry,
  type MemberSet,
  type Parent,
} from "./members"
import { created, describeCreated, describeJson, IdParam, refuseDuplicate, stampsOf } from "./shared"

const MODULE = "customers.properties"
const PropertyPage = Page(Property)

const columns = {
  id: property.id,
  projectId: property.projectId,
  name: property.name,
  address: property.address,
  registryId: property.registryId,
  kind: property.kind,
  location: property.location,
  notes: property.notes,
  status: property.status,
  createdAt: property.createdAt,
  updatedAt: property.updatedAt,
}

type Row = Pick<typeof property.$inferSelect, keyof typeof columns>

/** The parties of a Property: a Customer of this company, and what it is to the property. */
const parties: MemberSet<typeof propertyParty> = {
  table: propertyParty,
  parentId: propertyParty.propertyId,
  entryId: propertyParty.customerId,
  rowOf: (entry, parent) => ({
    id: newId(),
    companyId: parent.companyId,
    projectId: parent.projectId,
    propertyId: parent.id,
    customerId: entry.id,
    role: entry.role,
  }),
  require: requirePartyCustomers,
}

/** The two spellings of one party: the wire's, and the set mechanics' (routes/members.ts). */
const partyOf = (entry: Entry): PropertyParty => ({ customerId: entry.id, role: entry.role as PropertyPartyRole })
const entryOf = (party: PropertyParty): Entry => ({ id: party.customerId, role: party.role })

/** The row on the wire, with the parties the page loaded for it. `kind` and `status` are text with a CHECK in the database and an enum here; the point is the contracts' `FlatPoint`, since the column is `geometry(Point, 4326)`, flat, and refuses a third ordinate on write, however the column's type spells the altitude as optional. */
function propertyOf(row: Row, held: readonly Entry[]): Property {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    address: row.address,
    registryId: row.registryId,
    kind: row.kind as PropertyKind,
    location: row.location as FlatPoint | null,
    notes: row.notes,
    status: row.status as PropertyStatus,
    parties: held.map(partyOf),
    ...stampsOf(row),
  }
}

/** One property on the wire, its parties read back the way a page reads them, so an answer equals the next read. */
async function propertyWithParties(tx: Tx, companyId: string, row: Row): Promise<Property> {
  return propertyOf(row, await entriesFor(tx, parties, companyId, row.id))
}

/** `unique (company_id, project_id, name)`: a name is one property's inside a project, and free in the next. */
const NAME_TAKEN = "property_project_id_name_key"
const nameTaken = (name: string) => `This project already has a property called ${JSON.stringify(name)}`

/** The partial unique index `(company_id, registry_id) where registry_id is not null`, which Postgres names as the constraint it refused with. */
const REGISTRY_TAKEN = "property_registry_id_idx"
const registryTaken = (registryId: string) => `This company already has a property with the registry identifier ${registryId}`

/** The sentences a write here can earn, and only for the fields the body gave. */
const collisions = (values: { name?: string; registryId?: string | null }): Record<string, string> => ({
  ...(values.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(values.name) }),
  ...(values.registryId == null ? {} : { [REGISTRY_TAKEN]: registryTaken(values.registryId) }),
})

const noSuchProperty = (id: string) => problem(404, { detail: `No property ${id} in the projects this account works in` })

/** The rows of this company, in the projects the caller works in: what every property statement is bounded by. */
const scope = (principal: Principal) => and(eq(property.companyId, principal.companyId), inProjects(property.projectId, principal))

/** The properties this customer is a party to, in any role: one row of the page however many roles it holds. */
const heldBy = (tx: Tx, companyId: string, customerId: string) =>
  exists(
    tx
      .select({ party: propertyParty.id })
      .from(propertyParty)
      .where(
        and(
          eq(propertyParty.companyId, companyId),
          eq(propertyParty.customerId, customerId),
          eq(propertyParty.propertyId, property.id),
        ),
      ),
  )

/** One property of this company by id, inside the caller's projects; undefined when it is neither. */
async function findProperty(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(property)
    .where(and(scope(principal), eq(property.id, id)))
    .limit(1)
  return row
}

export function propertyRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/properties",
      describeRoute({
        operationId: "listProperties",
        summary: "The properties the caller's projects serve",
        description:
          "One page of properties, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page — each with its parties. `projectId` narrows it to one of those projects; naming another is refused. `customerId` narrows it to the properties that customer is a party to in any role, which is the citizen portal's read model of what a person may see; a property they hold two roles on is one item, not two. The two filters combine. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of properties.", PropertyPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `customers.properties`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", PropertyListQuery),
      async (c) => {
        const { limit, cursor, projectId, customerId } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await tx
          .select(columns)
          .from(property)
          .where(
            and(
              scope(principal),
              projectId === undefined ? undefined : eq(property.projectId, projectId),
              customerId === undefined ? undefined : heldBy(tx, principal.companyId, customerId),
              after === undefined ? undefined : gt(property.id, after),
            ),
          )
          .orderBy(asc(property.id))
          .limit(fetchLimit(limit))
        // Paged first, so the row that only proves there is a next page is
        // not one of the properties whose parties are loaded.
        const { items, nextCursor } = pageOf(rows, limit)
        const held = await entriesOf(tx, parties, principal.companyId, items.map((row) => row.id))
        return c.json({ items: items.map((row) => propertyOf(row, held.get(row.id) ?? [])), nextCursor })
      },
    )
    .post(
      "/properties",
      describeRoute({
        operationId: "createProperty",
        summary: "Register a property",
        description:
          "Registers a service address in one project, which must be a project the caller works in. The name is unique inside the project and the registry identifier, where given, inside the company. The status defaults to `active` and the location is null until the address is geocoded; a location outside the WGS 84 range is refused before the database sees it. `parties` is the list the property starts with, each naming a customer of this company, so registering a property with its owner is one request. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The property as it was written.", Property),
          400: describeProblem(
            "The body is missing a field, names a member the server owns, names a project this account does not work in, holds a point outside the WGS 84 range, names the same customer and role twice, or names a party that is not a customer of this company.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `customers.properties`."),
          409: describeProblem("The project already has a property with that name, or the company one with that registry identifier."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", PropertyCreate),
      async (c) => {
        const { parties: asked, ...values } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        const parent: Parent = { companyId: principal.companyId, projectId: values.projectId, id: newId() }
        const entries = asked.map(entryOf)
        await parties.require(tx, parent, entries)
        const [row] = await refuseDuplicate(collisions(values), () =>
          tx
            .insert(property)
            .values({ ...values, id: parent.id, companyId: parent.companyId })
            .returning(columns),
        )
        await writeEntries(tx, parties, parent, entries)
        return created(c, "/properties", await propertyWithParties(tx, parent.companyId, row))
      },
    )
    .get(
      "/properties/:id",
      describeRoute({
        operationId: "getProperty",
        summary: "One property",
        description:
          "One property of a project the caller works in, with its parties. A property of another company, or of a project this account does not work in, is a property that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The property.", Property),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `customers.properties`."),
          404: describeProblem("No property with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findProperty(tx, principal, id)
        if (row === undefined) throw noSuchProperty(id)
        return c.json(await propertyWithParties(tx, principal.companyId, row))
      },
    )
    .patch(
      "/properties/:id",
      describeRoute({
        operationId: "patchProperty",
        summary: "Change a property",
        description:
          "Changes one property of a project the caller works in; every field is optional and at least one must be given. A null clears the registry identifier, the notes or the geocode. The project is not patchable, since a record does not move between projects, and the parties are a set, so they are `PUT /properties/{id}/parties`.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The property as it now stands.", Property),
          400: describeProblem(
            "The path does not hold an id, or the patch is empty, names a field the caller does not own (the project and the parties included), or holds a point outside the WGS 84 range.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `customers.properties`."),
          404: describeProblem("No property with that id in the projects this account works in."),
          409: describeProblem("The project already has another property with that name, or the company one with that registry identifier."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", PropertyPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const [row] = await refuseDuplicate(collisions(patch), () =>
          tx
            .update(property)
            .set(patch)
            .where(and(scope(principal), eq(property.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchProperty(id)
        return c.json(await propertyWithParties(tx, principal.companyId, row))
      },
    )
    .put(
      "/properties/:id/parties",
      describeRoute({
        operationId: "putPropertyParties",
        summary: "Replace a property's parties",
        description:
          "Replaces the whole list with the one in the body: a party the body leaves out is not a party afterwards, and an empty list is a property nobody is billed for. Each entry names a customer of this company and the role they hold, and the same customer may hold several roles, so a pair is named at most once. The record's `updatedAt` moves, since the parties are part of the property on the wire.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The property with the parties it now has.", Property),
          400: describeProblem(
            "The path does not hold an id, or the body is missing `parties`, names a member it does not own, names the same customer and role twice, or names a party that is not a customer of this company.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `customers.properties`."),
          404: describeProblem("No property with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", PropertyPartiesSet),
      async (c) => {
        const { id } = c.req.valid("param")
        const { parties: asked } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await replaceSet(tx, parties, principal.companyId, asked.map(entryOf), (stamped) =>
          tx
            .update(property)
            .set(stamped)
            .where(and(scope(principal), eq(property.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchProperty(id)
        return c.json(await propertyWithParties(tx, principal.companyId, row))
      },
    )
}
