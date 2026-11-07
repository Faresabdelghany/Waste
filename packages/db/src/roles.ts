// The database roles, each with the facts every operation on roles selects
// by: bootstrap and grant-logins give LOGIN to the roles a URL of their own
// logs in as, the write barrier and recover-logins switch off and back the
// ones it names, the Pilot's state check reports the logins and holds the
// ones that must always log in, and the fingerprint records the roles the
// migrations create. A role added here is in every one of those lists by
// what it says, and `roles.test.ts` holds the table to the migration files.
//
// Migrations run as the owner (whoever the admin URL logs in as: `postgres`
// on Supabase); the API connects as API_ROLE, which owns nothing and
// bypasses nothing, so every row-level policy applies to it; the worker's
// pg-boss connects as WORKER_ROLE (Issue #97 part B), which carries
// BYPASSRLS for the one kind of statement in the system that reads across
// tenants, a sweep for work to do, and SELECT on every wms table and no
// write right on any (sql/pgboss.ts) but DELETE on the one ledger whose
// retention its purge holds, `session_position` (sql/retention-purge.ts, O8
// of #290) — every other write the worker makes runs as API_ROLE under
// `withCompany`, fenced like a request's; the public door's anonymous reads
// run as PUBLIC_ROLE (Issue #293, ADR-0010), which logs in as nobody — the
// API's connection sets it for a public request's transaction alone — and
// SELECTs exactly the columns the tables' `door` declarations name, under
// policies of its own. Spelled once here, so a URL cannot retarget a
// statement meant for one role at some other role.
import { SESSION_POOLER_PORT } from "@waste/process/ports"

import { poolerUser, SUPABASE_DATABASE } from "./supabase"

export const API_ROLE = "wms_api"
export const WORKER_ROLE = "wms_worker"
export const PUBLIC_ROLE = "wms_public"

/** A role name a statement may splice in: lowercase letters, digits and underscores, never quoted. */
export const PLAIN_ROLE = /^[a-z_][a-z0-9_]*$/

/** The variables whose URL logs in as a role: the one the local stack and CI set, and the `pilot` environment's secret. */
export type RoleUrls = { readonly local: string; readonly pilot: string }

/**
 * How a role logs in:
 * - `owner`: through the admin URL, which runs the migrations and every owner
 *   operation; nothing here grants or removes its login;
 * - `always`: wherever the API runs, from its own URL, so on the Pilot a
 *   NOLOGIN is a write barrier an earlier run left closed;
 * - `where-set`: where its own URL is set, an environment that runs none of
 *   its processes giving it no login;
 * - `never`: another role SETs it, and nothing grants it a login.
 */
export type RoleLogin = "owner" | "always" | "where-set" | "never"

type Facts = {
  readonly name: string
  /** Whether the write barrier sets it NOLOGIN while a restore or a reset-to-seed runs, and recover-logins gives its login back. */
  readonly barrier: boolean
  /** Whether the fingerprint records its attributes, settings and memberships: every role the migrations create. */
  readonly fingerprint: boolean
}
/** A role a URL logs in as: the owner, or one bootstrap and grant-logins give LOGIN. */
export type LoginRole = Facts & { readonly login: Exclude<RoleLogin, "never">; readonly urls: RoleUrls }
export type DatabaseRole = LoginRole | (Facts & { readonly login: "never" })

/** The admin URL's role. */
export const OWNER: LoginRole = { name: "postgres", login: "owner", urls: { local: "DATABASE_ADMIN_URL", pilot: "PILOT_DATABASE_ADMIN_URL" }, barrier: false, fingerprint: false }

export const DATABASE_ROLES: readonly DatabaseRole[] = [
  OWNER,
  { name: API_ROLE, login: "always", urls: { local: "DATABASE_URL", pilot: "PILOT_DATABASE_URL" }, barrier: true, fingerprint: true },
  { name: WORKER_ROLE, login: "where-set", urls: { local: "WORKER_DATABASE_URL", pilot: "PILOT_WORKER_DATABASE_URL" }, barrier: true, fingerprint: true },
  { name: PUBLIC_ROLE, login: "never", barrier: false, fingerprint: true },
]

/** The roles bootstrap and grant-logins give LOGIN from a URL of their own, and the state check reports. */
export const GRANTED_ROLES: readonly LoginRole[] = DATABASE_ROLES.filter((role): role is LoginRole => role.login === "always" || role.login === "where-set")

/** What the Pilot's URLs are held to, beside their roles: the Supabase project and the session pooler's host. */
export type PilotTarget = { ref: string; host: string }

/**
 * The password a role's URL carries, from the variable the table names for
 * it: locally its `local` variable, held to the role alone; with `pilot`, its
 * `pilot` secret, held as well to the Pilot's session pooler, its Supabase
 * project and the `postgres` database. Every refusal names the variable and
 * never the URL, so a secret pasted into the wrong place is never printed.
 */
export function passwordOf(role: LoginRole, url: string | undefined, pilot?: PilotTarget): string {
  const variable = pilot === undefined ? role.urls.local : role.urls.pilot
  const refuse = (why: string): never => {
    throw new Error(`${variable}: ${why}`)
  }
  if (url === undefined || url === "") return refuse("is not set")
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return refuse("not a postgresql:// URL")
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") refuse("not a postgresql:// URL")
  if (pilot !== undefined) {
    if (parsed.hostname.toLowerCase() !== pilot.host) refuse("host is not the Pilot's session pooler")
    if (parsed.port !== SESSION_POOLER_PORT) refuse(`port ${parsed.port || "(none)"} is not the session pooler's ${SESSION_POOLER_PORT}`)
    if (parsed.pathname !== `/${SUPABASE_DATABASE}`) refuse(`database is not ${SUPABASE_DATABASE}`)
  }
  const user = decodeURIComponent(parsed.username)
  const pooled = poolerUser(user)
  if ((pooled?.role ?? user) !== role.name) refuse(`logs in as ${pooled?.role ?? user}, not ${role.name}`)
  if (pooled?.ref !== pilot?.ref) refuse("names another Supabase project")
  const password = decodeURIComponent(parsed.password)
  if (password === "") refuse("carries no password")
  return password
}
