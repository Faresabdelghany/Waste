// Applies the SQL migrations under ./migrations to one database, through the
// journal drizzle-kit writes for them: schema `drizzle`, table
// `__drizzle_migrations`, one row per applied file with its sha256 and its
// journal `when`. This is the one way migrations are applied: the `migrate`
// script, the tests and the hosted project all go through it.
//
// What the migrator does and does not do, so nobody relies on the wrong thing:
// it applies every journal entry whose `when` is later than the newest row in
// the table, in journal order, all in one transaction. It never compares
// hashes, so an edited applied file is not re-applied (the hash test in
// __tests__ catches the edit on a fresh database), and a migration merged with
// an earlier `when` than one already applied would be skipped for good (the
// journal test refuses a non-monotonic journal).
//
// Two processes migrating the same database at once (two test files, two
// operators) would both find the journal short and both try to create the
// same objects. A session-level advisory lock on a reserved connection
// serialises them; the second finds nothing left to apply. That lock needs
// one backend for the whole call, which a transaction pooler does not give,
// so such URLs are refused up front rather than left to leak the lock.
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { fileURLToPath } from "node:url"
import type { Notice } from "postgres"

import { createDb } from "./client"

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url))
export const MIGRATIONS_SCHEMA = "drizzle"
export const MIGRATIONS_TABLE = "__drizzle_migrations"

/** Any constant will do for pg_advisory_lock; this one spells "wms". */
const MIGRATION_LOCK = 0x77_6d_73
/** How long to wait for another migrator before giving up; a real migration finishes well inside it. */
const LOCK_TIMEOUT = "60s"
/** Supabase's transaction pooler: one backend per statement, no session state. */
const TRANSACTION_POOLER_PORT = "6543"

export type MigrateOptions = {
  /** Where Postgres NOTICE messages from the migrations go; dropped by default. */
  onnotice?: (notice: Notice) => void
}

export async function migrateDatabase(url: string, { onnotice }: MigrateOptions = {}): Promise<void> {
  if (new URL(url).port === TRANSACTION_POOLER_PORT) {
    throw new Error(
      `migrateDatabase: ${new URL(url).hostname}:${TRANSACTION_POOLER_PORT} is the transaction pooler; migrations need a session (the direct connection or the session pooler on port 5432)`,
    )
  }
  // One connection runs the migrations, one holds the lock.
  const { db, sql, close } = createDb(url, { max: 2, onnotice })
  try {
    const lock = await sql.reserve()
    try {
      await lock`select set_config('lock_timeout', ${LOCK_TIMEOUT}, false)`
      await lock`select pg_advisory_lock(${MIGRATION_LOCK})`
      let failure: unknown
      try {
        await migrate(db, {
          migrationsFolder: MIGRATIONS_FOLDER,
          migrationsSchema: MIGRATIONS_SCHEMA,
          migrationsTable: MIGRATIONS_TABLE,
        })
      } catch (error) {
        failure = error
      }
      const [{ released }] = await lock<{ released: boolean }[]>`select pg_advisory_unlock(${MIGRATION_LOCK}) as released`
      if (failure !== undefined) throw failure
      if (!released) {
        throw new Error("migrateDatabase: the migration lock was not held by the connection that tried to release it; is the URL a pooler in transaction mode?")
      }
    } finally {
      lock.release()
    }
  } finally {
    await close()
  }
}
