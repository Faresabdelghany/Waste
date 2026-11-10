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
} from "@waste/contracts/customers"
import { Page } from "@waste/contracts/pagination"
import { ProjectScopedListQuery } from "@waste/contracts/queries"
import type { Tx } from "@waste/db/client"
import { propertyGroup, propertyGroupMember } from "@waste/db/schema/customers"
import { and, eq } from "drizzle-orm"
import { newId } from "@waste/db/ids"
import { refuseDuplicate } from "@waste/db/commands/shared"
import { stampsOf } from "@waste/db/shapes/times"
import { requireProject } from "../auth/projects"
import type { RouteDeps } from "../deps"
import { created, describeCreated, describeJson, IdParam, routes } from "../operation"
import { pageAt } from "../pagination"
import { describeProblem } from "../problem"
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
import { scoped } from "../scoped"
import { requireCustomer } from "./references"

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
const entryOf = (member: PropertyGroupMember): Entry<PropertyGroupMemberRole> => ({ id: member.propertyId, role: member.role })

/** The row on the wire, with the members the page loaded for it. `purpose` and `status` are text with a CHECK in the database and an enum here. */
function groupOf(row: Row, gathered: readonly Entry[]): PropertyGroup {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    purpose: row.purpose,
    responsibleCustomerId: row.responsibleCustomerId,
    status: row.status,
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

const { scope, noSuch: noSuchGroup, get: getGroup, list: listGroups } = scoped(propertyGroup, { noun: "property group", reach: "projects", columns })

export function propertyGroupRoutes(deps: RouteDeps) {
  return routes(deps)
    .get(
      "/property-groups",
      {
        operationId: "listPropertyGroups",
        summary: "The property groups the caller's projects hold",
        description:
          "One page of property groups, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page — each with its members. `projectId` narrows it to one of those projects; naming another is refused. Hand `nextCursor` back as `cursor` for the next page.",
        module: MODULE,
        action: "view",
        query: ProjectScopedListQuery,
        invalid: ["`projectId` is not a project this account works in"],
        responses: {
          200: describeJson("One page of property groups.", PropertyGroupPage),
        },
      },
      async (c) => {
        const { limit, cursor, projectId } = c.req.valid("query")
        const at = pageAt({ cursor, limit })
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const { items, nextCursor } = await listGroups(tx, principal, at, projectId === undefined ? undefined : eq(propertyGroup.projectId, projectId))
        // Paged first, so the row that only proves there is a next page is
        // not one of the groups whose members are loaded.
        const gathered = await entriesOf(tx, members, principal.companyId, items.map((row) => row.id))
        return c.json({ items: items.map((row) => groupOf(row, gathered.get(row.id) ?? [])), nextCursor })
      },
    )
    .post(
      "/property-groups",
      {
        operationId: "createPropertyGroup",
        summary: "Gather a property group",
        description:
          "Gathers properties into one group inside a project the caller works in. The name is unique inside the project and the status defaults to `draft`. The customer the group answers to, where given, must be this company's, and every member must be a property of this same project. `members` is the list the group starts with, so gathering a block is one request. The server mints the id.",
        module: MODULE,
        action: "create",
        body: PropertyGroupCreate,
        invalid: ["the body is missing a field, names a member the server owns, names a project this account does not work in, names the same property twice, points at a customer that is not this company's, or gathers a property that is not of this project"],
        responses: {
          201: describeCreated("The property group as it was written.", PropertyGroup),
          409: describeProblem("The project already has a property group with that name."),
        },
      },
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
        return created(c, "/property-groups", await groupWithMembers(tx, parent.companyId, row))
      },
    )
    .get(
      "/property-groups/:id",
      {
        operationId: "getPropertyGroup",
        summary: "One property group",
        description:
          "One property group of a project the caller works in, with its members. A group of another company, or of a project this account does not work in, is a group that does not exist here.",
        module: MODULE,
        action: "view",
        params: IdParam,
        responses: {
          200: describeJson("The property group.", PropertyGroup),
          404: describeProblem("No property group with that id in the projects this account works in."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await getGroup(tx, principal, id)
        return c.json(await groupWithMembers(tx, principal.companyId, row))
      },
    )
    .patch(
      "/property-groups/:id",
      {
        operationId: "patchPropertyGroup",
        summary: "Change a property group",
        description:
          "Changes one property group of a project the caller works in; every field is optional and at least one must be given. A null clears the customer the group answers to. The project is not patchable, since a record does not move between projects, and the members are a set, so they are `PUT /property-groups/{id}/members`.",
        module: MODULE,
        action: "edit",
        params: IdParam,
        body: PropertyGroupPatch,
        invalid: ["the patch is empty, names a field the caller does not own (the project and the members included), or points at a customer that is not this company's"],
        responses: {
          200: describeJson("The property group as it now stands.", PropertyGroup),
          404: describeProblem("No property group with that id in the projects this account works in."),
          409: describeProblem("The project already has another property group with that name."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The row first, then what the patch points at: an id nobody minted
        // is a 404 here as in every other family, and not a 400 about a
        // customer that was never going to be written.
        await getGroup(tx, principal, id)
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
      {
        operationId: "putPropertyGroupMembers",
        summary: "Replace a property group's members",
        description:
          "Replaces the whole membership with the one in the body: a property the body leaves out is not in the group afterwards, and an empty list is a group nobody is in. Every member must be a property of the group's own project, and a property is named at most once, since it is a member or it is not and the role says what kind. The record's `updatedAt` moves, since the members are part of the group on the wire.",
        module: MODULE,
        action: "edit",
        params: IdParam,
        body: PropertyGroupMembersSet,
        invalid: ["the body is missing `members`, names a member it does not own, names the same property twice, or gathers a property that is not of this project"],
        responses: {
          200: describeJson("The property group with the members it now has.", PropertyGroup),
          404: describeProblem("No property group with that id in the projects this account works in."),
        },
      },
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
