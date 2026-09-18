// Applies the SQL migrations under ./migrations to one database, through the
// same journal drizzle-kit writes (schema `drizzle`, table
// `__drizzle_migrations`; drizzle.config.ts names the same pair). This is the
// one way migrations are applied: the `migrate` script, the tests and CI all
// call it, so the hosted project and a test database go through identical
// code.
//
// Two processes migrating the same database at once (two API replicas
// starting, two test files in parallel) would both find the journal short and
// both try to create the same objects; an advisory lock held on a reserved
// connection for the duration serialises them, and the second finds nothing
// left to apply.
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { fileURLToPath } from "node:url"

import { createDb } from "./client"

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url))
export const MIGRATIONS_SCHEMA = "drizzle"
export const MIGRATIONS_TABLE = "__drizzle_migrations"

/** Any constant will do for pg_advisory_lock; this one spells "wms". */
const MIGRATION_LOCK = 0x77_6d_73

export async function migrateDatabase(url: string): Promise<void> {
  // One connection runs the migrations, one holds the lock.
  const { db, sql, close } = createDb(url, { max: 2 })
  try {
    const lock = await sql.reserve()
    try {
      await lock`select pg_advisory_lock(${MIGRATION_LOCK})`
      try {
        await migrate(db, {
          migrationsFolder: MIGRATIONS_FOLDER,
          migrationsSchema: MIGRATIONS_SCHEMA,
          migrationsTable: MIGRATIONS_TABLE,
        })
      } finally {
        await lock`select pg_advisory_unlock(${MIGRATION_LOCK})`
      }
    } finally {
      lock.release()
    }
  } finally {
    await close()
  }
}
