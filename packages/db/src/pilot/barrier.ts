// The app roles' LOGIN state and the write barrier (Issue #152). A restore or
// a reset-to-seed replaces what the API and the worker read, so before it
// drops anything the protected workflow closes the door on both:
//
// 1. `recordLogins` reads `rolcanlogin` of `wms_api` and `wms_worker` and the
//    workflow stores the record as an artifact (login-state.json: the two
//    states, the run, the operation, the commit, the time and the database's
//    identity, never a credential), then reads it back and checks its digest;
// 2. only then `closeBarrier` sets both roles NOLOGIN, terminates their
//    sessions — never the workflow's own, which is the owner's — and waits
//    until none remain;
// 3. after every check has passed, `planRecovery` and `openLogins` restore
//    the recorded states, and `recover-logins` does the same from the stored
//    record when a run failed or was cancelled in between.
//
// On failure or cancellation the roles stay NOLOGIN: an API that cannot log
// in answers 503, which is better than one writing into a half-restored
// database. The recovery refuses a role that can log in now but could not
// when the barrier closed, since then somebody has changed it since, and the
// record no longer says what is right. And a barrier is never closed over
// one already closed: while wms_api cannot log in, recording would record the
// closed state, and a later recovery from that record would restore nothing
// (a restore re-run after one that failed is exactly that), so `barrierOpen`
// refuses and says to recover first.
import type { Sql } from "postgres"

import { textList } from "../query/text-list"
import { API_ROLE, PLAIN_ROLE, WORKER_ROLE } from "../roles"
import { COMMIT_ID, type RunRef } from "./github"

/** The roles the barrier closes: the two the Pilot's processes log in as. */
export const BARRIER_ROLES = [API_ROLE, WORKER_ROLE] as const

/** The operations that close the barrier, and the only ones whose record `recover-logins` accepts. */
export const BARRIER_OPERATIONS = ["restore", "reset-to-seed"] as const
export type BarrierOperation = (typeof BARRIER_OPERATIONS)[number]

/** What login-state.json says: this shape and nothing else. */
export const LOGIN_RECORD_SCHEMA = "waste.pilot.login-state/1"
export type LoginRecord = {
  schema: typeof LOGIN_RECORD_SCHEMA
  operation: BarrierOperation
  run: RunRef
  commit: string
  recordedAt: string
  identity: string
  logins: Record<string, boolean>
}

function plain(roles: readonly string[]): readonly string[] {
  for (const role of roles) if (!PLAIN_ROLE.test(role)) throw new Error(`"${role}" is not a plain role name`)
  return roles
}

/** Whether each role can log in now; a role that does not exist is an error, not a state. */
export async function readLogins(sql: Sql, roles: readonly string[] = BARRIER_ROLES): Promise<Record<string, boolean>> {
  const rows = await sql<{ name: string; login: boolean }[]>`
    select rolname as name, rolcanlogin as login from pg_roles where rolname = any(${textList(sql, plain(roles))})`
  const logins: Record<string, boolean> = {}
  for (const role of roles) {
    const row = rows.find((candidate) => candidate.name === role)
    if (row === undefined) throw new Error(`the role ${role} does not exist on this database`)
    logins[role] = row.login
  }
  return logins
}

/** Whether each role can log in now, or null for a role that does not exist yet (wms_worker before migration 0011). */
export async function readLoginsIfPresent(sql: Sql, roles: readonly string[]): Promise<Record<string, boolean | null>> {
  const rows = await sql<{ name: string; login: boolean }[]>`
    select rolname as name, rolcanlogin as login from pg_roles where rolname = any(${textList(sql, plain(roles))})`
  return Object.fromEntries(roles.map((role) => [role, rows.find((row) => row.name === role)?.login ?? null]))
}

export function loginRecord(input: Omit<LoginRecord, "schema">): LoginRecord {
  return { schema: LOGIN_RECORD_SCHEMA, ...input }
}

/** Refuses to close a barrier while one is closed: wms_api NOLOGIN is an earlier run's barrier, never a state worth recording. */
export function barrierOpen(logins: Record<string, boolean>): void {
  if (logins[API_ROLE] !== true) {
    throw new Error(
      "wms_api cannot log in: an earlier restore or reset closed the write barrier and never opened it. Run recover-logins with that run's id first; a record taken now would record the closed state and restore nothing.",
    )
  }
}

/** Holds a record to the run, the commit and the database it must be of. */
export function checkRecord(record: LoginRecord, { identity, run, commit }: { identity: string; run: RunRef; commit?: string }): void {
  if (record.run.id !== run.id || record.run.attempt !== run.attempt) {
    throw new Error(`the login record is of run ${record.run.id} attempt ${record.run.attempt}, not run ${run.id} attempt ${run.attempt}`)
  }
  if (commit !== undefined && record.commit !== commit) throw new Error(`the login record names commit ${record.commit}, not its run's ${commit}`)
  if (record.identity !== identity) throw new Error(`the login record is of ${record.identity}, not ${identity}`)
}

/** Reads a login-state.json, refusing anything that is not exactly the record this workflow writes. */
export function parseLoginRecord(text: string): LoginRecord {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error("the login-state record is not JSON")
  }
  const record = value as Partial<LoginRecord> | null
  const refuse = (why: string): never => {
    throw new Error(`the login-state record ${why}`)
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) return refuse("is not an object")
  if (record.schema !== LOGIN_RECORD_SCHEMA) refuse(`is not a ${LOGIN_RECORD_SCHEMA} record`)
  const keys = Object.keys(record).sort().join(",")
  if (keys !== "commit,identity,logins,operation,recordedAt,run,schema") refuse(`carries other members: ${keys}`)
  if (!BARRIER_OPERATIONS.includes(record.operation as BarrierOperation)) refuse("names no restore or reset operation")
  if (typeof record.run?.id !== "string" || !/^\d+$/.test(record.run.id) || typeof record.run.attempt !== "string" || !/^\d+$/.test(record.run.attempt)) {
    refuse("names no run")
  }
  if (typeof record.commit !== "string" || !COMMIT_ID.test(record.commit)) refuse("names no commit")
  if (typeof record.recordedAt !== "string" || Number.isNaN(Date.parse(record.recordedAt))) refuse("has no time")
  if (typeof record.identity !== "string" || record.identity === "") refuse("names no database")
  const logins = record.logins
  if (logins === null || typeof logins !== "object" || Object.keys(logins).sort().join(",") !== [...BARRIER_ROLES].sort().join(",")) {
    refuse(`does not name exactly ${BARRIER_ROLES.join(" and ")}`)
  }
  for (const role of BARRIER_ROLES) if (typeof (logins as Record<string, unknown>)[role] !== "boolean") refuse(`says nothing usable about ${role}`)
  return record as LoginRecord
}

/**
 * Sets every role NOLOGIN, terminates its sessions and waits until none
 * remain, or throws when some still do after `timeoutMs`. The owner's own
 * connection is never among them: it is not one of these roles.
 */
export async function closeBarrier(sql: Sql, roles: readonly string[] = BARRIER_ROLES, { timeoutMs = 10_000 }: { timeoutMs?: number } = {}): Promise<{ terminated: number }> {
  for (const role of plain(roles)) await sql`alter role ${sql(role)} nologin`
  const [{ terminated }] = await sql<{ terminated: number }[]>`
    select count(*)::int as terminated from (
      select pg_terminate_backend(pid) from pg_stat_activity where usename = any(${textList(sql, roles)}) and pid <> pg_backend_pid()
    ) terminations`
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const [{ remaining }] = await sql<{ remaining: number }[]>`
      select count(*)::int as remaining from pg_stat_activity where usename = any(${textList(sql, roles)}) and pid <> pg_backend_pid()`
    if (remaining === 0) return { terminated }
    if (Date.now() > deadline) throw new Error(`${remaining} session(s) of ${roles.join(" or ")} remain after the barrier closed`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/** Gives each role LOGIN again. */
export async function openLogins(sql: Sql, roles: readonly string[]): Promise<void> {
  for (const role of plain(roles)) await sql`alter role ${sql(role)} login`
}

export type RecoveryPlan = {
  /** Roles recorded LOGIN that cannot log in now: the barrier's work, undone. */
  restore: string[]
  /** Roles already in their recorded state. */
  unchanged: string[]
  /** Roles that can log in now though the record says they could not: refused, with the reason. */
  refused: string[]
}

/** What restoring a record's LOGIN states would do to the roles as they are now. */
export function planRecovery(record: Pick<LoginRecord, "logins">, now: Record<string, boolean>): RecoveryPlan {
  const plan: RecoveryPlan = { restore: [], unchanged: [], refused: [] }
  for (const role of BARRIER_ROLES) {
    const recorded = record.logins[role]
    const current = now[role]
    if (recorded === current) plan.unchanged.push(role)
    else if (recorded) plan.restore.push(role)
    else plan.refused.push(`${role} can log in now, but could not when the barrier closed: somebody has changed it since, so the record no longer says what is right`)
  }
  return plan
}

/** One line per role, for a log: `wms_api LOGIN, wms_worker NOLOGIN, wms_sync missing`. */
export function spellLogins(logins: Record<string, boolean | null>): string {
  return Object.entries(logins)
    .map(([role, login]) => `${role} ${login === null ? "missing" : login ? "LOGIN" : "NOLOGIN"}`)
    .join(", ")
}
