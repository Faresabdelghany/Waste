// The Pilot's two backup scripts as functions (Issue #152), for the
// operations' phases and the restore rehearsal alike: scripts/pilot-backup.sh
// takes an encrypted backup, scripts/pilot-restore.sh decrypts one and applies
// it. Each runs with the caller's environment and the variables it reads on
// top, never with a URL or a key on its command line, and what it prints is
// said line by line. Whoever calls these has already held the URL to the
// Pilot or the local stack (phase.ts, `adminUrl`).
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { requireFingerprint } from "../fingerprint"
import { requireJournal } from "../migrate"
import { postgresMajor } from "../supabase-config"
import { BACKUP_INCOMPLETE, backupMembers, FINGERPRINT_COPY, majorOf } from "./backup"
import type { RunRef } from "./run"

const SCRIPTS = fileURLToPath(new URL("../../scripts", import.meta.url))

type Environment = Readonly<Record<string, string | undefined>>
type Log = (line: string) => void

/** Whether this machine has what the scripts need: the PostgreSQL client of the server's major (supabase/config.toml) and age. The reason when not. */
export function backupTools(): string | undefined {
  const major = postgresMajor()
  const version = spawnSync("pg_dump", ["--version"], { encoding: "utf8" })
  if (version.status !== 0) return `pg_dump is not on PATH (install PostgreSQL client ${major})`
  if (majorOf(version.stdout.trim()) !== major) return `pg_dump is ${version.stdout.trim()}, not PostgreSQL client ${major}`
  const psql = spawnSync("psql", ["--version"], { encoding: "utf8" })
  if (psql.status !== 0 || majorOf(psql.stdout.trim()) !== major) return `psql ${major} is not on PATH`
  for (const tool of ["age", "age-keygen"]) {
    if (spawnSync(tool, ["--version"], { encoding: "utf8" }).status !== 0) return `${tool} is not on PATH`
  }
  return undefined
}

function runScript(script: string, args: readonly string[], env: Record<string, string | undefined>, log: Log): number {
  const result = spawnSync("bash", [path.join(SCRIPTS, script), ...args], { env, encoding: "utf8" })
  if (result.error !== undefined) throw result.error
  const said = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
  if (said !== "") for (const line of said.split("\n")) log(line)
  return result.status ?? 1
}

export type BackupOptions = {
  env: Environment
  /** The owner's URL, already held to its target. */
  url: string
  /** The encrypted file to write; its directory is made. */
  output: string
  /** The `mktemp -d` template of the directory the dumps live in until they are encrypted (phase.ts, `layout`). */
  scratch: string
  /** The run and the commit the manifest records. */
  run: RunRef
  commit: string
  /** A restore's safety backup goes on without a backup where the database lacks a schema a backup requires; anything else refuses that. */
  tolerateIncomplete?: boolean
  log: Log
}

/** pilot-backup.sh against the URL, encrypted to the committed recipient (or env's BACKUP_RECIPIENT_FILE). Answers whether a backup was taken: not, only where an incomplete database is tolerated. */
export function backUpDatabase({ env, url, output, scratch, run, commit, tolerateIncomplete = false, log }: BackupOptions): { taken: boolean } {
  mkdirSync(path.dirname(output), { recursive: true })
  const status = runScript(
    "pilot-backup.sh",
    [],
    { ...env, DATABASE_ADMIN_URL: url, BACKUP_OUTPUT: output, BACKUP_SCRATCH: scratch, GITHUB_RUN_ID: run.id, GITHUB_RUN_ATTEMPT: run.attempt, GITHUB_SHA: commit },
    log,
  )
  if (status === 0) return { taken: true }
  if (status === BACKUP_INCOMPLETE && tolerateIncomplete) return { taken: false }
  throw new Error(`pilot-backup.sh failed (exit ${status})`)
}

/**
 * pilot-restore.sh decrypt: the archive decrypted with the age identity and
 * unpacked into `dir`, its members held to a backup's (`backupMembers`, handed
 * over here, so nothing but bash and age holds the key), the key in a
 * directory made from the `scratch` template.
 */
export function decryptBackup({ env, archive, identity, dir, scratch, log }: { env: Environment; archive: string; identity: string; dir: string; scratch: string; log: Log }): void {
  const status = runScript(
    "pilot-restore.sh",
    ["decrypt"],
    { ...env, BACKUP_FILE: archive, AGE_IDENTITY: identity, RESTORE_DIR: dir, BACKUP_MEMBERS: backupMembers().join("\n"), RESTORE_KEY_SCRATCH: scratch },
    log,
  )
  if (status !== 0) throw new Error(`pilot-restore.sh decrypt failed (exit ${status})`)
}

/**
 * pilot-restore.sh apply — the owned schemas dropped and the verified backup
 * in `dir` restored, in one transaction — and the restored database proved:
 * the journal check, and the backup's own fingerprint, since the committed one
 * describes the head and the backup may be older.
 */
export async function restoreDatabase({ env, url, dir, log }: { env: Environment; url: string; dir: string; log: Log }): Promise<void> {
  const status = runScript("pilot-restore.sh", ["apply"], { ...env, DATABASE_ADMIN_URL: url, RESTORE_DIR: dir }, log)
  if (status !== 0) throw new Error(`pilot-restore.sh apply failed (exit ${status})`)
  await requireJournal(url, log)
  await requireFingerprint(url, log, { text: readFileSync(path.join(dir, FINGERPRINT_COPY), "utf8"), name: "the backup's fingerprint" })
}
