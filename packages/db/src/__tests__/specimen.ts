// A specimen table is a Drizzle table a test defines for itself, creates
// inside its own transaction and rolls back with it, so a column type, a
// column set or a SQL helper is proved against the real database without a
// migration. Its DDL comes from drizzle-kit's own generator (drizzle-kit/api),
// the code `pnpm db:generate` runs, with the package's casing: what a specimen
// test proves about a type string or a check is what a migration file will
// say.
import { sql } from "drizzle-orm"
import type { PgTable } from "drizzle-orm/pg-core"
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api"

import config from "../../drizzle.config"
import type { Db } from "../client"
import { wms } from "../schema/wms"

/** A Drizzle transaction on the package's client. Nested, it is a savepoint. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/** The statements `drizzle-kit generate` would write for these tables on a database where `wms` already exists. */
export async function statementsFor(tables: Record<string, PgTable>): Promise<string[]> {
  const before = generateDrizzleJson({ wms }, undefined, undefined, config.casing)
  const after = generateDrizzleJson({ wms, ...tables }, before.id, undefined, config.casing)
  return generateMigration(before, after)
}

export async function createSpecimen(tx: Tx, tables: Record<string, PgTable>): Promise<void> {
  for (const statement of await statementsFor(tables)) await tx.execute(sql.raw(statement))
}

class Rollback<T> {
  constructor(readonly result: T) {}
}

/** Runs `fn` in a transaction that is always rolled back, and returns what it returned. */
export async function rolledBack<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    await db.transaction(async (tx) => {
      throw new Rollback(await fn(tx))
    })
  } catch (error) {
    if (error instanceof Rollback) return error.result as T
    throw error
  }
  throw new Error("rolledBack: the transaction returned instead of rolling back")
}
