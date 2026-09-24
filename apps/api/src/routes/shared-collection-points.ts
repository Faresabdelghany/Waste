// The place several properties put their waste (Issue #78): the underground
// bank on the corner, the recycling station, the yard behind a block.
// `GET /shared-collection-points` lists them, `POST /shared-collection-points`
// plans one, `GET /shared-collection-points/:id` reads one,
// `PATCH /shared-collection-points/:id` changes one and
// `PUT /shared-collection-points/:id/members` replaces which properties it
// serves. No delete: a point containers stand at and collections happened at
// is behind those records, and `status: "closed"` is what "remove a point"
// means here.
//
// A Shared Collection Point is not a Property Group. A Group is
// administrative — one invoice, one report, one agreement — and a Point is a
// physical place, so it carries a location, an access mode and a billing
// mode; a Property may belong to both, and the two are separate resources
// for that reason.
//
// `location` is not nullable here, unlike a Property's: the place is the
// record, and a point nobody can find is not a point. It goes in and comes
// back as GeoJSON (@waste/db/schema/geometry), and a point off the globe is
// refused by the contracts, naming the ordinate, before the database is asked.
//
// A Point is project-scoped, so every statement carries the tenant and
// `inProjects` (auth/projects.ts): a caller reads the points of the projects
// it works in, a create names one of those in the body (400 on `projectId`),
// and the project is not patchable — a record does not move between projects.
//
// The members are the set that travels with the record (routes/members.ts):
// a create may carry the list it starts with, a patch never touches it, and
// the PUT replaces it whole. A member is a Property of this point's own
// project, since the key that holds it carries `project_id`, and the check
// runs before the write as a 400 at `members.N.propertyId`. The Customer the
// point answers to is the company's, not the project's, so it is checked
// against the tenant alone.
//
// The grant is `customers.shared`, the surface's own.
import {
  SharedCollectionPoint,
  SharedCollectionPointCreate,
  SharedCollectionPointMembersSet,
  SharedCollectionPointPatch,
  type SharedCollectionPointAccessMode,
  type SharedCollectionPointBillingMode,
  type SharedCollectionPointKind,
  type SharedCollectionPointMember,
  type SharedCollectionPointMemberRole,
  type SharedCollectionPointOperatingModel,
  type SharedCollectionPointStatus,
} from "@waste/contracts/customers"
import { Page } from "@waste/contracts/pagination"
import { ProjectScopedListQuery } from "@waste/contracts/queries"
import type { Tx } from "@waste/db/client"
import { sharedCollectionPoint, sharedCollectionPointMember } from "@waste/db/schema/customers"
import { and, asc, eq, gt } from "drizzle-orm"
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
  requireMemberProperties,
  writeEntries,
  type Entry,
  type MemberSet,
  type Parent,
} from "./members"
import { requireCustomer } from "./references"
import { describeJson, IdParam, refuseDuplicate, stampsOf } from "./shared"

const MODULE = "customers.shared"
const SharedCollectionPointPage = Page(SharedCollectionPoint)

const columns = {
  id: sharedCollectionPoint.id,
  projectId: sharedCollectionPoint.projectId,
  name: sharedCollectionPoint.name,
  kind: sharedCollectionPoint.kind,
  address: sharedCollectionPoint.address,
  location: sharedCollectionPoint.location,
  eligibilityDistanceM: sharedCollectionPoint.eligibilityDistanceM,
  operatingModel: sharedCollectionPoint.operatingModel,
  accessMode: sharedCollectionPoint.accessMode,
  accessConditions: sharedCollectionPoint.accessConditions,
  availability: sharedCollectionPoint.availability,
  billingMode: sharedCollectionPoint.billingMode,
  responsibleCustomerId: sharedCollectionPoint.responsibleCustomerId,
  status: sharedCollectionPoint.status,
  createdAt: sharedCollectionPoint.createdAt,
  updatedAt: sharedCollectionPoint.updatedAt,
}

type Row = Pick<typeof sharedCollectionPoint.$inferSelect, keyof typeof columns>

/** The members of a Shared Collection Point: a Property of the same project, and what it is to the point. */
const members: MemberSet<typeof sharedCollectionPointMember> = {
  table: sharedCollectionPointMember,
  parentId: sharedCollectionPointMember.sharedCollectionPointId,
  entryId: sharedCollectionPointMember.propertyId,
  rowOf: (entry, parent) => ({
    id: newId(),
    companyId: parent.companyId,
    projectId: parent.projectId,
    sharedCollectionPointId: parent.id,
    propertyId: entry.id,
    role: entry.role,
  }),
  require: requireMemberProperties,
}

/** The two spellings of one member: the wire's, and the set mechanics' (routes/members.ts). */
const memberOf = (entry: Entry): SharedCollectionPointMember => ({
  propertyId: entry.id,
  role: entry.role as SharedCollectionPointMemberRole,
})
const entryOf = (member: SharedCollectionPointMember): Entry => ({ id: member.propertyId, role: member.role })

/** The row on the wire, with the members the page loaded for it. The five coded fields are text with a CHECK in the database and an enum here. */
function pointOf(row: Row, served: readonly Entry[]): SharedCollectionPoint {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    kind: row.kind as SharedCollectionPointKind,
    address: row.address,
    location: row.location,
    eligibilityDistanceM: row.eligibilityDistanceM,
    operatingModel: row.operatingModel as SharedCollectionPointOperatingModel,
    accessMode: row.accessMode as SharedCollectionPointAccessMode,
    accessConditions: row.accessConditions,
    availability: row.availability,
    billingMode: row.billingMode as SharedCollectionPointBillingMode,
    responsibleCustomerId: row.responsibleCustomerId,
    status: row.status as SharedCollectionPointStatus,
    members: served.map(memberOf),
    ...stampsOf(row),
  }
}

/** One point on the wire, its members read back the way a page reads them, so an answer equals the next read. */
async function pointWithMembers(tx: Tx, companyId: string, row: Row): Promise<SharedCollectionPoint> {
  return pointOf(row, await entriesFor(tx, members, companyId, row.id))
}

/** `unique (company_id, project_id, name)`: a name is one point's inside a project, and free in the next. */
const NAME_TAKEN = "shared_collection_point_project_id_name_key"
const nameTaken = (name: string) => `This project already has a shared collection point called ${JSON.stringify(name)}`

const noSuchPoint = (id: string) => problem(404, { detail: `No shared collection point ${id} in the projects this account works in` })

/** The rows of this company, in the projects the caller works in: what every point statement is bounded by. */
const scope = (principal: Principal) =>
  and(eq(sharedCollectionPoint.companyId, principal.companyId), inProjects(sharedCollectionPoint.projectId, principal))

/** One point of this company by id, inside the caller's projects; undefined when it is neither. */
async function findPoint(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(sharedCollectionPoint)
    .where(and(scope(principal), eq(sharedCollectionPoint.id, id)))
    .limit(1)
  return row
}

export function sharedCollectionPointRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/shared-collection-points",
      describeRoute({
        operationId: "listSharedCollectionPoints",
        summary: "The shared collection points the caller's projects run",
        description:
          "One page of shared collection points, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page — each with its members. `projectId` narrows it to one of those projects; naming another is refused. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of shared collection points.", SharedCollectionPointPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `customers.shared`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", ProjectScopedListQuery),
      async (c) => {
        const { limit, cursor, projectId } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await tx
          .select(columns)
          .from(sharedCollectionPoint)
          .where(
            and(
              scope(principal),
              projectId === undefined ? undefined : eq(sharedCollectionPoint.projectId, projectId),
              after === undefined ? undefined : gt(sharedCollectionPoint.id, after),
            ),
          )
          .orderBy(asc(sharedCollectionPoint.id))
          .limit(fetchLimit(limit))
        // Paged first, so the row that only proves there is a next page is
        // not one of the points whose members are loaded.
        const { items, nextCursor } = pageOf(rows, limit)
        const served = await entriesOf(tx, members, principal.companyId, items.map((row) => row.id))
        return c.json({ items: items.map((row) => pointOf(row, served.get(row.id) ?? [])), nextCursor })
      },
    )
    .post(
      "/shared-collection-points",
      describeRoute({
        operationId: "createSharedCollectionPoint",
        summary: "Plan a shared collection point",
        description:
          "Plans a place several properties share, inside a project the caller works in. The name is unique inside the project and the status defaults to `draft`. The location is required — the place is the record — and one outside the WGS 84 range is refused before the database sees it; the eligibility distance, where given, is a whole number of metres above zero. The customer the point answers to, where given, must be this company's, and every member must be a property of this same project. `members` is the list the point starts with. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The shared collection point as it was written.", SharedCollectionPoint),
          400: describeProblem(
            "The body is missing a field, names a member the server owns, names a project this account does not work in, holds a point outside the WGS 84 range, names the same property twice, points at a customer that is not this company's, or serves a property that is not of this project.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `customers.shared`."),
          409: describeProblem("The project already has a shared collection point with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", SharedCollectionPointCreate),
      async (c) => {
        const { members: asked, ...values } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        const parent: Parent = { companyId: principal.companyId, projectId: values.projectId, id: newId() }
        const entries = asked.map(entryOf)
        await requireCustomer(tx, parent.companyId, values.responsibleCustomerId, "responsibleCustomerId")
        await members.require(tx, parent, entries)
        const [row] = await refuseDuplicate({ [NAME_TAKEN]: nameTaken(values.name) }, () =>
          tx
            .insert(sharedCollectionPoint)
            .values({ ...values, id: parent.id, companyId: parent.companyId })
            .returning(columns),
        )
        await writeEntries(tx, members, parent, entries)
        return c.json(await pointWithMembers(tx, parent.companyId, row), 201)
      },
    )
    .get(
      "/shared-collection-points/:id",
      describeRoute({
        operationId: "getSharedCollectionPoint",
        summary: "One shared collection point",
        description:
          "One shared collection point of a project the caller works in, with its members. A point of another company, or of a project this account does not work in, is a point that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The shared collection point.", SharedCollectionPoint),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `customers.shared`."),
          404: describeProblem("No shared collection point with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findPoint(tx, principal, id)
        if (row === undefined) throw noSuchPoint(id)
        return c.json(await pointWithMembers(tx, principal.companyId, row))
      },
    )
    .patch(
      "/shared-collection-points/:id",
      describeRoute({
        operationId: "patchSharedCollectionPoint",
        summary: "Change a shared collection point",
        description:
          "Changes one shared collection point of a project the caller works in; every field is optional and at least one must be given. The location may move but not be cleared, since the place is the record; a null clears the eligibility distance, the access conditions, the availability or the customer the point answers to. The project is not patchable, since a record does not move between projects, and the members are a set, so they are `PUT /shared-collection-points/{id}/members`.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The shared collection point as it now stands.", SharedCollectionPoint),
          400: describeProblem(
            "The path does not hold an id, or the patch is empty, names a field the caller does not own (the project and the members included), holds a point outside the WGS 84 range, or points at a customer that is not this company's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `customers.shared`."),
          404: describeProblem("No shared collection point with that id in the projects this account works in."),
          409: describeProblem("The project already has another shared collection point with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", SharedCollectionPointPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await requireCustomer(tx, principal.companyId, patch.responsibleCustomerId, "responsibleCustomerId")
        const sentences: Record<string, string> = patch.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(patch.name) }
        const [row] = await refuseDuplicate(sentences, () =>
          tx
            .update(sharedCollectionPoint)
            .set(patch)
            .where(and(scope(principal), eq(sharedCollectionPoint.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchPoint(id)
        return c.json(await pointWithMembers(tx, principal.companyId, row))
      },
    )
    .put(
      "/shared-collection-points/:id/members",
      describeRoute({
        operationId: "putSharedCollectionPointMembers",
        summary: "Replace a shared collection point's members",
        description:
          "Replaces the whole membership with the one in the body: a property the body leaves out does not put its waste here afterwards, and an empty list is a point nobody is a member of. Every member must be a property of the point's own project, and a property is named at most once, since it is a member or it is not and the role says what kind. The record's `updatedAt` moves, since the members are part of the point on the wire.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The shared collection point with the members it now has.", SharedCollectionPoint),
          400: describeProblem(
            "The path does not hold an id, or the body is missing `members`, names a member it does not own, names the same property twice, or serves a property that is not of this project.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `customers.shared`."),
          404: describeProblem("No shared collection point with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", SharedCollectionPointMembersSet),
      async (c) => {
        const { id } = c.req.valid("param")
        const { members: asked } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await replaceSet(tx, members, principal.companyId, asked.map(entryOf), (stamped) =>
          tx
            .update(sharedCollectionPoint)
            .set(stamped)
            .where(and(scope(principal), eq(sharedCollectionPoint.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchPoint(id)
        return c.json(await pointWithMembers(tx, principal.companyId, row))
      },
    )
}
