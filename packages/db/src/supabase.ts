// What a hosted Supabase project looks like from a connection URL, spelled
// once for every Pilot operation that holds a URL to one (Issue #152): the
// project ref, the session pooler's host and user, the direct host and the
// database; the pooler's ports are @waste/process's. The Pilot is reached
// through the session pooler, since a GitHub runner has no IPv6 and the
// direct host has nothing else; which project and which pooler host are the
// protected workflow's (PILOT_SUPABASE_REF, PILOT_DATABASE_HOST). A role's
// URL is held to them here, and to its role in the table (roles.ts), by
// bootstrap and grant-logins alike.
import { SESSION_POOLER_PORT } from "@waste/process/ports"

import type { LoginRole } from "./roles"

/** A Supabase project ref: twenty lowercase letters and digits, spelled once for the ref alone and for the direct host that carries one. */
const REF_SHAPE = "[a-z0-9]{20}"
export const PROJECT_REF = new RegExp(`^${REF_SHAPE}$`)
export const POOLER_HOST = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/
export const DIRECT_HOST = new RegExp(`^db\\.(${REF_SHAPE})\\.supabase\\.co$`)

/** The one database a Supabase project serves. */
export const SUPABASE_DATABASE = "postgres"

/** The session pooler's user, `<role>.<ref>`, as its role and its Supabase project ref; undefined for a user that is not one. */
export function poolerUser(user: string): { role: string; ref: string } | undefined {
  const dot = user.lastIndexOf(".")
  if (dot <= 0) return undefined
  const ref = user.slice(dot + 1)
  return PROJECT_REF.test(ref) ? { role: user.slice(0, dot), ref } : undefined
}

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
