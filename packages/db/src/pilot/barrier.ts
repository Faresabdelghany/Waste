// The app roles' LOGIN state and the write barrier (Issue #152). A restore or
// a reset-to-seed replaces what the API and the worker read, so before it
// drops anything the operation closes the door on both. The protocol is this
// module's, in the order an operation runs it:
//
// 1. `recordLogins` reads `rolcanlogin` of the barrier's roles and writes the
//    record (login-state.json: the states, the run, the operation, the
//    commit, the time and the database's identity, never a credential),
//    refusing while the barrier is closed already;
// 2. the record is stored where a recovery finds it — the workflow's
//    artifact, the rehearsal's file — and read back;
// 3. `behindBarrier` closes over the record as it read back (its digest the
//    one recorded, its run and database this one's, the logins as recorded):
//    the roles NOLOGIN, their sessions terminated — never the operation's own,
//    which is the owner's — and none left; then the work and its checks; then
//    `openFromRecord` restores the recorded states, which is all
//    `recover-logins` does when a run failed or was cancelled in between.
//
// On failure or cancellation after the close the roles stay NOLOGIN: an API
// that cannot log in answers 503, which is better than one writing into a
// half-restored database. The recovery refuses a role that can log in now but
// could not when the barrier closed, since then somebody has changed it
// since, and the record no longer says what is right. And a barrier is never
// closed over one already closed: while wms_api cannot log in, recording
// would record the closed state, and a later recovery from that record would
// restore nothing (a restore re-run after one that failed is exactly that), so
// `recordLogins` refuses and says to recover first.
//
// Every function takes the roles, BARRIER_ROLES unless a suite closes the
// barrier on throwaway roles of its own: roles are cluster-wide, and every
// other suite logs in as wms_api.
import type { Sql } from "postgres"

import { textList } from "../query/text-list"
import { DATABASE_ROLES, GRANTED_ROLES, PLAIN_ROLE } from "../roles"
import { sha256 } from "../sha256"
import { databaseIdentity } from "./identity"
import { COMMIT_ID, type RunRef } from "./run"

export const BARRIER_ROLES: readonly string[] = DATABASE_ROLES.filter((role) => role.barrier).map((role) => role.name)

/** The roles that log in wherever the API runs: NOLOGIN on any of them is a barrier an earlier run left closed. */
const ALWAYS_LOGGING_IN = GRANTED_ROLES.filter((role) => role.login === "always").map((role) => role.name)

/** The operations that close the barrier, and the only ones whose record `recover-logins` accepts. */
export const BARRIER_OPERATIONS = ["restore", "reset-to-seed"] as const
export type BarrierOperation = (typeof BARRIER_OPERATIONS)[number]

/** The record's file, as it is stored and as a recovery finds it in the downloaded artifact. */
export const LOGIN_STATE_FILE = "login-state.json"

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

/** Whether each role can log in now, or null for a role that does not exist yet (wms_worker before migration 0011). */
export async function readLoginsIfPresent(sql: Sql, roles: readonly string[]): Promise<Record<string, boolean | null>> {
  const rows = await sql<{ name: string; login: boolean }[]>`
    select rolname as name, rolcanlogin as login from pg_roles where rolname = any(${textList(sql, plain(roles))})`
  return Object.fromEntries(roles.map((role) => [role, rows.find((row) => row.name === role)?.login ?? null]))
}

/** Whether each role can log in now; a role that does not exist is an error, not a state. */
export async function readLogins(sql: Sql, roles: readonly string[] = BARRIER_ROLES): Promise<Record<string, boolean>> {
  const present = await readLoginsIfPresent(sql, roles)
  const logins: Record<string, boolean> = {}
  for (const role of roles) {
    const login = present[role]
    if (login === null || login === undefined) throw new Error(`the role ${role} does not exist on this database`)
    logins[role] = login
  }
  return logins
}

export function loginRecord(input: Omit<LoginRecord, "schema">): LoginRecord {
  return { schema: LOGIN_RECORD_SCHEMA, ...input }
}

/** What wms_api NOLOGIN means wherever it is found, the check's failure and the record's refusal alike: an earlier run's barrier, never a state of its own. */
export const BARRIER_CLOSED = `${ALWAYS_LOGGING_IN.join(" or ")} cannot log in: an earlier restore or reset closed the write barrier and never opened it. Run recover-logins with that run's id first (supabase/README.md).`

/** Whether the logins read say the barrier is open: every role among them that logs in wherever the API runs can. */
export function barrierOpen(logins: Record<string, boolean | null>): boolean {
  return ALWAYS_LOGGING_IN.filter((role) => role in logins).every((role) => logins[role] === true)
}

/** Refuses to close a barrier while one is closed: wms_api NOLOGIN is an earlier run's barrier, never a state worth recording. */
export function requireBarrierOpen(logins: Record<string, boolean>): void {
  if (!barrierOpen(logins)) throw new Error(`${BARRIER_CLOSED} A record taken now would record the closed state and restore nothing.`)
}

/** Holds a record to the run, the commit and the database it must be of. */
export function checkRecord(record: LoginRecord, { identity, run, commit }: { identity: string; run: RunRef; commit?: string }): void {
  if (record.run.id !== run.id || record.run.attempt !== run.attempt) {
    throw new Error(`the login record is of run ${record.run.id} attempt ${record.run.attempt}, not run ${run.id} attempt ${run.attempt}`)
  }
  if (commit !== undefined && record.commit !== commit) throw new Error(`the login record names commit ${record.commit}, not its run's ${commit}`)
  if (record.identity !== identity) throw new Error(`the login record is of ${record.identity}, not ${identity}`)
}

/** Reads a login-state.json, refusing anything that is not exactly the record this protocol writes. */
export function parseLoginRecord(text: string, roles: readonly string[] = BARRIER_ROLES): LoginRecord {
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
  if (logins === null || typeof logins !== "object" || Object.keys(logins).sort().join(",") !== [...roles].sort().join(",")) {
    refuse(`does not name exactly ${roles.join(" and ")}`)
  }
  for (const role of roles) if (typeof (logins as Record<string, unknown>)[role] !== "boolean") refuse(`says nothing usable about ${role}`)
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
export function planRecovery(record: Pick<LoginRecord, "logins">, now: Record<string, boolean>, roles: readonly string[] = BARRIER_ROLES): RecoveryPlan {
  const plan: RecoveryPlan = { restore: [], unchanged: [], refused: [] }
  for (const role of roles) {
    const recorded = record.logins[role]
    const current = now[role]
    if (recorded === current) plan.unchanged.push(role)
    else if (recorded) plan.restore.push(role)
    else plan.refused.push(`${role} can log in now, but could not when the barrier closed: somebody has changed it since, so the record no longer says what is right`)
  }
  return plan
}

/** One line per role, for a log: `wms_api LOGIN, wms_worker missing`. */
export function spellLogins(logins: Record<string, boolean | null>): string {
  return Object.entries(logins)
    .map(([role, login]) => `${role} ${login === null ? "missing" : login ? "LOGIN" : "NOLOGIN"}`)
    .join(", ")
}

/** Where a barrier is: the database it guards, the run it belongs to, and the roles it switches off. */
export type BarrierScope = { identity: string; run: RunRef; commit: string; roles?: readonly string[] }

/** A recorded login state: the record, its text as stored, and the text's sha256. */
export type RecordedLogins = { record: LoginRecord; text: string; sha256: string }

/** The protocol's first step: the logins read and written as a record, refused while the barrier is closed already. The record goes where a recovery finds it, and is read back, before `behindBarrier`. */
export async function recordLogins(
  sql: Sql,
  { operation, identity, run, commit, roles = BARRIER_ROLES, now = new Date() }: BarrierScope & { operation: BarrierOperation; now?: Date },
): Promise<RecordedLogins> {
  const logins = await readLogins(sql, roles)
  requireBarrierOpen(logins)
  const record = loginRecord({ operation, run, commit, recordedAt: now.toISOString(), identity, logins })
  const text = `${JSON.stringify(record, null, 2)}\n`
  return { record, text, sha256: sha256(text) }
}

/** The line a run's summary says a record with: what it holds, and the digest the close holds the stored copy to. */
export function spellRecord({ record, sha256: digest }: RecordedLogins): string {
  return `Recorded the logins before the barrier: ${spellLogins(record.logins)} (${record.identity}, ${LOGIN_STATE_FILE} sha256 ${digest})`
}

/**
 * The recorded states back, refusing a record of another run, commit or
 * database and a role somebody changed since: the end of `behindBarrier`, and
 * the whole of recover-logins.
 */
export async function openFromRecord(sql: Sql, text: string, { identity, run, commit, roles = BARRIER_ROLES }: BarrierScope): Promise<{ record: LoginRecord; restored: string[]; logins: Record<string, boolean> }> {
  const record = parseLoginRecord(text, roles)
  checkRecord(record, { identity, run, commit })
  const plan = planRecovery(record, await readLogins(sql, roles), roles)
  if (plan.refused.length > 0) throw new Error(`Refused, nothing changed:\n${plan.refused.join("\n")}`)
  await openLogins(sql, plan.restore)
  return { record, restored: plan.restore, logins: await readLogins(sql, roles) }
}

/** The line a run's summary says an opening with. */
export function spellOpened({ record, restored, logins }: Awaited<ReturnType<typeof openFromRecord>>): string {
  return `Logins restored from the ${record.operation} of run ${record.run.id}: ${spellLogins(logins)}${restored.length === 0 ? " (already as recorded)" : ""}`
}

/**
 * The barrier around an operation's work, once its record is stored: closed
 * over the copy read back from the store — its digest the recorded text's,
 * its run and database this one's, the logins still as recorded — then the
 * work and its checks, then the recorded states back from the record itself.
 * Anything thrown after the close leaves the roles NOLOGIN, for
 * recover-logins with this run's id.
 */
export async function behindBarrier<T>(
  sql: Sql,
  { recorded, stored, say, ...scope }: BarrierScope & { recorded: string; stored: string; say: (line: string) => void },
  work: () => Promise<T>,
): Promise<T> {
  const roles = scope.roles ?? BARRIER_ROLES
  if (sha256(stored) !== sha256(recorded)) throw new Error(`the uploaded ${LOGIN_STATE_FILE} reads back with sha256 ${sha256(stored)}, not ${sha256(recorded)}: the barrier stays open`)
  const record = parseLoginRecord(stored, roles)
  checkRecord(record, { identity: scope.identity, run: scope.run })
  const now = await readLogins(sql, roles)
  if (JSON.stringify(now) !== JSON.stringify(record.logins)) throw new Error(`the logins changed since they were recorded (${spellLogins(now)}): the barrier stays open`)
  const { terminated } = await closeBarrier(sql, roles)
  say(`Barrier closed: ${roles.join(" and ")} NOLOGIN, ${terminated} session(s) ended, none left. On failure or cancellation they stay NOLOGIN: run recover-logins with this run's id.`)
  const result = await work()
  say(spellOpened(await openFromRecord(sql, recorded, { ...scope, roles })))
  return result
}

/**
 * The roles a URL of their own logs in as, as the check reports them and a
 * restore or a reset ends with: the database's identity and each role's
 * state, said; a barrier an earlier run left closed is a failure that says to
 * run recover-logins. wms_worker is reported and not held to anything: it has
 * no login until grant-logins gives it one, and does not exist before
 * migration 0011.
 */
export async function verifyLogins(sql: Sql, url: string, say: (line: string) => void): Promise<void> {
  const logins = await readLoginsIfPresent(sql, GRANTED_ROLES.map((role) => role.name))
  say(`${await databaseIdentity(sql, url)}: ${spellLogins(logins)}`)
  if (!barrierOpen(logins)) throw new Error(BARRIER_CLOSED)
}
