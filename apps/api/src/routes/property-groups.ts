// Properties gathered for one administration (Issue #78): the block an
// invoice, a report or an agreement is written for. `GET /property-groups`
// lists them, `POST /property-groups` gathers one, `GET /property-groups/:id`
// reads one, `PATCH /property-groups/:id` changes one and
// `PUT /property-groups/:id/members` replaces which properties are in it. No
// delete: a group an agreement or a report names is behind those records, and
// `status: "inactive"` is what "remove a group" means here.
//
// A Property Group is not a Shared Collection Point. A Group is
// administrative — one invoice, one report, one agreement — and a Point is a
// physical place where several properties put their waste; a Property may
// belong to both, and the two are separate resources for that reason.
//
// A Group is project-scoped, so every statement carries the tenant and
// `inProjects` (auth/projects.ts): a caller reads the groups of the projects
// it works in, a create names one of those in the body (400 on `projectId`),
// and the project is not patchable — a record does not move between projects.
//
// The members are the set that travels with the record (routes/members.ts):
// a create may carry the list it starts with, a patch never touches it, and
// the PUT replaces it whole. A member is a Property of this group's own
// project, since the key that holds it carries `project_id`, and the check
// runs before the write as a 400 at `members.N.propertyId`. The Customer the
// group answers to is the company's, not the project's, so it is checked
// against the tenant alone.
//
// The grant is `customers.groups`, the surface's own.
import {
  PropertyGroup,
  PropertyGroupCreate,
  PropertyGroupMembersSet,
  PropertyGroupPatch,
  type PropertyGroupMember,
  type PropertyGroupMemberRole,
  type PropertyGroupPurpose,
  type PropertyGroupStatus,
} from "@waste/contracts/customers"
import { Page } from "@waste/contracts/pagination"
import { ProjectScopedListQuery } from "@waste/contracts/queries"
import type { Tx } from "@waste/db/client"
import { propertyGroup, propertyGroupMember } from "@waste/db/schema/customers"
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

const MODULE = "customers.groups"
const PropertyGroupPage = Page(PropertyGroup)

const columns = {
  id: propertyGroup.id,
  projectId: propertyGroup.projectId,
  name: propertyGroup.name,
  purpose: propertyGroup.purpose,
  responsibleCustomerId: propertyGroup.responsibleCustomerId,
  status: propertyGroup.status,
  createdAt: propertyGroup.createdAt,
  updatedAt: propertyGroup.updatedAt,
}

type Row = Pick<typeof propertyGroup.$inferSelect, keyof typeof columns>

/** The members of a Property Group: a Property of the same project, and what it is to the group. */
const members: MemberSet<typeof propertyGroupMember> = {
  table: propertyGroupMember,
  parentId: propertyGroupMember.propertyGroupId,
  entryId: propertyGroupMember.propertyId,
  rowOf: (entry, parent) => ({
    id: newId(),
    companyId: parent.companyId,
    projectId: parent.projectId,
    propertyGroupId: parent.id,
    propertyId: entry.id,
    role: entry.role,
  }),
  require: requireMemberProperties,
}

/** The two spellings of one member: the wire's, and the set mechanics' (routes/members.ts). */
const memberOf = (entry: Entry): PropertyGroupMember => ({ propertyId: entry.id, role: entry.role as PropertyGroupMemberRole })
const entryOf = (member: PropertyGroupMember): Entry => ({ id: member.propertyId, role: member.role })

/** The row on the wire, with the members the page loaded for it. `purpose` and `status` are text with a CHECK in the database and an enum here. */
function groupOf(row: Row, gathered: readonly Entry[]): PropertyGroup {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    purpose: row.purpose as PropertyGroupPurpose,
    responsibleCustomerId: row.responsibleCustomerId,
    status: row.status as PropertyGroupStatus,
    members: gathered.map(memberOf),
    ...stampsOf(row),
  }
}

/** One group on the wire, its members read back the way a page reads them, so an answer equals the next read. */
async function groupWithMembers(tx: Tx, companyId: string, row: Row): Promise<PropertyGroup> {
  return groupOf(row, await entriesFor(tx, members, companyId, row.id))
}

/** `unique (company_id, project_id, name)`: a name is one group's inside a project, and free in the next. */
const NAME_TAKEN = "property_group_project_id_name_key"
const nameTaken = (name: string) => `This project already has a property group called ${JSON.stringify(name)}`

const noSuchGroup = (id: string) => problem(404, { detail: `No property group ${id} in the projects this account works in` })

/** The rows of this company, in the projects the caller works in: what every group statement is bounded by. */
const scope = (principal: Principal) =>
  and(eq(propertyGroup.companyId, principal.companyId), inProjects(propertyGroup.projectId, principal))

/** One group of this company by id, inside the caller's projects; undefined when it is neither. */
async function findGroup(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(propertyGroup)
    .where(and(scope(principal), eq(propertyGroup.id, id)))
    .limit(1)
  return row
}

export function propertyGroupRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/property-groups",
      describeRoute({
        operationId: "listPropertyGroups",
        summary: "The property groups the caller's projects hold",
        description:
          "One page of property groups, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page — each with its members. `projectId` narrows it to one of those projects; naming another is refused. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of property groups.", PropertyGroupPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `customers.groups`."),
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
          .from(propertyGroup)
          .where(
            and(
              scope(principal),
              projectId === undefined ? undefined : eq(propertyGroup.projectId, projectId),
              after === undefined ? undefined : gt(propertyGroup.id, after),
            ),
          )
          .orderBy(asc(propertyGroup.id))
          .limit(fetchLimit(limit))
        // Paged first, so the row that only proves there is a next page is
        // not one of the groups whose members are loaded.
        const { items, nextCursor } = pageOf(rows, limit)
        const gathered = await entriesOf(tx, members, principal.companyId, items.map((row) => row.id))
        return c.json({ items: items.map((row) => groupOf(row, gathered.get(row.id) ?? [])), nextCursor })
      },
    )
    .post(
      "/property-groups",
      describeRoute({
        operationId: "createPropertyGroup",
        summary: "Gather a property group",
        description:
          "Gathers properties into one group inside a project the caller works in. The name is unique inside the project and the status defaults to `draft`. The customer the group answers to, where given, must be this company's, and every member must be a property of this same project. `members` is the list the group starts with, so gathering a block is one request. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The property group as it was written.", PropertyGroup),
          400: describeProblem(
            "The body is missing a field, names a member the server owns, names a project this account does not work in, names the same property twice, points at a customer that is not this company's, or gathers a property that is not of this project.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `customers.groups`."),
          409: describeProblem("The project already has a property group with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", PropertyGroupCreate),
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
            .insert(propertyGroup)
            .values({ ...values, id: parent.id, companyId: parent.companyId })
            .returning(columns),
        )
        await writeEntries(tx, members, parent, entries)
        return c.json(await groupWithMembers(tx, parent.companyId, row), 201)
      },
    )
    .get(
      "/property-groups/:id",
      describeRoute({
        operationId: "getPropertyGroup",
        summary: "One property group",
        description:
          "One property group of a project the caller works in, with its members. A group of another company, or of a project this account does not work in, is a group that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The property group.", PropertyGroup),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `customers.groups`."),
          404: describeProblem("No property group with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findGroup(tx, principal, id)
        if (row === undefined) throw noSuchGroup(id)
        return c.json(await groupWithMembers(tx, principal.companyId, row))
      },
    )
    .patch(
      "/property-groups/:id",
      describeRoute({
        operationId: "patchPropertyGroup",
        summary: "Change a property group",
        description:
          "Changes one property group of a project the caller works in; every field is optional and at least one must be given. A null clears the customer the group answers to. The project is not patchable, since a record does not move between projects, and the members are a set, so they are `PUT /property-groups/{id}/members`.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The property group as it now stands.", PropertyGroup),
          400: describeProblem(
            "The path does not hold an id, or the patch is empty, names a field the caller does not own (the project and the members included), or points at a customer that is not this company's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `customers.groups`."),
          404: describeProblem("No property group with that id in the projects this account works in."),
          409: describeProblem("The project already has another property group with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", PropertyGroupPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await requireCustomer(tx, principal.companyId, patch.responsibleCustomerId, "responsibleCustomerId")
        const sentences: Record<string, string> = patch.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(patch.name) }
        const [row] = await refuseDuplicate(sentences, () =>
          tx
            .update(propertyGroup)
            .set(patch)
            .where(and(scope(principal), eq(propertyGroup.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchGroup(id)
        return c.json(await groupWithMembers(tx, principal.companyId, row))
      },
    )
    .put(
      "/property-groups/:id/members",
      describeRoute({
        operationId: "putPropertyGroupMembers",
        summary: "Replace a property group's members",
        description:
          "Replaces the whole membership with the one in the body: a property the body leaves out is not in the group afterwards, and an empty list is a group nobody is in. Every member must be a property of the group's own project, and a property is named at most once, since it is a member or it is not and the role says what kind. The record's `updatedAt` moves, since the members are part of the group on the wire.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The property group with the members it now has.", PropertyGroup),
          400: describeProblem(
            "The path does not hold an id, or the body is missing `members`, names a member it does not own, names the same property twice, or gathers a property that is not of this project.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `customers.groups`."),
          404: describeProblem("No property group with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", PropertyGroupMembersSet),
      async (c) => {
        const { id } = c.req.valid("param")
        const { members: asked } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await replaceSet(tx, members, principal.companyId, asked.map(entryOf), (stamped) =>
          tx
            .update(propertyGroup)
            .set(stamped)
            .where(and(scope(principal), eq(propertyGroup.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchGroup(id)
        return c.json(await groupWithMembers(tx, principal.companyId, row))
      },
    )
}
