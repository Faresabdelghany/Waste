// The journal check (Issue #152, decided in #133): does the database's
// migration journal agree with the migrations folder of this checkout? Asked
// by `migrateDatabase` under its advisory lock before it writes anything, and
// by `pnpm db:check` on its own, over the same rules.
//
// drizzle-orm's migrator is trusting (migrate.ts says how): it applies every
// journal entry later than the newest row of `drizzle.__drizzle_migrations`
// and never compares hashes. So a database migrated from an edited file, from
// another branch or by a hand replay carries on as if nothing were wrong, and
// the difference surfaces as an object that is not what the file says. This
// check refuses such a journal instead, naming each disagreement:
//
// - an applied row whose `when` maps to no journal entry, to several, or to an
//   entry another row already recorded;
// - an applied row whose hash is not the sha256 of its file (a merged
//   migration is never edited: migrations/README.md);
// - an entry the migrator would skip for good, unapplied with a later one
//   applied;
// - a folder that disagrees with its own journal: a listed file missing, a
//   file the journal does not list, an entry not later than the one before.
//
// Pending entries whose files are there pass: that is what a migration is for.
// The file's hash is computed exactly as the migrator computes it (the text
// read as UTF-8 and hashed as a string), so the two agree on every file.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import type { ReservedSql, Sql } from "postgres"

import { sha256 } from "./sha256"

/** Where drizzle-orm's migrator keeps its journal: schema `drizzle`, table `__drizzle_migrations`. */
export const MIGRATIONS_SCHEMA = "drizzle"
export const MIGRATIONS_TABLE = "__drizzle_migrations"

/** One entry of `meta/_journal.json` with the sha256 of its file; `hash` is null where the file is missing. */
export type MigrationFile = { tag: string; when: number; hash: string | null }

/** What the migrations folder holds: its journal's entries in order, and any SQL file the journal does not list. */
export type MigrationFolder = { files: MigrationFile[]; unlisted: string[] }

/** One row of the database's journal. `createdAt` is the bigint as text, null where nothing was recorded. */
export type AppliedMigration = { id: number; hash: string; createdAt: string | null }

export type JournalReport = {
  /** The entries the database recorded, in journal order. */
  applied: string[]
  /** The entries the migrator would apply next, in journal order. */
  pending: string[]
  /** Every disagreement, one sentence each; empty when the journal is sound. */
  problems: string[]
}

type Entry = { tag: string; when: number }

/** Reads a migrations folder the way drizzle-orm's `readMigrationFiles` does, without failing on the first missing file. */
export function readMigrationFolder(folder: string): MigrationFolder {
  const journal: { entries: Entry[] } = JSON.parse(readFileSync(path.join(folder, "meta", "_journal.json"), "utf8"))
  const files = journal.entries.map(({ tag, when }) => {
    const file = path.join(folder, `${tag}.sql`)
    return { tag, when, hash: existsSync(file) ? sha256OfMigration(file) : null }
  })
  const listed = new Set(files.map((file) => file.tag))
  const unlisted = readdirSync(folder)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.slice(0, -".sql".length))
    .filter((tag) => !listed.has(tag))
    .sort()
  return { files, unlisted }
}

/** The hash the migrator records for a file: sha256 of its text read as a UTF-8 string. */
export function sha256OfMigration(file: string): string {
  return sha256(readFileSync(file).toString())
}

/** The database's journal rows by id, or none where the journal table does not exist yet. Reads, never creates. */
export async function readAppliedMigrations(sql: Sql | ReservedSql): Promise<AppliedMigration[]> {
  const table = `${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`
  const [{ present }] = await sql<{ present: boolean }[]>`select to_regclass(${table}) is not null as present`
  if (!present) return []
  const rows = await sql<{ id: number; hash: string; created_at: string | null }[]>`
    select id, hash, created_at::text as created_at from ${sql(MIGRATIONS_SCHEMA)}.${sql(MIGRATIONS_TABLE)} order by id`
  return rows.map(({ id, hash, created_at }) => ({ id, hash, createdAt: created_at }))
}

/** Two or more tags as a sentence lists them: `a and b`, `a, b and c`. */
const listing = (tags: readonly string[]) => `${tags.slice(0, -1).join(", ")} and ${tags.at(-1)}`

/** The rules of the journal check over plain shapes: what the folder says against what the database recorded. */
export function checkJournal(folder: MigrationFolder, rows: readonly AppliedMigration[]): JournalReport {
  const problems: string[] = []
  const { files } = folder

  // The folder against its own journal. The migrator cannot read a journal
  // whose file is missing, whatever the database holds.
  for (const tag of folder.unlisted) {
    problems.push(`${tag}.sql is in the migrations folder but not in the journal, so the migrator never applies it`)
  }
  const byWhen = new Map<number, MigrationFile[]>()
  for (const file of files) byWhen.set(file.when, [...(byWhen.get(file.when) ?? []), file])
  for (const [when, shared] of byWhen) {
    if (shared.length > 1) problems.push(`${listing(shared.map((file) => file.tag))} share the journal timestamp ${when}`)
  }
  files.forEach((file, index) => {
    const previous = files[index - 1]
    if (previous !== undefined && file.when < previous.when) {
      problems.push(`${file.tag} (${file.when}) is not later than ${previous.tag} (${previous.when}): a database that has applied ${previous.tag} would skip it`)
    }
  })

  // The database's rows against the folder.
  const recordedBy = new Map<string, number>()
  let newest: number | undefined
  const last = files.at(-1)
  for (const row of rows) {
    if (row.createdAt === null || !/^\d+$/.test(row.createdAt)) {
      problems.push(`Journal row ${row.id} has no timestamp, so it maps to no migration of the journal`)
      continue
    }
    const when = Number(row.createdAt)
    newest = newest === undefined ? when : Math.max(newest, when)
    const matches = byWhen.get(when) ?? []
    if (matches.length === 0) {
      problems.push(
        last !== undefined && when > last.when
          ? `Journal row ${row.id} (${when}) is later than ${last.tag}, the last migration of this checkout: the database was migrated from a newer commit or another branch`
          : `Journal row ${row.id} (${when}) maps to no migration of the journal`,
      )
      continue
    }
    if (matches.length > 1) {
      problems.push(`Journal row ${row.id} (${when}) maps to more than one migration: ${listing(matches.map((file) => file.tag))}`)
      continue
    }
    const [file] = matches
    const earlier = recordedBy.get(file.tag)
    if (earlier !== undefined) {
      problems.push(`${file.tag} is recorded twice, by journal rows ${earlier} and ${row.id}`)
      continue
    }
    recordedBy.set(file.tag, row.id)
    if (file.hash === null) {
      problems.push(`${file.tag} is applied, but ${file.tag}.sql is not in the migrations folder`)
    } else if (file.hash !== row.hash) {
      problems.push(`${file.tag} was applied from another version of its file: the journal recorded sha256 ${row.hash}, ${file.tag}.sql hashes to ${file.hash}`)
    }
  }

  // What the migrator would do next: apply every entry later than the newest
  // row, so an unapplied entry at or before it is skipped for good. An entry
  // whose timestamp another shares is already refused above, and says nothing
  // more here.
  const applied: string[] = []
  const pending: string[] = []
  for (const file of files) {
    if (recordedBy.has(file.tag)) {
      applied.push(file.tag)
      continue
    }
    if ((byWhen.get(file.when) ?? []).length > 1) continue
    if (file.hash === null) {
      problems.push(`${file.tag} is in the journal, but ${file.tag}.sql is not in the migrations folder, so the migrator cannot read the journal`)
      continue
    }
    if (newest !== undefined && file.when <= newest) {
      problems.push(`${file.tag} is not applied, but a later migration is: the migrator applies only what is later than the newest row, so it would skip ${file.tag} for good`)
      continue
    }
    pending.push(file.tag)
  }
  return { applied, pending, problems }
}

/** A journal the check refused, every problem in the message. */
export class JournalError extends Error {
  readonly problems: readonly string[]
  constructor(problems: readonly string[]) {
    super(
      `The migration journal disagrees with the migrations folder:\n${problems.map((problem) => `- ${problem}`).join("\n")}\n` +
        "A disposable database is reset, never accepted; the Pilot is corrected forward (packages/db/migrations/README.md).",
    )
    this.name = "JournalError"
    this.problems = problems
  }
}

/** Throws the report's problems, if it has any. */
export function assertJournal(report: JournalReport): void {
  if (report.problems.length > 0) throw new JournalError(report.problems)
}
