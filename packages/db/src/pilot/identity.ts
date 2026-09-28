// Which database a Pilot operation is talking to (Issue #152). Every owner
// operation of the protected workflow names its target twice — the secret's
// URL and the committed `PILOT_SUPABASE_REF` — and refuses to run when the two
// disagree, so a secret pasted from another Supabase project, or a script run
// by hand against some other host, stops before it touches anything. The
// identity a backup, a login-state record or a restore carries is the same
// spelling, so a backup of one Supabase project is never restored into another.
//
// The Supabase project ref is read from the URL: the session pooler's user
// is `<role>.<ref>` and the direct host is `db.<ref>.supabase.co` (the Pilot is
// reached through the pooler, since a GitHub runner has no IPv6). A loopback
// URL is the local stack, where the CI rehearsal runs.
import type { Sql } from "postgres"

import { isLocalHost } from "../local-host"

/** A Supabase project ref: twenty lowercase letters and digits. */
const REF = /^[a-z0-9]{20}$/
const POOLER_HOST = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/
const DIRECT_HOST = /^db\.([a-z0-9]{20})\.supabase\.co$/

export type Target = { kind: "supabase"; ref: string } | { kind: "local" }

/** The session pooler's user, `<role>.<ref>`, as its role and its Supabase project ref; undefined for a user that is not one. */
export function poolerUser(user: string): { role: string; ref: string } | undefined {
  const dot = user.lastIndexOf(".")
  if (dot <= 0) return undefined
  const ref = user.slice(dot + 1)
  return REF.test(ref) ? { role: user.slice(0, dot), ref } : undefined
}

/** Where a URL points, read from the URL alone. */
export function targetOfUrl(url: string): Target {
  const parsed = new URL(url)
  if (isLocalHost(url)) return { kind: "local" }
  const host = parsed.hostname.toLowerCase()
  const direct = DIRECT_HOST.exec(host)
  if (direct !== null) return { kind: "supabase", ref: direct[1] }
  if (POOLER_HOST.test(host)) {
    const user = poolerUser(decodeURIComponent(parsed.username))
    if (user !== undefined) return { kind: "supabase", ref: user.ref }
    throw new Error(`the pooler URL for ${host} names no Supabase project: its user is not <role>.<Supabase project ref>`)
  }
  throw new Error(`${host} is neither a Supabase project nor the local stack`)
}

/** The identity a record carries: `supabase:<ref>/<database>` or `local/<database>`. */
export async function databaseIdentity(sql: Sql, url: string): Promise<string> {
  const [{ database }] = await sql<{ database: string }[]>`select current_database()::text as database`
  const target = targetOfUrl(url)
  return target.kind === "supabase" ? `supabase:${target.ref}/${database}` : `local/${database}`
}

/** What an operator is told when the Pilot cannot be reached (#133): a Free Supabase project pauses after a week without activity. */
export const PAUSED_HINT = "The Free Supabase project may be paused: resume it in the dashboard and re-run the workflow."

/** The connection errors postgres.js raises before a database has answered anything. */
const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED"])

/**
 * The paused-Supabase-project hint, for an error that says a Supabase project could
 * not be reached — the connection failed, or the pooler knows no such tenant
 * — and nothing for the local stack or for an answer the database gave.
 */
export function unreachableHint(url: string, error: unknown): string | undefined {
  let target: Target
  try {
    target = targetOfUrl(url)
  } catch {
    return undefined
  }
  if (target.kind !== "supabase") return undefined
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown }
  const unreachable = (typeof code === "string" && UNREACHABLE_CODES.has(code)) || (typeof message === "string" && /tenant or user not found/i.test(message))
  return unreachable ? PAUSED_HINT : undefined
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
