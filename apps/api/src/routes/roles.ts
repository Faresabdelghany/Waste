// The company's roles and what each one allows. `GET /roles` lists them a
// page at a time with their whole matrix, `POST /roles` adds a custom one,
// `GET /roles/:id` reads one, `PATCH /roles/:id` changes its copy and
// `PUT /roles/:id/grants` replaces the matrix. There is no delete: accounts
// hold roles, and a role nobody holds is a product question (which account
// takes its holders?) rather than a row disappearing.
//
// A company is seeded with the twelve system roles of
// @waste/domain/access/system-roles, which keep their `key` and `system =
// true`; a role created here is custom, so the server writes `key: null` and
// `system: false` and no write body names either — a seeded role's key is
// what matches its rows back to the charter. A system role's name and
// description are the company's to change (the seed writes them on insert
// alone); its scope and its matrix are the platform's, which every seed
// restores to the charter, so a change to either is refused (409) rather than
// taken and silently undone at the next seed (#291): a company that wants
// another reach makes a custom role.
//
// The matrix is always the set as the system stores it (access-shape.ts, over
// the one rule in @waste/domain/access/grants): `edit`, `create` and `delete`
// imply `view`, a module named twice is merged, and a module granted nothing
// is dropped. So a body that ticks "can delete" and nothing else is stored,
// and answered, the same as one that ticks both boxes — and two roles with
// the same reach have the same grants, by value.
//
// `PUT` replaces: the role's rows go and the body's arrive, in the request's
// one transaction, so a client that sends the matrix it rendered cannot merge
// with a change it never saw. Every statement carries `company_id = the
// caller's` beside the fence, the deletes included (ADR-0001: the API is the
// authority, RLS the backstop).
//
// The grant is `configure.access`, as for users: Settings → Users, Roles &
// Teams is one surface.
import { Role, RoleCreate, RoleGrants, RolePatch } from "@waste/contracts/access"
import { Page, PageRequest } from "@waste/contracts/pagination"
import type { Grant } from "@waste/contracts/permissions"
import type { Tx } from "@waste/db/client"
import { role, roleGrant } from "@waste/db/schema/access"
import { PROVIDER_ROLE_SCOPE, systemRoleKept, systemRoleScopeKept } from "@waste/domain/access/system-roles"
import { and, eq, inArray, sql } from "drizzle-orm"
import { newId } from "@waste/db/ids"
import { refuseDuplicate } from "@waste/db/commands/shared"
import { stampsOf } from "@waste/db/shapes/times"

import { grantsOfRows, normalisedGrants } from "../access-shape"
import { accessModuleOf, providerIdOf } from "../auth/provider"
import type { RouteDeps } from "../deps"
import { created, describeCreated, describeJson, IdParam, routes } from "../operation"
import { pageAt } from "../pagination"
import { describeProblem, problem } from "../problem"
import { scoped } from "../scoped"

const MODULE = "configure.access"
const RolePage = Page(Role)

const columns = {
  id: role.id,
  key: role.key,
  name: role.name,
  scope: role.scope,
  description: role.description,
  system: role.system,
  createdAt: role.createdAt,
  updatedAt: role.updatedAt,
}

type Row = Pick<typeof role.$inferSelect, keyof typeof columns>

function roleOf(row: Row, grants: Grant[]): Role {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    scope: row.scope,
    description: row.description,
    system: row.system,
    grants,
    ...stampsOf(row),
  }
}

async function grantsOf(tx: Tx, companyId: string, roleIds: readonly string[]): Promise<Map<string, Grant[]>> {
  if (roleIds.length === 0) return new Map()
  const rows = await tx
    .select({ roleId: roleGrant.roleId, moduleKey: roleGrant.moduleKey, action: roleGrant.action })
    .from(roleGrant)
    .where(and(eq(roleGrant.companyId, companyId), inArray(roleGrant.roleId, [...roleIds])))
  const byRole = new Map<string, { moduleKey: string; action: string }[]>()
  for (const row of rows) {
    const found = byRole.get(row.roleId)
    if (found === undefined) byRole.set(row.roleId, [row])
    else found.push(row)
  }
  return new Map([...byRole].map(([roleId, grantRows]) => [roleId, grantsOfRows(grantRows)]))
}

/** One role on the wire, its matrix read back the way a page reads it, so an answer equals the next read. */
async function roleWithGrants(tx: Tx, companyId: string, row: Row): Promise<Role> {
  const byRole = await grantsOf(tx, companyId, [row.id])
  return roleOf(row, byRole.get(row.id) ?? [])
}

const grantRowsOf = (companyId: string, roleId: string, grants: readonly Grant[]) =>
  grants.flatMap((grant) => grant.actions.map((action) => ({ id: newId(), companyId, roleId, moduleKey: grant.moduleKey, action })))

/** `unique (company_id, name)`: a name is one role's inside a company, and free in the next. */
const NAME_TAKEN = "role_name_key"
const nameTaken = (name: string) => `This company already has a role called ${JSON.stringify(name)}`

/**
 * The roles of this company the caller reads: every one for the office, and
 * for a Service Provider's account the roles of a provider's team
 * (`PROVIDER_ROLE_SCOPE`), the ones its team door may give (#291 slice 23b,
 * routes/users.ts holds the rest of that rule when one is given). A command
 * reads the company's, every one (`findRole`).
 */
const {
  noSuch: noSuchRole,
  get: getRole,
  commanded: findRole,
  list: listRoles,
} = scoped(role, {
  noun: "role",
  reach: "company",
  reads: (_tx, principal) => and(eq(role.companyId, principal.companyId), providerIdOf(principal) === null ? undefined : eq(role.scope, PROVIDER_ROLE_SCOPE)),
  columns,
})

export function roleRoutes(deps: RouteDeps) {
  return routes(deps)
    .get(
      "/roles",
      {
        operationId: "listRoles",
        summary: "The company's roles",
        description:
          "One page of the company's roles, oldest first (ids are time-ordered), each with its whole matrix — or, for a Service Provider's account, under `service-providers.service-provider-workspace`, the roles of a provider's team (scope `Own service provider`), the ones it may give its own accounts where they allow no more than its own. Hand `nextCursor` back as `cursor` for the next page; `nextCursor` is null on the last one.",
        module: accessModuleOf,
        action: "view",
        query: PageRequest,
        responses: {
          200: describeJson("One page of roles.", RolePage),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.access` (on `service-providers.service-provider-workspace` for a Service Provider's account)."),
        },
      },
      async (c) => {
        const { limit, cursor } = c.req.valid("query")
        const at = pageAt({ cursor, limit })
        const tx = c.get("tx")
        const principal = c.get("principal")
        const { companyId } = principal
        // Paged first, so the row that only proves there is a next page is not
        // one of the roles whose matrix is loaded.
        const { items, nextCursor } = await listRoles(tx, principal, at)
        const byRole = await grantsOf(tx, companyId, items.map((row) => row.id))
        return c.json({ items: items.map((row) => roleOf(row, byRole.get(row.id) ?? [])), nextCursor })
      },
    )
    .post(
      "/roles",
      {
        operationId: "createRole",
        summary: "Add a role",
        description:
          "Creates a custom role in the caller's company: the server writes it with no key and `system: false`, since a key belongs to a seeded role. The grants are stored as the system spells them — `edit`, `create` and `delete` imply `view`, a module named twice is merged — and default to none. The server mints the id.",
        module: MODULE,
        action: "create",
        body: RoleCreate,
        invalid: ["the body is missing a field, names one the server owns, or names a module or action outside the vocabulary"],
        responses: {
          201: describeCreated("The role as it was written.", Role),
          409: describeProblem("The company already has a role with that name."),
        },
      },
      async (c) => {
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const { companyId } = c.get("principal")
        const grants = normalisedGrants(values.grants)
        const id = newId()
        const [row] = await refuseDuplicate({ [NAME_TAKEN]: nameTaken(values.name) }, () =>
          tx
            .insert(role)
            .values({ id, companyId, key: null, system: false, name: values.name, scope: values.scope, description: values.description })
            .returning(columns),
        )
        if (grants.length > 0) await tx.insert(roleGrant).values(grantRowsOf(companyId, id, grants))
        return created(c, "/roles", roleOf(row, grants))
      },
    )
    .get(
      "/roles/:id",
      {
        operationId: "getRole",
        summary: "One role",
        description: "One role of the caller's company, with its whole matrix — for a Service Provider's account, a role of a provider's team. Another company's role, or for a provider's account any other, is a role that does not exist here.",
        module: accessModuleOf,
        action: "view",
        params: IdParam,
        responses: {
          200: describeJson("The role.", Role),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.access` (on `service-providers.service-provider-workspace` for a Service Provider's account)."),
          404: describeProblem("No role with that id in this company."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const { companyId } = principal
        const row = await getRole(tx, principal, id)
        return c.json(await roleWithGrants(tx, companyId, row))
      },
    )
    .patch(
      "/roles/:id",
      {
        operationId: "patchRole",
        summary: "Change a role's copy",
        description:
          "Changes the name, the scope or the description; every field is optional and at least one must be given. A system role's name and description are the company's to change — a company may call the Dispatcher by a name of its own — but its scope is the platform's, which every seed restores to the charter: another scope on a system role is refused (409), while re-stating the one it has names nothing new, so a body sending the copy whole is taken. A role's `key` and its `system` flag are not a caller's to change, so the body does not name them, and the matrix is `PUT /roles/{id}/grants`.",
        module: MODULE,
        action: "edit",
        params: IdParam,
        body: RolePatch,
        invalid: ["the patch is empty or names a field the caller does not own"],
        responses: {
          200: describeJson("The role as it now stands.", Role),
          404: describeProblem("No role with that id in this company."),
          409: describeProblem("The company already has another role with that name, or the patch moves a system role's scope."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const { companyId } = principal
        const current = await findRole(tx, principal, id)
        if (current === undefined) throw noSuchRole(id)
        if (current.system && patch.scope !== undefined && patch.scope !== current.scope) throw problem(409, { detail: systemRoleScopeKept(current.name) })
        const sentences: Record<string, string> = patch.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(patch.name) }
        const [row] = await refuseDuplicate(sentences, () =>
          tx
            .update(role)
            .set(patch)
            .where(and(eq(role.companyId, companyId), eq(role.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchRole(id)
        return c.json(await roleWithGrants(tx, companyId, row))
      },
    )
    .put(
      "/roles/:id/grants",
      {
        operationId: "putRoleGrants",
        summary: "Replace a role's matrix",
        description:
          "Replaces the whole matrix of a custom role with the one in the body: a module the body leaves out is not allowed at all afterwards, and an empty list is a role that may do nothing. The set is stored as the system spells it — `edit`, `create` and `delete` imply `view`, a module named twice is merged — and a revoked grant takes effect on the holder's very next request, since the API looks a caller's grants up on every call. A system role's matrix is the platform's, which every seed restores to the charter, so replacing it is refused (409): a company that wants another reach makes a custom role.",
        module: MODULE,
        action: "edit",
        params: IdParam,
        body: RoleGrants,
        invalid: ["the body is missing `grants`, names a member it does not own, or names a module or action outside the vocabulary"],
        responses: {
          200: describeJson("The role with the matrix it now has.", Role),
          404: describeProblem("No role with that id in this company."),
          409: describeProblem("The role is a system role, whose matrix is the platform's."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const { grants: asked } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const { companyId } = principal
        const current = await findRole(tx, principal, id)
        if (current === undefined) throw noSuchRole(id)
        if (current.system) throw problem(409, { detail: systemRoleKept(current.name) })
        // The matrix is part of the role on the wire, so replacing it changes
        // the role: the update is what says so. The trigger would stamp
        // `updated_at` whatever this set said; naming it is naming what changed.
        const [row] = await tx
          .update(role)
          .set({ updatedAt: sql`now()` })
          .where(and(eq(role.companyId, companyId), eq(role.id, id)))
          .returning(columns)
        if (row === undefined) throw noSuchRole(id)

        const grants = normalisedGrants(asked)
        await tx.delete(roleGrant).where(and(eq(roleGrant.companyId, companyId), eq(roleGrant.roleId, id)))
        if (grants.length > 0) await tx.insert(roleGrant).values(grantRowsOf(companyId, id, grants))
        return c.json(roleOf(row, grants))
      },
    )
}
