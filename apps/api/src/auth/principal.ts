// Who is asking, and the transaction they ask in. The request path of
// ADR-0001 in one middleware (Issue #70): the bearer token is verified
// (verify.ts), its two claims are read — `sub` is the auth user id, and
// `app_metadata.company_id` is the home company the access token hook put
// there — and then everything else happens inside `withCompany(companyId)`
// on the request pool: the account bound to that login, active, in that
// company; its role and the role's grants, normalised through the one rule in
// @waste/domain/access/grants; the projects it works in (all of the company's
// when `all_projects`, else its Project Access rows); its Service Provider or
// none. That is the Principal, looked up once per request, so a revoked grant
// or a deactivated account is refused on the very next call and nothing is
// cached anywhere.
//
// The API binds the claim to the tenant itself: every lookup below carries
// `company_id = companyId`, and the company in the Principal is the joined
// row's, not the claim's. The tenant fence is the second stop, not the only
// one (ADR-0001: the API is the authority, RLS the backstop), so a pool that
// ever ran as a role with BYPASSRLS, or a table that lost its fence, would
// still refuse company A's account for a company-B claim. Either way a login
// with an account in another company, an unknown `sub`, a deactivated account
// and a company that does not exist are all the same "no active account
// here", a 403 with the problem body (a 401 would say "get a better token",
// and no token would help). A token with no company claim is the hook's "no
// account at all", also 403.
//
// The handler runs inside that same transaction and receives it as `tx`:
// no handler opens a transaction of its own, so a request's reads and writes
// are one atomic, fenced unit. Hono answers a thrown error at the handler
// (its compose catches the throw and calls the app's error handler there), so
// the throw never reaches this middleware; what does is `c.error`, set on the
// context when that happened. The transaction is therefore rolled back when
// the context carries an error or the response is an error status, and
// committed otherwise: a request that failed leaves nothing behind, whether
// the handler threw a problem or returned one.
import type { Database, Tx } from "@waste/db/client"
import { projectAccess, role, roleGrant, userAccount } from "@waste/db/schema/access"
import { company, project, serviceProvider } from "@waste/db/schema/organisation"
import { withCompany } from "@waste/db/tenant"
import { normaliseGrants, type Grant } from "@waste/domain/access/grants"
import { ACTIONS, MODULE_KEYS } from "@waste/domain/access/modules"
import { and, asc, eq, isNull } from "drizzle-orm"
import type { MiddlewareHandler } from "hono"

import { problem } from "../problem"
import { bearerToken, type VerifiedClaims, type Verifier } from "./verify"

export type Principal = {
  /** The auth user id: the token's `sub`, what `user_account.auth_user_id` is bound to. */
  userId: string
  /** The home company from the token, and the company the request's transaction is set to. */
  companyId: string
  user: { id: string; email: string; fullName: string; allProjects: boolean; primaryAdministrator: boolean }
  company: { id: string; name: string }
  role: { id: string; key: string | null; name: string; scope: string; system: boolean }
  /** Normalised (`view` wherever anything else is granted, one entry per module, sorted): what requireGrant reads. */
  grants: Grant[]
  /** Sorted by name; every project of the company when `user.allProjects`. */
  projects: { id: string; name: string }[]
  serviceProvider: { id: string; legalName: string } | null
}

/** The context variables an authenticated route reads: `c.get("principal")` and `c.get("tx")`, on a `Hono<AuthEnv>`. */
export type AuthEnv = { Variables: { principal: Principal; tx: Tx } }

/** The name of the security scheme in the OpenAPI document, and the requirement every authenticated route declares. */
export const BEARER_AUTH = "bearerAuth"
export const BEARER_SECURITY_SCHEME = { type: "http", scheme: "bearer", bearerFormat: "JWT" } as const
export const BEARER_SECURITY = [{ [BEARER_AUTH]: [] }]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The hook's claim, `app_metadata.company_id`, when it is there and a UUID; undefined otherwise. */
export function companyIdOf(claims: VerifiedClaims): string | undefined {
  const metadata = claims.app_metadata
  if (typeof metadata !== "object" || metadata === null) return undefined
  const value = (metadata as Record<string, unknown>).company_id
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined
}

const MODULE_KEY_SET: ReadonlySet<string> = new Set(MODULE_KEYS)
const ACTION_SET: ReadonlySet<string> = new Set(ACTIONS)

/**
 * The role's grant rows as a normalised grant set. A row naming a module or
 * an action the vocabulary no longer has grants nothing: there is no surface
 * with that key to reach.
 */
function grantsOf(rows: readonly { moduleKey: string; action: string }[]): Grant[] {
  return normaliseGrants(
    rows.flatMap((row) =>
      MODULE_KEY_SET.has(row.moduleKey) && ACTION_SET.has(row.action)
        ? [{ moduleKey: row.moduleKey as Grant["moduleKey"], actions: [row.action as Grant["actions"][number]] }]
        : [],
    ),
  )
}

export type Login = {
  /** The token's `sub`. */
  userId: string
  companyId: string
}

/**
 * The Principal for a login, inside a transaction `withCompany` opened for
 * the claim's company; null when that company holds no active account bound
 * to the login.
 */
export async function resolvePrincipal(tx: Tx, { userId, companyId }: Login): Promise<Principal | null> {
  const [found] = await tx
    .select({
      id: userAccount.id,
      email: userAccount.email,
      fullName: userAccount.fullName,
      allProjects: userAccount.allProjects,
      primaryAdministrator: userAccount.primaryAdministrator,
      serviceProviderId: userAccount.serviceProviderId,
      roleId: role.id,
      roleKey: role.key,
      roleName: role.name,
      roleScope: role.scope,
      roleSystem: role.system,
      companyId: company.id,
      companyName: company.name,
    })
    .from(userAccount)
    // The joins spell the composite keys, as the fence already implies them;
    // the where binds the account to the claim's company, which the fence
    // alone would leave to itself.
    .innerJoin(role, and(eq(role.companyId, userAccount.companyId), eq(role.id, userAccount.roleId)))
    .innerJoin(company, eq(company.id, userAccount.companyId))
    .where(and(eq(userAccount.companyId, companyId), eq(userAccount.authUserId, userId), isNull(userAccount.deactivatedAt)))
    .limit(1)
  if (found === undefined) return null

  const grantRows = await tx
    .select({ moduleKey: roleGrant.moduleKey, action: roleGrant.action })
    .from(roleGrant)
    .where(and(eq(roleGrant.companyId, companyId), eq(roleGrant.roleId, found.roleId)))

  const projects = found.allProjects
    ? await tx.select({ id: project.id, name: project.name }).from(project).where(eq(project.companyId, companyId)).orderBy(asc(project.name))
    : await tx
        .select({ id: project.id, name: project.name })
        .from(projectAccess)
        .innerJoin(project, and(eq(project.companyId, projectAccess.companyId), eq(project.id, projectAccess.projectId)))
        .where(and(eq(projectAccess.companyId, companyId), eq(projectAccess.userAccountId, found.id)))
        .orderBy(asc(project.name))

  const [provider] =
    found.serviceProviderId === null
      ? []
      : await tx
          .select({ id: serviceProvider.id, legalName: serviceProvider.legalName })
          .from(serviceProvider)
          .where(and(eq(serviceProvider.companyId, companyId), eq(serviceProvider.id, found.serviceProviderId)))
          .limit(1)

  return {
    userId,
    companyId: found.companyId,
    user: {
      id: found.id,
      email: found.email,
      fullName: found.fullName,
      allProjects: found.allProjects,
      primaryAdministrator: found.primaryAdministrator,
    },
    company: { id: found.companyId, name: found.companyName },
    role: { id: found.roleId, key: found.roleKey, name: found.roleName, scope: found.roleScope, system: found.roleSystem },
    grants: grantsOf(grantRows),
    projects,
    serviceProvider: provider ?? null,
  }
}

export type AuthenticateOptions = {
  /** The request pool, as the API role; every authenticated request is one of its transactions. */
  pool: Database
  verifier: Verifier
}

/** Thrown out of the transaction to roll it back when the response is already decided; never an Error, so nothing logs it. */
class Discard {}

const CHALLENGE = "Bearer"
const CHALLENGE_INVALID_REQUEST = 'Bearer error="invalid_request"'
const CHALLENGE_INVALID_TOKEN = 'Bearer error="invalid_token"'

/**
 * The guard an authenticated route puts before its handler: 401 without a
 * usable token, 403 without an active account in the claimed company, and
 * otherwise the handler runs inside the request's fenced transaction with
 * `principal` and `tx` set on the context.
 */
export function authenticate({ pool, verifier }: AuthenticateOptions): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const header = bearerToken(c.req.header("authorization"))
    if (header.kind === "absent") {
      throw problem(401, {
        detail: "This route needs a signed-in user: send `Authorization: Bearer <access token>`",
        headers: { "www-authenticate": CHALLENGE },
      })
    }
    if (header.kind === "malformed") {
      throw problem(401, { detail: header.detail, headers: { "www-authenticate": CHALLENGE_INVALID_REQUEST } })
    }
    const verified = await verifier(header.token)
    if (!verified.ok) {
      throw problem(401, { detail: verified.refusal.detail, headers: { "www-authenticate": CHALLENGE_INVALID_TOKEN } })
    }
    const companyId = companyIdOf(verified.claims)
    if (companyId === undefined) {
      throw problem(403, { detail: "The token names no company: this login has no account here" })
    }

    try {
      await withCompany(pool.db, companyId, async (tx) => {
        const principal = await resolvePrincipal(tx, { userId: verified.claims.sub, companyId })
        if (principal === null) {
          throw problem(403, { detail: "No active account in this company is bound to this login" })
        }
        c.set("principal", principal)
        c.set("tx", tx)
        await next()
        if (c.error !== undefined || c.res.status >= 400) throw new Discard()
      })
    } catch (error) {
      if (!(error instanceof Discard)) throw error
    }
  }
}
