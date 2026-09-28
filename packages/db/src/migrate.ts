// Applies the SQL migrations under ./migrations to one database, through the
// journal drizzle-kit writes for them: schema `drizzle`, table
// `__drizzle_migrations`, one row per applied file with its sha256 and its
// journal `when`. This is the one way migrations are applied: the `migrate`
// script, the tests and the Pilot's protected release (Issue #152) all go
// through it.
//
// What drizzle-orm's migrator does and does not do, so nobody relies on the
// wrong thing: it applies every journal entry whose `when` is later than the
// newest row in the table, in journal order, all in one transaction. It never
// compares hashes, so an edited applied file would not be re-applied, and a
// migration merged with an earlier `when` than one already applied would be
// skipped for good. The journal check (journal-check.ts) is what compares:
// it runs under the lock below, before the migrator writes anything — its
// schema and table included — and refuses a journal that disagrees with the
// folder, so a database migrated from another version of a file is stopped
// here instead of carrying on. `checkDatabaseJournal` asks the same question
// without applying anything (`pnpm db:check`).
//
// Two processes migrating the same database at once (two test files, two
// operators) would both find the journal short and both try to create the
// same objects. A session-level advisory lock on a reserved connection
// serialises them; the second finds nothing left to apply. That lock needs
// one backend for the whole call, which a transaction pooler does not give,
// so such URLs are refused up front rather than left to leak the lock.
//
// Every migration runs with `search_path = wms, extensions`, sent as a startup
// parameter of the migrator's own connections. The hand-written files qualify
// every name, but a generated one spells a column type the way drizzle-kit
// renders it, and drizzle-kit quotes any type it does not recognise, so a
// PostGIS column is `geometry(Point, 4326)` bare (schema/geometry.ts). That
// name resolves here the same way on every server, and the same way it does
// for the API role, whose login carries the same path; without this it would
// depend on the owner role's setting, which on Supabase happens to include
// `extensions` and elsewhere does not.
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { fileURLToPath } from "node:url"
import type { Notice, ReservedSql } from "postgres"

import { createDb, type Db } from "./client"
import { assertJournal, checkJournal, MIGRATIONS_SCHEMA, MIGRATIONS_TABLE, readAppliedMigrations, readMigrationFolder, type JournalReport } from "./journal-check"

export { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE }
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url))

/** Any constant will do for pg_advisory_lock; this one spells "wms". */
const MIGRATION_LOCK = 0x77_6d_73
/** How long to wait for another migrator before giving up; a real migration finishes well inside it. */
const LOCK_TIMEOUT = "60s"
/** Supabase's transaction pooler: one backend per statement, no session state. */
const TRANSACTION_POOLER_PORT = "6543"
/** What unqualified names in a migration resolve through: the API role's own path (see the foundation migration). */
export const MIGRATION_SEARCH_PATH = "wms, extensions"

export type MigrateOptions = {
  /** Where Postgres NOTICE messages from the migrations go; dropped by default. */
  onnotice?: (notice: Notice) => void
}

/**
 * Runs `fn` while this connection holds the migration lock: the pool for the
 * work, the reserved connection that holds the lock for reads that must see
 * the journal as it stands under it. Every holder of the lock goes through
 * here — the migrator, the journal check, a Pilot repair (Issue #152).
 */
export async function withMigrationLock<T>(
  url: string,
  { onnotice }: MigrateOptions,
  fn: (held: { db: Db; lock: ReservedSql }) => Promise<T>,
): Promise<T> {
  if (new URL(url).port === TRANSACTION_POOLER_PORT) {
    throw new Error(
      `migrateDatabase: ${new URL(url).hostname}:${TRANSACTION_POOLER_PORT} is the transaction pooler; migrations need a session (the direct connection or the session pooler on port 5432)`,
    )
  }
  // One connection runs the work, one holds the lock.
  const { db, sql, close } = createDb(url, { max: 2, onnotice, searchPath: MIGRATION_SEARCH_PATH })
  try {
    const lock = await sql.reserve()
    try {
      await lock`select set_config('lock_timeout', ${LOCK_TIMEOUT}, false)`
      await lock`select pg_advisory_lock(${MIGRATION_LOCK})`
      let result: T | undefined
      let failure: unknown
      try {
        result = await fn({ db, lock })
      } catch (error) {
        failure = error
      }
      const [{ released }] = await lock<{ released: boolean }[]>`select pg_advisory_unlock(${MIGRATION_LOCK}) as released`
      if (failure !== undefined) throw failure
      if (!released) {
        throw new Error("migrateDatabase: the migration lock was not held by the connection that tried to release it; is the URL a pooler in transaction mode?")
      }
      return result as T
    } finally {
      lock.release()
    }
  } finally {
    await close()
  }
}

/** The journal check against this checkout's folder, read on the connection that holds the lock. */
async function journalUnderLock(lock: ReservedSql): Promise<JournalReport> {
  return checkJournal(readMigrationFolder(MIGRATIONS_FOLDER), await readAppliedMigrations(lock))
}

/**
 * Applies every pending migration, after the journal check has passed, and
 * answers the ones it applied; a refused journal throws `JournalError` and
 * nothing is written.
 */
export async function migrateDatabase(url: string, options: MigrateOptions = {}): Promise<{ applied: string[] }> {
  return withMigrationLock(url, options, async ({ db, lock }) => {
    const report = await journalUnderLock(lock)
    assertJournal(report)
    await migrate(db, {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsSchema: MIGRATIONS_SCHEMA,
      migrationsTable: MIGRATIONS_TABLE,
    })
    return { applied: report.pending }
  })
}

/** The journal check alone, under the same lock (`pnpm db:check`): what is applied, what is pending, and every problem. Writes nothing. */
export async function checkDatabaseJournal(url: string, options: MigrateOptions = {}): Promise<JournalReport> {
  return withMigrationLock(url, options, ({ lock }) => journalUnderLock(lock))
}
