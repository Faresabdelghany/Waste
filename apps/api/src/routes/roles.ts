// The company's roles and what each one allows. `GET /roles` lists them a
// page at a time with their whole matrix, `POST /roles` adds a custom one,
// `GET /roles/:id` reads one, `PATCH /roles/:id` changes its copy and
// `PUT /roles/:id/grants` replaces the matrix. There is no delete: accounts
// hold roles, and a role nobody holds is a product question (which account
// takes its holders?) rather than a row disappearing.
//
// A company is seeded with the eleven system roles of
// @waste/domain/access/system-roles, which keep their `key` and `system =
// true`; a role created here is custom, so the server writes `key: null` and
// `system: false` and no write body names either — a seeded role's key is
// what matches its rows back to the charter, and its copy and its matrix are
// the company's to change (the prototype lets an administrator edit a system
// role's matrix, and so does this).
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
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { grantsOfRows, normalisedGrants } from "../access-shape"
import { BEARER_SECURITY, type AuthEnv } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { describeJson, IdParam, refuseDuplicate, stampsOf } from "./shared"

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

/** The row on the wire, with the matrix the page loaded for it. */
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

/** The grants of a whole page in one query, grouped by role: a list of fifty roles is two statements, never fifty-one. */
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

/** The rows a grant set is, one per allowed action. */
const grantRowsOf = (companyId: string, roleId: string, grants: readonly Grant[]) =>
  grants.flatMap((grant) => grant.actions.map((action) => ({ id: newId(), companyId, roleId, moduleKey: grant.moduleKey, action })))

/** `unique (company_id, name)`: a name is one role's inside a company, and free in the next. */
const NAME_TAKEN = "role_name_key"
const nameTaken = (name: string) => `This company already has a role called ${JSON.stringify(name)}`

const noSuchRole = (id: string) => problem(404, { detail: `No role ${id} in this company` })

export function roleRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/roles",
      describeRoute({
        operationId: "listRoles",
        summary: "The company's roles",
        description:
          "One page of the company's roles, oldest first (ids are time-ordered), each with its whole matrix. Hand `nextCursor` back as `cursor` for the next page; `nextCursor` is null on the last one.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of roles.", RolePage),
          400: describeProblem("The page size is outside 1..200, or the cursor is not one this API wrote."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.access`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", PageRequest),
      async (c) => {
        const { limit, cursor } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const { companyId } = c.get("principal")
        const rows = await tx
          .select(columns)
          .from(role)
          .where(and(eq(role.companyId, companyId), after === undefined ? undefined : gt(role.id, after)))
          .orderBy(asc(role.id))
          .limit(fetchLimit(limit))
        // Paged first, so the row that only proves there is a next page is not
        // one of the roles whose matrix is loaded.
        const { items, nextCursor } = pageOf(rows, limit)
        const byRole = await grantsOf(tx, companyId, items.map((row) => row.id))
        return c.json({ items: items.map((row) => roleOf(row, byRole.get(row.id) ?? [])), nextCursor })
      },
    )
    .post(
      "/roles",
      describeRoute({
        operationId: "createRole",
        summary: "Add a role",
        description:
          "Creates a custom role in the caller's company: the server writes it with no key and `system: false`, since a key belongs to a seeded role. The grants are stored as the system spells them — `edit`, `create` and `delete` imply `view`, a module named twice is merged — and default to none. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The role as it was written.", Role),
          400: describeProblem("The body is missing a field, names one the server owns, or names a module or action outside the vocabulary."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `configure.access`."),
          409: describeProblem("The company already has a role with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", RoleCreate),
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
        return c.json(roleOf(row, grants), 201)
      },
    )
    .get(
      "/roles/:id",
      describeRoute({
        operationId: "getRole",
        summary: "One role",
        description: "One role of the caller's company, with its whole matrix. Another company's role is a role that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The role.", Role),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.access`."),
          404: describeProblem("No role with that id in this company."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const { companyId } = c.get("principal")
        const [row] = await tx
          .select(columns)
          .from(role)
          .where(and(eq(role.companyId, companyId), eq(role.id, id)))
          .limit(1)
        if (row === undefined) throw noSuchRole(id)
        return c.json(await roleWithGrants(tx, companyId, row))
      },
    )
    .patch(
      "/roles/:id",
      describeRoute({
        operationId: "patchRole",
        summary: "Change a role's copy",
        description:
          "Changes the name, the scope or the description, a seeded role's included; every field is optional and at least one must be given. A seeded role's `key` and its `system` flag are not a caller's to change, so the body does not name them, and the matrix is `PUT /roles/{id}/grants`.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The role as it now stands.", Role),
          400: describeProblem("The path does not hold an id, or the patch is empty or names a field the caller does not own."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `configure.access`."),
          404: describeProblem("No role with that id in this company."),
          409: describeProblem("The company already has another role with that name."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", RolePatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const { companyId } = c.get("principal")
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
      describeRoute({
        operationId: "putRoleGrants",
        summary: "Replace a role's matrix",
        description:
          "Replaces the whole matrix with the one in the body: a module the body leaves out is not allowed at all afterwards, and an empty list is a role that may do nothing. The set is stored as the system spells it — `edit`, `create` and `delete` imply `view`, a module named twice is merged — and a revoked grant takes effect on the holder's very next request, since the API looks a caller's grants up on every call. Allowed on a seeded role too: only its key and its `system` flag are its for life.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The role with the matrix it now has.", Role),
          400: describeProblem("The path does not hold an id, or the body is missing `grants`, names a member it does not own, or names a module or action outside the vocabulary."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `configure.access`."),
          404: describeProblem("No role with that id in this company."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", RoleGrants),
      async (c) => {
        const { id } = c.req.valid("param")
        const { grants: asked } = c.req.valid("json")
        const tx = c.get("tx")
        const { companyId } = c.get("principal")
        // The matrix is part of the role on the wire, so replacing it changes
        // the role: the update is what says so — and what answers 404 when
        // there is no such role here. The trigger would stamp `updated_at`
        // whatever this set said; naming it is naming what changed.
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
