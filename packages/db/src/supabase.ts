// What a hosted Supabase project looks like from a connection URL, spelled
// once for every Pilot operation that holds a URL to one (Issue #152): the
// project ref, the session pooler's host and user, the direct host and the
// database; the pooler's ports are @waste/process's. The Pilot is reached
// through the session pooler, since a GitHub runner has no IPv6 and the
// direct host has nothing else; which project and which pooler host are the
// protected workflow's (PILOT_SUPABASE_REF, PILOT_DATABASE_HOST).

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
