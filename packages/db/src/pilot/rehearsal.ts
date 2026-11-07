// The restore rehearsal (Issue #152): the restore's own phases (phases.ts)
// run end to end against a local database, so a change that would break them
// fails the merge and not a restore on the day it is needed. CI runs it on the
// local stack before the test suites, which then run against the restored
// database as its smoke test (scripts/pilot/rehearse.ts, with the barrier on
// the real app roles), and pilot-rehearsal.test.ts runs it on a fresh
// database of its own, the barrier on throwaway roles.
//
// In order: the journal and the fingerprint captured; the restore's back-up
// phase, to a throwaway age key, and its archive put where the workflow
// downloads a source run's, with the choice that names it; the three
// application schemas dropped, as a lost database would have them; the
// decrypt phase; the record phase, which verifies the backup against its
// manifest, this database and the source run and records the logins, the
// record then stored and read back as the workflow does; the apply phase,
// which restores behind the barrier and proves the result by the journal
// check and the backup's own fingerprint; and the journal's rows and the
// fingerprint compared with the captured ones. Anything that differs throws,
// naming it.
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { createDb } from "../client"
import { compareFingerprints, fingerprintDatabase } from "../fingerprint"
import { readAppliedMigrations } from "../journal-check"
import { isLocalHost } from "../local-host"
import { OWNED_SCHEMAS } from "../migrate"
import { DROP_OWNED_SCHEMAS, verifyBackup } from "./backup"
import { backupTools } from "./backup-scripts"
import { LOGIN_STATE_FILE, PILOT_BARRIER, readLogins, spellLogins, type BarrierRoles } from "./barrier"
import { BACKUP_ARTIFACT, createContext, writeSourceRun } from "./phase"
import { restorePhases } from "./phases"
import { LOCAL_RUN } from "./run"

export type RehearsalOptions = {
  /** The roles the barrier closes on: the real app roles in CI's step, a suite's throwaway roles where other suites log in beside it. */
  barrier?: BarrierRoles
  log?: (line: string) => void
}

export type Rehearsal = { fingerprint: string; journalRows: number; logins: string }

export async function rehearseRestore(url: string, { barrier = PILOT_BARRIER, log = () => {} }: RehearsalOptions = {}): Promise<Rehearsal> {
  if (!isLocalHost(url)) throw new Error("the restore rehearsal drops schemas: it runs against the local stack only")
  const missing = backupTools()
  if (missing !== undefined) throw new Error(`the restore rehearsal needs the PostgreSQL client and age: ${missing}`)
  const work = mkdtempSync(path.join(tmpdir(), "waste-rehearsal-"))
  const owner = createDb(url, { max: 1 })
  try {
    const keygen = (args: string[]): string => {
      const result = spawnSync("age-keygen", args, { encoding: "utf8" })
      if (result.status !== 0) throw new Error(`age-keygen ${args.join(" ")} failed: ${result.stderr}`)
      return result.stdout
    }
    keygen(["-o", path.join(work, "identity.txt")])
    writeFileSync(path.join(work, "recipient.txt"), keygen(["-y", path.join(work, "identity.txt")]))
    const before = await fingerprintDatabase(url)
    const rowsBefore = await readAppliedMigrations(owner.sql)

    const outputs = new Map<string, string>()
    const context = createContext({
      env: {
        ...process.env,
        DATABASE_ADMIN_URL: url,
        PILOT_SUPABASE_REF: "",
        BACKUP_RECIPIENT_FILE: path.join(work, "recipient.txt"),
        AGE_IDENTITY: readFileSync(path.join(work, "identity.txt"), "utf8"),
        SOURCE_RUN_ID: LOCAL_RUN.run.id,
      },
      run: LOCAL_RUN,
      temp: work,
      barrier,
      log,
      output: (name, value) => outputs.set(name, value),
      summary: log,
    })
    const { backup, loginState, restore } = context.layout

    await restorePhases.backUp.run(context)
    if (outputs.get("taken") !== "true") throw new Error("the rehearsal's back-up phase took no backup")
    const source = context.layout.source(BACKUP_ARTIFACT)
    mkdirSync(source.dir, { recursive: true })
    copyFileSync(backup.file, path.join(source.dir, path.basename(backup.file)))
    writeSourceRun(context, BACKUP_ARTIFACT, { run: context.run, commit: context.commit, artifact: { id: 0, name: backup.artifact } })

    await owner.sql.unsafe(DROP_OWNED_SCHEMAS)
    log(`rehearsal: dropped ${OWNED_SCHEMAS.join(", ")}`)

    await restorePhases.decrypt.run(context)
    await restorePhases.record.run(context)
    mkdirSync(loginState.copy, { recursive: true })
    copyFileSync(loginState.file, path.join(loginState.copy, LOGIN_STATE_FILE))
    await restorePhases.apply.run(context)

    const rowsAfter = await readAppliedMigrations(owner.sql)
    if (JSON.stringify(rowsAfter) !== JSON.stringify(rowsBefore)) throw new Error("the restored journal's rows are not the rows backed up")
    const after = await fingerprintDatabase(url)
    const { missing: lost, unexpected } = compareFingerprints(before, after)
    if (lost.length + unexpected.length > 0) {
      throw new Error(`the restored database differs from the fingerprint before the backup:\n${[...lost.map((line) => `- ${line}`), ...unexpected.map((line) => `+ ${line}`)].join("\n")}`)
    }
    const logins = spellLogins(await readLogins(owner.sql, barrier.roles))
    log(`rehearsal: restored ${rowsAfter.length} journal rows and ${verifyBackup(restore).schemas.join(", ")}; the fingerprint matches`)
    return { fingerprint: after, journalRows: rowsAfter.length, logins }
  } finally {
    await owner.close()
    rmSync(work, { recursive: true, force: true })
  }
}
