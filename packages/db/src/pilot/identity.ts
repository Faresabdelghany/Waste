// Which database a Pilot operation is talking to (Issue #152). Every owner
// operation of the protected workflow names its target twice — the secret's
// URL and the committed `PILOT_SUPABASE_REF` — and refuses to run when the two
// disagree, so a secret pasted from another Supabase project, or a script run
// by hand against some other host, stops before it touches anything. The
// identity a backup, a login-state record or a restore carries is the same
// spelling, so a backup of one Supabase project is never restored into another.
//
// The project ref is read from the URL: the session pooler's user is
// `<role>.<ref>` and the direct host is `db.<ref>.supabase.co` (the Pilot is
// reached through the pooler, since a GitHub runner has no IPv6). A loopback
// URL is the local stack, where the CI rehearsal runs.
import type { Sql } from "postgres"

import { isLocalHost } from "../local-host"

/** A Supabase project ref: twenty lowercase letters and digits. */
const REF = /^[a-z0-9]{20}$/
const POOLER_HOST = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/
const DIRECT_HOST = /^db\.([a-z0-9]{20})\.supabase\.co$/

export type Target = { kind: "supabase"; ref: string } | { kind: "local" }

/** Where a URL points, read from the URL alone. */
export function targetOfUrl(url: string): Target {
  const parsed = new URL(url)
  if (isLocalHost(url)) return { kind: "local" }
  const host = parsed.hostname.toLowerCase()
  const direct = DIRECT_HOST.exec(host)
  if (direct !== null) return { kind: "supabase", ref: direct[1] }
  if (POOLER_HOST.test(host)) {
    const user = decodeURIComponent(parsed.username)
    const ref = user.slice(user.lastIndexOf(".") + 1)
    if (user.includes(".") && REF.test(ref)) return { kind: "supabase", ref }
    throw new Error(`the pooler URL for ${host} names no Supabase project: its user is not <role>.<project ref>`)
  }
  throw new Error(`${host} is neither a Supabase project nor the local stack`)
}

/** The identity a record carries: `supabase:<ref>/<database>` or `local/<database>`. */
export async function databaseIdentity(sql: Sql, url: string): Promise<string> {
  const [{ database }] = await sql<{ database: string }[]>`select current_database()::text as database`
  const target = targetOfUrl(url)
  return target.kind === "supabase" ? `supabase:${target.ref}/${database}` : `local/${database}`
}

/**
 * Refuses a URL that is not the Pilot's: with `expectedRef` (the workflow's
 * committed PILOT_SUPABASE_REF) it must be that Supabase project, and without
 * one it must be the local stack, so a Pilot script run outside the workflow
 * can only ever reach this machine.
 */
export function expectPilot(url: string, expectedRef: string | undefined): Target {
  const target = targetOfUrl(url)
  if (expectedRef === undefined || expectedRef === "") {
    if (target.kind !== "local") throw new Error("PILOT_SUPABASE_REF is not set: outside the protected workflow a Pilot operation runs against the local stack only")
    return target
  }
  if (!REF.test(expectedRef)) throw new Error(`PILOT_SUPABASE_REF is not a Supabase project ref`)
  if (target.kind !== "supabase" || target.ref !== expectedRef) {
    throw new Error(`the URL points at ${target.kind === "supabase" ? `Supabase project ${target.ref}` : "the local stack"}, not the Pilot's (${expectedRef})`)
  }
  return target
}
