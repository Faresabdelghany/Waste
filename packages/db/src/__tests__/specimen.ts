// A specimen table is a Drizzle table a test defines for itself, creates
// inside its own transaction and rolls back with it, so a column type, a
// column set or a SQL helper is proved against the real database without a
// migration. Its DDL comes from drizzle-kit's own generator (drizzle-kit/api),
// the code `pnpm db:generate` runs, with the package's casing: what a specimen
// test proves about a type string or a check is what a migration file will
// say.
//
// Two rules the helpers cannot enforce. A specimen table's name belongs to one
// file, and to one table object in it: node's test runner runs files in
// parallel processes, and two transactions creating the same table wait on
// each other or deadlock; and Drizzle's casing cache keys columns by schema
// and table name, so a second table object of the same name on one client
// fails with a TypeError after its CREATE TABLE succeeded. And a statement
// expected to fail runs in its own savepoint, `tx.transaction((savepoint) =>
// ...)`, because a failed statement aborts the transaction it ran in; `fn`
// itself runs in a savepoint here, so a failure that `fn` swallowed still
// rejects the run, as it would in a plain transaction.
import assert from "node:assert/strict"

import { sql } from "drizzle-orm"
import type { PgTable } from "drizzle-orm/pg-core"
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api"

import { CASING } from "../casing"
import type { Db, Tx } from "../client"
import { wms } from "../schema/wms"

export type { Tx }

/** The statements `drizzle-kit generate` would write for these tables on a database where `wms` already exists. */
export async function statementsFor(tables: Record<string, PgTable>): Promise<string[]> {
  const before = generateDrizzleJson({ wms }, undefined, undefined, CASING)
  const after = generateDrizzleJson({ wms, ...tables }, before.id, undefined, CASING)
  return generateMigration(before, after)
}

export async function createSpecimen(tx: Tx, tables: Record<string, PgTable>): Promise<void> {
  for (const statement of await statementsFor(tables)) await tx.execute(sql.raw(statement))
}

class Rollback<T> {
  constructor(readonly result: T) {}
}

/**
 * Runs `fn` inside the transaction `open` starts (`db.transaction`, or
 * `withCompany` on the pool), always rolls it back, and returns what `fn`
 * returned.
 */
export async function rolledBackIn<T>(open: (body: (tx: Tx) => Promise<never>) => Promise<unknown>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    await open(async (tx) => {
      throw new Rollback(await tx.transaction(fn))
    })
  } catch (error) {
    if (error instanceof Rollback) return error.result as T
    throw error
  }
  throw new Error("rolledBack: the transaction returned instead of rolling back")
}

/** Runs `fn` in a transaction that is always rolled back, and returns what it returned. */
export const rolledBack = <T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> => rolledBackIn((body) => db.transaction(body), fn)

/** The specimen tables, created and rolled back with the test's own transaction. */
export const withSpecimen = <T>(db: Db, tables: Record<string, PgTable>, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  rolledBack(db, async (tx) => {
    await createSpecimen(tx, tables)
    return fn(tx)
  })

/** The SQLSTATE of a failed statement, through Drizzle's wrapper or straight from postgres.js. */
export const sqlstate = (error: unknown): string | undefined => {
  const own = (error as { code?: unknown }).code
  if (typeof own === "string") return own
  const cause = (error as { cause?: { code?: unknown } }).cause?.code
  return typeof cause === "string" ? cause : undefined
}

/** For `assert.rejects`: the statement failed with this SQLSTATE and a message matching. */
export const refusedWith =
  (code: string, message: RegExp) =>
  (error: unknown): boolean => {
    assert.equal(sqlstate(error), code, String(error))
    assert.match(String(error) + String((error as { cause?: unknown }).cause ?? ""), message)
    return true
  }
