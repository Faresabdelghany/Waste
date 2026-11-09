// Who is asking, and the transaction they ask in. The request path of
// ADR-0001 in one middleware (Issue #70): the bearer token is verified
// (verify.ts), its two claims are read — `sub` is the auth user id, and
// `app_metadata.company_id` is the home company the access token hook put
// there — and then everything else happens inside `withCompany(companyId)`
// on the request pool: the account bound to that login, active, in that
// company; its role and the role's grants, normalised through the one rule in
// @waste/domain/access/grants; the projects it works in (all of the company's
// when `all_projects`, else its Project Access rows); its Service Provider or
// none; the active driver profile bound to it or none (Issue #150: what the
// web lands a driver by). That is the Principal, looked up once per request,
// so a revoked grant or a deactivated account is refused on the very next
// call and nothing is cached anywhere.
//
// The API binds the claim to the tenant itself: every lookup below carries
// `company_id = companyId`, and the company in the Principal is the joined
// row's, not the claim's. The tenant fence is the second stop, not the only
// one (ADR-0001: the API is the authority, RLS the backstop), so a pool that
// ever ran as a role with BYPASSRLS, or a table that lost its fence, would
// still refuse company A's account for a company-B claim. Either way a login
// with an account in another company, an unknown `sub`, a `sub` that is not
// even a UUID, a deactivated account and a company that does not exist are
// all the same "no active account here", a 403 with the problem body (a 401
// would say "get a better token", and no token would help). A token with no
// company claim is the hook's "no account at all", also 403. Both carry the
// one problem kind beyond `about:blank`, `NO_ACTIVE_ACCOUNT`
// (@waste/contracts/problem), because it is the account that is refused and
// not the request: a client ends its session on that kind, and on nothing a
// grant refused (require.ts stays `about:blank`).
//
// The handler runs inside that same transaction and receives it as `tx`:
// no handler opens a transaction of its own, so a request's reads and writes
// are one atomic, fenced unit. A route that calls another service is the
// exception, declared `transaction: false` (operation.ts): no transaction may
// be held across that call (#124 §4), so its guard, `identify`, makes the
// same checks through the same function and ends the transaction before the
// handler runs, which opens short ones of its own, each fenced: `transact`
// for rows the audit keeps, written by the Principal as the request's own
// would be, and `fenced` for the rest. Hono answers a thrown error at the
// handler (its compose catches the throw and calls the app's error handler there), so
// the throw never reaches this middleware; what does is `c.error`, set on the
// context when that happened. The transaction is therefore rolled back when
// the context carries an error or the response is an error status, and
// committed otherwise: a request that failed leaves nothing behind, whether
// the handler threw a problem or returned one.
import type { Database, Tx } from "@waste/db/client"
import type { Actor } from "@waste/db/commands/shared"
import { projectAccess, role, roleGrant, userAccount } from "@waste/db/schema/access"
import { driver } from "@waste/db/schema/fleet"
import { company, project, serviceProvider } from "@waste/db/schema/organisation"
import { withCompany } from "@waste/db/tenant"
import { NO_ACTIVE_ACCOUNT } from "@waste/domain/access/accounts"
import type { Grant } from "@waste/domain/access/grants"
import { CHANGE_REASON_HEADER } from "@waste/domain/audit/vocabulary"
import type { DriverStatus } from "@waste/domain/resources/vocabulary"
import { and, asc, eq, isNull } from "drizzle-orm"
import type { MiddlewareHandler } from "hono"

import { grantsOfRows } from "../access-shape"
import { problem } from "../problem"
import { writtenBy } from "./audit"
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
  projects: { id: string; name: string; timezone: string; currency: string }[]
  serviceProvider: { id: string; legalName: string } | null
  /** The driver profile bound to the account (`driver.user_account_id`) while it is `active`; null otherwise. The driver door resolves the whole profile itself (driver.ts). */
  driver: { id: string } | null
}

/** The context variables an authenticated route reads: `c.get("principal")` and `c.get("tx")`, on a `Hono<AuthEnv>`. */
export type AuthEnv = { Variables: { principal: Principal; tx: Tx } }

/** Opens one short transaction under the Principal's company fence. */
export type Transact = <T>(work: (tx: Tx) => Promise<T>) => Promise<T>

/**
 * What a route behind `identify` reads: the principal, and its short
 * transactions, since the guard's ended before the handler (#173) — `transact`
 * for rows the audit keeps, written by the Principal with the request's reason
 * (read as each opens, so a reason that will not do is refused there), and
 * `fenced` for the rest, the reads and the routing quota, which names no
 * writer and reads no reason.
 */
export type IdentifiedEnv = { Variables: { principal: Principal; transact: Transact; fenced: Transact } }

/** Who a shared statement of `@waste/db/commands` acts for when the principal asks: its company, and its account recording the rows. */
export const actorOf = (principal: Principal): Actor => ({ companyId: principal.companyId, userAccountId: principal.user.id })

/** The name of the security scheme in the OpenAPI document, and the requirement every authenticated route declares. */
export const BEARER_AUTH = "bearerAuth"
export const BEARER_SECURITY_SCHEME = { type: "http", scheme: "bearer", bearerFormat: "JWT" } as const
export const BEARER_SECURITY = [{ [BEARER_AUTH]: [] }]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The one driver status a profile drives under; `inactive` and `suspended` land the account as anyone else. */
const ACTIVE_DRIVER: DriverStatus = "active"

/** A project as `/me` names it. */
const PROJECT_SUMMARY = { id: project.id, name: project.name, timezone: project.timezone, currency: project.currency }

/** The hook's claim, `app_metadata.company_id`, when it is there and a UUID; undefined otherwise. */
export function companyIdOf(claims: VerifiedClaims): string | undefined {
  const metadata = claims.app_metadata
  if (typeof metadata !== "object" || metadata === null) return undefined
  const value = (metadata as Record<string, unknown>).company_id
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined
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
  // `user_account.auth_user_id` is a uuid column. A validly signed token whose
  // `sub` is not a UUID is bound to no account here, and it is answered as
  // such: handing it to Postgres would be a 22P02 and a logged 500 for a
  // request that was only ever going to be refused.
  if (!UUID.test(userId)) return null

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
      driverId: driver.id,
    })
    .from(userAccount)
    // The joins spell the composite keys, as the fence already implies them;
    // the where binds the account to the claim's company, which the fence
    // alone would leave to itself. The driver profile rides on the same
    // statement, the claim's company on its join too: at most one profile
    // names an account (the partial unique index on its login), and one that
    // is not active is no driver, so it joins nothing.
    .innerJoin(role, and(eq(role.companyId, userAccount.companyId), eq(role.id, userAccount.roleId)))
    .innerJoin(company, eq(company.id, userAccount.companyId))
    .leftJoin(driver, and(eq(driver.companyId, companyId), eq(driver.userAccountId, userAccount.id), eq(driver.status, ACTIVE_DRIVER)))
    .where(and(eq(userAccount.companyId, companyId), eq(userAccount.authUserId, userId), isNull(userAccount.deactivatedAt)))
    .limit(1)
  if (found === undefined) return null

  const grantRows = await tx
    .select({ moduleKey: roleGrant.moduleKey, action: roleGrant.action })
    .from(roleGrant)
    .where(and(eq(roleGrant.companyId, companyId), eq(roleGrant.roleId, found.roleId)))

  const projects = found.allProjects
    ? await tx.select(PROJECT_SUMMARY).from(project).where(eq(project.companyId, companyId)).orderBy(asc(project.name))
    : await tx
        .select(PROJECT_SUMMARY)
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
    // One spelling of "these rows, as the set they grant", shared with the
    // role routes: a row outside the vocabulary grants nothing (access-shape.ts).
    grants: grantsOfRows(grantRows),
    projects,
    serviceProvider: provider ?? null,
    driver: found.driverId === null ? null : { id: found.driverId },
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
 * The checks both guards make, spelled once so the two cannot drift: 401
 * without a usable token, 403 without a company claim, and — inside the
 * transaction `withCompany` opens for the claim's company — 403 without an
 * active account there; then `within` runs in that transaction with the
 * Principal, and whatever it throws rolls it back.
 */
async function guard(authorization: string | undefined, { pool, verifier }: AuthenticateOptions, within: (principal: Principal, tx: Tx) => Promise<void>): Promise<void> {
  const header = bearerToken(authorization)
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
    throw problem(403, { kind: NO_ACTIVE_ACCOUNT, detail: "The token names no company: this login has no account here" })
  }
  await withCompany(pool.db, companyId, async (tx) => {
    const principal = await resolvePrincipal(tx, { userId: verified.claims.sub, companyId })
    if (principal === null) {
      throw problem(403, { kind: NO_ACTIVE_ACCOUNT, detail: "No active account in this company is bound to this login" })
    }
    await within(principal, tx)
  })
}

/**
 * The guard an authenticated route puts before its handler: the checks
 * above, and then the handler runs inside the request's fenced transaction
 * with `principal` and `tx` set on the context.
 */
export function authenticate(options: AuthenticateOptions): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    try {
      await guard(c.req.header("authorization"), options, async (principal, tx) => {
        // The audit trail's writer (#291): the Principal, never the client's word, and the reason the request gives.
        await writtenBy(tx, principal, c.req.header(CHANGE_REASON_HEADER))
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

/**
 * The guard of a route that calls another service (`transaction: false`):
 * the same checks, the Principal resolved in a transaction that ends before
 * the handler runs, so no transaction is held open across the call (#124 §4)
 * and no pooled connection sits idle through it. The handler reads
 * `principal` and no `tx`, and opens the short transactions it needs through
 * `transact` or `fenced`, none of them across the call.
 */
export function identify(options: AuthenticateOptions): MiddlewareHandler<IdentifiedEnv> {
  return async (c, next) => {
    let resolved: Principal | undefined
    await guard(c.req.header("authorization"), options, async (principal) => {
      resolved = principal
    })
    if (resolved === undefined) throw new Error("identify: the guard answered without a principal")
    const principal = resolved
    c.set("principal", principal)
    c.set("transact", (work) =>
      withCompany(options.pool.db, principal.companyId, async (tx) => {
        await writtenBy(tx, principal, c.req.header(CHANGE_REASON_HEADER))
        return await work(tx)
      }),
    )
    c.set("fenced", (work) => withCompany(options.pool.db, principal.companyId, work))
    await next()
  }
}
