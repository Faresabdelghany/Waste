// The restore rehearsal (Issue #152): the Pilot's backup and restore run end
// to end against a local database, so a change that would break them fails
// the merge and not a restore on the day it is needed. CI runs it on the local
// stack before the test suites, which then run against the restored database
// as its smoke test (scripts/pilot/rehearse.ts, with the barrier on the real
// app roles), and pilot-rehearsal.test.ts runs it on a fresh database of its
// own.
//
// In order: the journal and the fingerprint captured; pilot-backup.sh to a
// throwaway age key; the three application schemas dropped, as a lost
// database would have them; pilot-restore.sh decrypt; the backup verified
// against its manifest and this database; the barrier closed, where asked;
// pilot-restore.sh apply; the journal check and the backup's own fingerprint
// compared with the captured ones; the recorded logins restored. Anything
// that differs throws, naming it.
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createDb } from "../client"
import { compareFingerprints, fingerprintDatabase } from "../fingerprint"
import { readAppliedMigrations } from "../journal-check"
import { isLocalHost } from "../local-host"
import { checkDatabaseJournal } from "../migrate"
import { checkRestoreTarget, FINGERPRINT_COPY, majorOf, verifyBackup } from "./backup"
import { databaseIdentity } from "./identity"
import { closeBarrier, openLogins, planRecovery, readLogins, spellLogins } from "./logins"

const SCRIPTS = fileURLToPath(new URL("../../scripts", import.meta.url))

/** Whether this machine has what the backup and restore scripts need: PostgreSQL client 17 and age. The reason when not. */
export function rehearsalTools(): string | undefined {
  const version = spawnSync("pg_dump", ["--version"], { encoding: "utf8" })
  if (version.status !== 0) return "pg_dump is not on PATH (install PostgreSQL client 17)"
  if (majorOf(version.stdout.trim()) !== 17) return `pg_dump is ${version.stdout.trim()}, not PostgreSQL client 17`
  const psql = spawnSync("psql", ["--version"], { encoding: "utf8" })
  if (psql.status !== 0 || majorOf(psql.stdout.trim()) !== 17) return "psql 17 is not on PATH"
  for (const tool of ["age", "age-keygen"]) {
    if (spawnSync(tool, ["--version"], { encoding: "utf8" }).status !== 0) return `${tool} is not on PATH`
  }
  return undefined
}

function run(command: string, args: readonly string[], env: Record<string, string | undefined>, log: (line: string) => void): string {
  const result = spawnSync(command, args, { env: { ...process.env, ...env }, encoding: "utf8" })
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
  if (output !== "") for (const line of output.split("\n")) log(line)
  if (result.status !== 0) throw new Error(`${path.basename(args[0] ?? command)} ${args.slice(1).join(" ")} failed (${result.status ?? result.signal}):\n${output}`)
  return result.stdout
}

export type RehearsalOptions = {
  /** Close and reopen the write barrier on the real app roles: CI's step, never a suite running beside others. */
  barrier?: boolean
  log?: (line: string) => void
}

export type Rehearsal = { fingerprint: string; journalRows: number; logins?: string }

export async function rehearseRestore(url: string, { barrier = false, log = () => {} }: RehearsalOptions = {}): Promise<Rehearsal> {
  if (!isLocalHost(url)) throw new Error("the restore rehearsal drops schemas: it runs against the local stack only")
  const missing = rehearsalTools()
  if (missing !== undefined) throw new Error(`the restore rehearsal needs PostgreSQL client 17 and age: ${missing}`)
  const work = mkdtempSync(path.join(tmpdir(), "waste-rehearsal-"))
  const owner = createDb(url, { max: 1 })
  try {
    run("age-keygen", ["-o", path.join(work, "identity.txt")], {}, log)
    writeFileSync(path.join(work, "recipient.txt"), run("age-keygen", ["-y", path.join(work, "identity.txt")], {}, () => {}))
    const before = await fingerprintDatabase(url)
    const rowsBefore = await readAppliedMigrations(owner.sql)
    const identity = await databaseIdentity(owner.sql, url)

    const archive = path.join(work, "backup.tar.age")
    const pilot = { DATABASE_ADMIN_URL: url, PILOT_SUPABASE_REF: "", GITHUB_RUN_ID: "rehearsal", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: "0".repeat(40) }
    run("bash", [path.join(SCRIPTS, "pilot-backup.sh")], { ...pilot, BACKUP_OUTPUT: archive, BACKUP_RECIPIENT_FILE: path.join(work, "recipient.txt") }, log)

    await owner.sql`drop schema if exists pgboss, drizzle, wms cascade`
    log("rehearsal: dropped pgboss, drizzle and wms")

    const restore = path.join(work, "restore")
    run("bash", [path.join(SCRIPTS, "pilot-restore.sh"), "decrypt"], { BACKUP_FILE: archive, AGE_IDENTITY: readFileSync(path.join(work, "identity.txt"), "utf8"), RESTORE_DIR: restore }, log)
    const manifest = verifyBackup(restore)
    checkRestoreTarget(manifest, { identity })

    const recorded = barrier ? await readLogins(owner.sql) : undefined
    if (barrier) log(`rehearsal: barrier closed, ${(await closeBarrier(owner.sql)).terminated} session(s) ended; recorded ${spellLogins(recorded ?? {})}`)
    run("bash", [path.join(SCRIPTS, "pilot-restore.sh"), "apply"], { ...pilot, RESTORE_DIR: restore }, log)

    const journal = await checkDatabaseJournal(url)
    if (journal.problems.length > 0) throw new Error(`the restored journal disagrees with the folder:\n${journal.problems.join("\n")}`)
    const rowsAfter = await readAppliedMigrations(owner.sql)
    if (JSON.stringify(rowsAfter) !== JSON.stringify(rowsBefore)) throw new Error("the restored journal's rows are not the rows backed up")
    const after = await fingerprintDatabase(url)
    for (const [expected, name] of [
      [readFileSync(path.join(restore, FINGERPRINT_COPY), "utf8"), "the backup's fingerprint"],
      [before, "the fingerprint before the backup"],
    ] as const) {
      const { missing: lost, unexpected } = compareFingerprints(expected, after)
      if (lost.length + unexpected.length > 0) {
        throw new Error(`the restored database differs from ${name}:\n${[...lost.map((line) => `- ${line}`), ...unexpected.map((line) => `+ ${line}`)].join("\n")}`)
      }
    }

    let logins: string | undefined
    if (recorded !== undefined) {
      const plan = planRecovery({ logins: recorded }, await readLogins(owner.sql))
      if (plan.refused.length > 0) throw new Error(plan.refused.join("\n"))
      await openLogins(owner.sql, plan.restore)
      logins = spellLogins(await readLogins(owner.sql))
      log(`rehearsal: barrier opened, ${logins}`)
    }
    log(`rehearsal: restored ${rowsAfter.length} journal rows and ${manifest.schemas.join(", ")}; the fingerprint matches`)
    return { fingerprint: after, journalRows: rowsAfter.length, ...(logins === undefined ? {} : { logins }) }
  } finally {
    await owner.close()
    rmSync(work, { recursive: true, force: true })
  }
}
