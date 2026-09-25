// The company's user accounts: who may sign in here, as whom, and what they
// reach. `GET /users` lists them a page at a time, `POST /users` invites one,
// `GET /users/:id` reads one, `PATCH /users/:id` changes one, and three
// commands switch an account off, on again, and make it the primary
// administrator. There is no delete: an account that has worked has routes,
// tickets and weights behind it, and taking away its access is what "remove a
// user" means (Supabase's auth user is theirs to delete, not ours — the API
// holds no service key).
//
// An invitation writes the account with no login bound, so its status is
// `invited`; the invitation e-mail itself is Supabase's. The e-mail is
// lowercased here, before the database sees it, because the access token hook
// binds by `lower(claims.email)` and the column's check is the backstop, not
// the rule. The status on the wire is derived from the row and never stored
// (access-shape.ts).
//
// What an account reaches is exactly one of three things — every project, the
// projects it is given, or one Service Provider — and a change replaces the
// whole shape inside the request's transaction, in the one order the keys
// allow: the Service Provider Access row goes before `service_provider_id` is
// cleared, and `service_provider_id` is set before the new row arrives,
// because that key is `(company_id, user_account_id, service_provider_id) →
// user_account (company_id, id, service_provider_id)` — a grant can only name
// the provider the account belongs to.
//
// The primary administrator is the tenant's last way in: it cannot be
// deactivated, moved to another role, or narrowed to some projects or to a
// provider. Each is a 409 with a sentence stating the rule, because the
// request is well-formed and would be fine against another account. The flag
// itself moves through one command, `POST /users/:id/make-primary-administrator`
// (Issue #73), to an account that is active and reaches every project; the
// partial unique index allows one holder per company, so the command takes
// the flag off the old holder before it puts it on the new one, in one
// transaction under the company's row lock.
//
// A body naming a role, a project or a provider that is not this company's is
// a 400 on that field, not a 500 from a foreign key: the fence hides the
// other company's row, so "it is not yours" and "it does not exist" are the
// same answer here. Every statement carries `company_id = the caller's`
// beside the fence (ADR-0001: the API is the authority, RLS the backstop).
//
// The grant is `configure.access`, the one Settings → Users, Roles & Teams
// surface: `view` to look, `create` to invite, `edit` to change, deactivate,
// reactivate or move the primary administrator's flag — `edit` and not the
// primary administrator alone, because the flag usually moves when its holder
// has left, and whoever is left must be able to move it before they can
// deactivate them.
import { User, UserInvite, UserPatch } from "@waste/contracts/access"
import { Page, PageRequest } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { projectAccess, role, serviceProviderAccess, userAccount } from "@waste/db/schema/access"
import { company, project, serviceProvider } from "@waste/db/schema/organisation"
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { accessColumns, accessOf, uniqueIds, userStatus, type AccessShape } from "../access-shape"
import { BEARER_SECURITY, type AuthEnv } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { created, describeCreated, describeJson, IdParam, lockRow, refuseDuplicate, stampsOf } from "./shared"

const MODULE = "configure.access"
const UserPage = Page(User)

const columns = {
  id: userAccount.id,
  email: userAccount.email,
  fullName: userAccount.fullName,
  roleId: userAccount.roleId,
  allProjects: userAccount.allProjects,
  serviceProviderId: userAccount.serviceProviderId,
  primaryAdministrator: userAccount.primaryAdministrator,
  deactivatedAt: userAccount.deactivatedAt,
  // Not on the wire, and read for one reason: with `deactivated_at` it is the
  // status (access-shape.ts). Who the login is stays between us and Supabase.
  authUserId: userAccount.authUserId,
  createdAt: userAccount.createdAt,
  updatedAt: userAccount.updatedAt,
}

type Row = Pick<typeof userAccount.$inferSelect, keyof typeof columns>

/** The row on the wire, with the Project Access rows the page loaded for it. */
function userOf(row: Row, projectIds: string[]): User {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    status: userStatus(row),
    roleId: row.roleId,
    allProjects: row.allProjects,
    projectIds,
    serviceProviderId: row.serviceProviderId,
    primaryAdministrator: row.primaryAdministrator,
    deactivatedAt: row.deactivatedAt === null ? null : row.deactivatedAt.toISOString(),
    ...stampsOf(row),
  }
}

/**
 * The Project Access of a whole page in one query, grouped by account: a list
 * of fifty users is two statements, never fifty-one.
 */
async function projectIdsOf(tx: Tx, companyId: string, userIds: readonly string[]): Promise<Map<string, string[]>> {
  const byUser = new Map<string, string[]>()
  if (userIds.length === 0) return byUser
  const rows = await tx
    .select({ userAccountId: projectAccess.userAccountId, projectId: projectAccess.projectId })
    .from(projectAccess)
    .where(and(eq(projectAccess.companyId, companyId), inArray(projectAccess.userAccountId, [...userIds])))
    .orderBy(asc(projectAccess.projectId))
  for (const row of rows) {
    const found = byUser.get(row.userAccountId)
    if (found === undefined) byUser.set(row.userAccountId, [row.projectId])
    else found.push(row.projectId)
  }
  return byUser
}

/** One account on the wire, its access read back the way a page reads it, so an answer equals the next read. */
async function userWithAccess(tx: Tx, companyId: string, row: Row): Promise<User> {
  const byUser = await projectIdsOf(tx, companyId, [row.id])
  return userOf(row, byUser.get(row.id) ?? [])
}

/** `unique (company_id, email)`: an address is one account's inside a company, and free in the next. */
const EMAIL_TAKEN = "user_account_email_key"
const emailTaken = (email: string) => `This company already has a user with the e-mail address ${JSON.stringify(email)}`

const noSuchUser = (id: string) => problem(404, { detail: `No user ${id} in this company` })

/** One account of this company by id, or undefined; the read every route here starts with. */
async function findUser(tx: Tx, companyId: string, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(userAccount)
    .where(and(eq(userAccount.companyId, companyId), eq(userAccount.id, id)))
    .limit(1)
  return row
}

// The three refusals state the rule and stop there: which account should hold
// the flag instead is the company's decision, made through the command below.
const PRIMARY_DEACTIVATE = "The primary administrator cannot be deactivated: it is the company's last way in"
const PRIMARY_ROLE = "The primary administrator cannot be moved to another role"
const PRIMARY_ACCESS =
  "The primary administrator reaches every project: it cannot be narrowed to some projects or to a service provider"

// What the flag may not move to, each its own sentence, since each is fixed a
// different way — reactivate it, wait for its first sign-in, widen its access
// — or by picking another account. The last is PRIMARY_ACCESS read from the
// other side: a transfer must not produce the account a patch refuses to make.
const TARGET_DEACTIVATED = "A deactivated account cannot be the primary administrator: it is the company's last way in, and this one is switched off"
const TARGET_INVITED = "An account nobody has signed in as cannot be the primary administrator: the company's last way in has to be a login that works"
const TARGET_PROVIDER = "A service provider's account cannot be the primary administrator: it reaches its provider, not the company"
const TARGET_NARROW = "The primary administrator reaches every project: give the account every project before making it the primary administrator"

/** A 400 in the shape the validator's would have, for what only the database could tell us. */
const unknownReference = (errors: { path: string; message: string }[]) => problem(400, { detail: "The request body is invalid", errors })

async function requireRole(tx: Tx, companyId: string, roleId: string): Promise<void> {
  const [found] = await tx
    .select({ id: role.id })
    .from(role)
    .where(and(eq(role.companyId, companyId), eq(role.id, roleId)))
    .limit(1)
  if (found === undefined) throw unknownReference([{ path: "roleId", message: `No role ${roleId} in this company` }])
}

/** Every project the body named must be this company's; the ones that are not are named by their place in the list. */
async function requireProjects(tx: Tx, companyId: string, projectIds: readonly string[]): Promise<void> {
  const rows = await tx
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.companyId, companyId), inArray(project.id, [...projectIds])))
  const known = new Set(rows.map((row) => row.id))
  const errors = projectIds.flatMap((id, index) =>
    known.has(id) ? [] : [{ path: `projectIds.${index}`, message: `No project ${id} in this company` }],
  )
  if (errors.length > 0) throw unknownReference(errors)
}

async function requireProvider(tx: Tx, companyId: string, serviceProviderId: string): Promise<void> {
  const [found] = await tx
    .select({ id: serviceProvider.id })
    .from(serviceProvider)
    .where(and(eq(serviceProvider.companyId, companyId), eq(serviceProvider.id, serviceProviderId)))
    .limit(1)
  if (found === undefined) {
    throw unknownReference([{ path: "serviceProviderId", message: `No service provider ${serviceProviderId} in this company` }])
  }
}

/** What the access shape points at must be this company's, checked before anything is written. */
async function requireAccess(tx: Tx, companyId: string, shape: AccessShape): Promise<void> {
  if (shape.kind === "projects") await requireProjects(tx, companyId, shape.projectIds)
  if (shape.kind === "provider") await requireProvider(tx, companyId, shape.serviceProviderId)
}

/**
 * The account's access rows, gone. The Service Provider Access goes first
 * because the account's `service_provider_id` is half of the key it hangs on,
 * and clearing that column with the row still there is a foreign-key
 * violation, not a cascade.
 */
async function clearAccess(tx: Tx, companyId: string, userAccountId: string): Promise<void> {
  await tx
    .delete(serviceProviderAccess)
    .where(and(eq(serviceProviderAccess.companyId, companyId), eq(serviceProviderAccess.userAccountId, userAccountId)))
  await tx.delete(projectAccess).where(and(eq(projectAccess.companyId, companyId), eq(projectAccess.userAccountId, userAccountId)))
}

/** The access rows for the shape, written after the account's own columns say the same thing; a project named twice is one row. */
async function writeAccess(tx: Tx, companyId: string, userAccountId: string, shape: AccessShape): Promise<void> {
  if (shape.kind === "projects") {
    await tx
      .insert(projectAccess)
      .values(uniqueIds(shape.projectIds).map((projectId) => ({ id: newId(), companyId, userAccountId, projectId })))
  }
  if (shape.kind === "provider") {
    await tx
      .insert(serviceProviderAccess)
      .values({ id: newId(), companyId, userAccountId, serviceProviderId: shape.serviceProviderId })
  }
}

export function userRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/users",
      describeRoute({
        operationId: "listUsers",
        summary: "The company's users",
        description:
          "One page of the company's user accounts, oldest first (ids are time-ordered), each with its derived status and the projects it works in. Hand `nextCursor` back as `cursor` for the next page; `nextCursor` is null on the last one.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of users.", UserPage),
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
          .from(userAccount)
          .where(and(eq(userAccount.companyId, companyId), after === undefined ? undefined : gt(userAccount.id, after)))
          .orderBy(asc(userAccount.id))
          .limit(fetchLimit(limit))
        // Paged first, so the row that only proves there is a next page is not
        // one of the accounts whose access is loaded.
        const { items, nextCursor } = pageOf(rows, limit)
        const byUser = await projectIdsOf(tx, companyId, items.map((row) => row.id))
        return c.json({ items: items.map((row) => userOf(row, byUser.get(row.id) ?? [])), nextCursor })
      },
    )
    .post(
      "/users",
      describeRoute({
        operationId: "inviteUser",
        summary: "Invite a user",
        description:
          "Creates an account in the caller's company with no login bound, so its status is `invited` until the person signs in; the invitation e-mail itself is Supabase's. The body names exactly one of `allProjects: true`, `projectIds` or `serviceProviderId`: a company user takes Project Access and no provider, a provider user the reverse. The e-mail is stored lowercase. The server mints the id; a body that carries one is refused.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The account as it was written.", User),
          400: describeProblem(
            "The body is missing a field, names none or more than one way of reaching something, or names a role, project or service provider that is not this company's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `configure.access`."),
          409: describeProblem("The company already has a user with that e-mail address."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", UserInvite),
      async (c) => {
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const { companyId } = c.get("principal")
        const shape = accessOf(values)
        if (shape === undefined) throw new Error("an invitation names one way of reaching something: the contracts hold it to that")
        await requireRole(tx, companyId, values.roleId)
        await requireAccess(tx, companyId, shape)

        const email = values.email.toLowerCase()
        const id = newId()
        const [row] = await refuseDuplicate({ [EMAIL_TAKEN]: emailTaken(email) }, () =>
          tx
            .insert(userAccount)
            .values({
              id,
              companyId,
              authUserId: null,
              email,
              fullName: values.fullName,
              roleId: values.roleId,
              ...accessColumns(shape),
            })
            .returning(columns),
        )
        await writeAccess(tx, companyId, id, shape)
        return created(c, "/users", await userWithAccess(tx, companyId, row))
      },
    )
    .get(
      "/users/:id",
      describeRoute({
        operationId: "getUser",
        summary: "One user",
        description: "One account of the caller's company. Another company's account is an account that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The user.", User),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.access`."),
          404: describeProblem("No user with that id in this company."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const { companyId } = c.get("principal")
        const row = await findUser(tx, companyId, id)
        if (row === undefined) throw noSuchUser(id)
        return c.json(await userWithAccess(tx, companyId, row))
      },
    )
    .patch(
      "/users/:id",
      describeRoute({
        operationId: "patchUser",
        summary: "Change a user",
        description:
          "Changes the account's name, its role, or what it reaches; every field is optional and at least one must be given. An access change names exactly one of `allProjects: true`, `projectIds` or `serviceProviderId` and replaces the whole shape: the old Project Access or Service Provider Access rows go and the new ones arrive in the same transaction. A patch that names none of the three leaves the access alone. The e-mail is the invitation's and the status is derived, so neither can be patched. The primary administrator cannot be moved to another role or narrowed (409).",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The user as it now stands.", User),
          400: describeProblem(
            "The path does not hold an id, or the patch is empty, names a field the caller does not own, names two ways of reaching something, or names a role, project or service provider that is not this company's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `configure.access`."),
          404: describeProblem("No user with that id in this company."),
          409: describeProblem("The account is the primary administrator: its role and its reach over every project stand."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", UserPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const { companyId } = c.get("principal")

        // The primary administrator's rules are the API's, read first and
        // written after, so the row is locked before the read: a transfer in
        // flight to this very account has committed by the time it is read,
        // and the account is refused as the primary administrator it now is
        // (routes/shared.ts on why a rule the API holds needs the lock).
        await lockRow(tx, userAccount, { companyId, id })
        const current = await findUser(tx, companyId, id)
        if (current === undefined) throw noSuchUser(id)

        const shape = accessOf(patch)
        if (current.primaryAdministrator) {
          if (patch.roleId !== undefined && patch.roleId !== current.roleId) throw problem(409, { detail: PRIMARY_ROLE })
          if (shape !== undefined && shape.kind !== "all-projects") throw problem(409, { detail: PRIMARY_ACCESS })
        }
        if (patch.roleId !== undefined) await requireRole(tx, companyId, patch.roleId)
        if (shape !== undefined) await requireAccess(tx, companyId, shape)

        // The old rows first, then the account's own columns, then the new
        // rows: the Service Provider Access key spans both sides.
        if (shape !== undefined) await clearAccess(tx, companyId, id)
        const [row] = await tx
          .update(userAccount)
          .set({
            ...(patch.fullName === undefined ? {} : { fullName: patch.fullName }),
            ...(patch.roleId === undefined ? {} : { roleId: patch.roleId }),
            ...(shape === undefined ? {} : accessColumns(shape)),
          })
          .where(and(eq(userAccount.companyId, companyId), eq(userAccount.id, id)))
          .returning(columns)
        if (row === undefined) throw noSuchUser(id)
        if (shape !== undefined) await writeAccess(tx, companyId, id, shape)
        return c.json(await userWithAccess(tx, companyId, row))
      },
    )
    .post(
      "/users/:id/deactivate",
      describeRoute({
        operationId: "deactivateUser",
        summary: "Switch a user off",
        description:
          "Stamps `deactivatedAt`, so the account's status is `deactivated` and the next request it makes is refused — the API looks a caller up on every call, so the refusal is immediate. Its role, its grants and its access rows are left as they are, and reactivating gives them back. An account that is already deactivated answers 200 with the instant it was switched off, unchanged. The primary administrator cannot be deactivated (409).",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The user, deactivated.", User),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `configure.access`."),
          404: describeProblem("No user with that id in this company."),
          409: describeProblem("The account is the primary administrator: it is the company's last way in."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const { companyId } = c.get("principal")
        // Locked before it is read, for the same reason as the patch above.
        await lockRow(tx, userAccount, { companyId, id })
        const current = await findUser(tx, companyId, id)
        if (current === undefined) throw noSuchUser(id)
        if (current.primaryAdministrator) throw problem(409, { detail: PRIMARY_DEACTIVATE })
        if (current.deactivatedAt !== null) return c.json(await userWithAccess(tx, companyId, current))

        const [row] = await tx
          .update(userAccount)
          .set({ deactivatedAt: sql`now()` })
          .where(and(eq(userAccount.companyId, companyId), eq(userAccount.id, id)))
          .returning(columns)
        if (row === undefined) throw noSuchUser(id)
        return c.json(await userWithAccess(tx, companyId, row))
      },
    )
    .post(
      "/users/:id/reactivate",
      describeRoute({
        operationId: "reactivateUser",
        summary: "Switch a user on again",
        description:
          "Clears `deactivatedAt`. The account is `active` again, or `invited` if nobody ever signed in as it; its role and access rows were never touched. An account that is already active answers 200 unchanged.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The user, active again.", User),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `configure.access`."),
          404: describeProblem("No user with that id in this company."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const { companyId } = c.get("principal")
        const current = await findUser(tx, companyId, id)
        if (current === undefined) throw noSuchUser(id)
        if (current.deactivatedAt === null) return c.json(await userWithAccess(tx, companyId, current))

        const [row] = await tx
          .update(userAccount)
          .set({ deactivatedAt: null })
          .where(and(eq(userAccount.companyId, companyId), eq(userAccount.id, id)))
          .returning(columns)
        if (row === undefined) throw noSuchUser(id)
        return c.json(await userWithAccess(tx, companyId, row))
      },
    )
    .post(
      "/users/:id/make-primary-administrator",
      describeRoute({
        operationId: "makePrimaryAdministrator",
        summary: "Make a user the primary administrator",
        description:
          "Moves the primary administrator's flag to this account and takes it off the one that carried it, in the request's one transaction under the company's row lock, so two transfers at once take turns and the company never has two or none. The account must be active — signed in as at least once and not deactivated — and must reach every project: a service provider's account, or one given some projects only, is refused (409), because the primary administrator is the company's last way in and reaches all of it. An account that already is the primary administrator answers 200 unchanged. The grant is `edit` on `configure.access` rather than the primary administrator's alone: the flag usually moves because its holder has left, and another administrator has to be able to move it before deactivating them.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The user, now the primary administrator.", User),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `configure.access`."),
          404: describeProblem("No user with that id in this company."),
          409: describeProblem(
            "The account is deactivated, has never been signed in as, belongs to a service provider, or reaches some projects only.",
          ),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const { companyId } = c.get("principal")

        // One primary administrator per company is the company's rule, so its
        // row is the lock two transfers serialise on: the second waits, then
        // reads what the first wrote. The target's own lock follows, from the
        // top down, so a deactivation or a patch of it in flight has finished
        // before the flag moves (both take that same lock before they read).
        await lockRow(tx, company, { companyId, id: companyId })
        await lockRow(tx, userAccount, { companyId, id })
        const current = await findUser(tx, companyId, id)
        if (current === undefined) throw noSuchUser(id)
        if (current.primaryAdministrator) return c.json(await userWithAccess(tx, companyId, current))
        if (current.deactivatedAt !== null) throw problem(409, { detail: TARGET_DEACTIVATED })
        if (current.authUserId === null) throw problem(409, { detail: TARGET_INVITED })
        if (current.serviceProviderId !== null) throw problem(409, { detail: TARGET_PROVIDER })
        if (!current.allProjects) throw problem(409, { detail: TARGET_NARROW })

        // Off the holder first, on the target second, as two statements: the
        // partial unique index checks each row as it is written, so one
        // statement over both rows, or the other order, would trip it.
        await tx
          .update(userAccount)
          .set({ primaryAdministrator: false })
          .where(and(eq(userAccount.companyId, companyId), eq(userAccount.primaryAdministrator, true)))
        const [row] = await tx
          .update(userAccount)
          .set({ primaryAdministrator: true })
          .where(and(eq(userAccount.companyId, companyId), eq(userAccount.id, id)))
          .returning(columns)
        if (row === undefined) throw noSuchUser(id)
        return c.json(await userWithAccess(tx, companyId, row))
      },
    )
}
