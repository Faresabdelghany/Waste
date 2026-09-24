// The one write the seed makes: `insert ... on conflict (id) do update`, with
// the update skipped when the stored row already says what this run proposes.
// Spelled once here for every seeded table, Organisation & Access and the
// Registry alike, so a table cannot be idempotent in a way of its own.
//
// Why the skip matters: an `on conflict do update` that always writes fires
// the `updated_at` trigger on every run, so `updated_at` would say when the
// seed last ran and not when the value last changed, and CI's "a second run
// writes nothing" would be a lie. `changesSomething` is the `WHERE` of the
// `DO UPDATE`: a row comparison of the owned columns against `excluded`, `IS
// DISTINCT FROM` so two nulls count as equal; a geometry column takes part
// through PostGIS's `=`, which is coordinate equality since 2.4.
//
// What a table owns is the caller's list: the data columns the seed spells.
// Never the id (the key), the tenant and project columns (a reference nothing
// should move), the stamps (the trigger's), and never a column another actor
// writes — an account's `auth_user_id` and `deactivated_at` are the hook's and
// the API's, which is why demo.ts leaves them out of USER_COLUMNS.
import { sql, type SQL } from "drizzle-orm"
import type { PgColumn, PgInsertValue, PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core"

import type { Tx } from "../client"
import { columnName } from "../names"

/** `excluded.<column>`: the value this run proposed for a row that is already there. */
const proposed = (column: PgColumn): SQL => sql`excluded.${sql.identifier(columnName(column))}`

/**
 * The stored column, qualified by its table: inside `DO UPDATE` both the row
 * found and `excluded` are in scope, so a bare column name is ambiguous
 * (42702).
 */
const stored = (column: PgColumn): SQL => sql`${column}`

/**
 * How Drizzle's `set` is keyed: by the column's property name, not its name in
 * the database. Every column of this schema is declared without a name of its
 * own (the casing makes it), so the property name is what the column carries;
 * a column declared otherwise is refused here rather than silently set wrong.
 */
function propertyOf(column: PgColumn): string {
  if (!column.keyAsName) {
    throw new Error(`the seed keys its updates by property name, and ${columnName(column)} was declared with a name of its own`)
  }
  return column.name
}

/** The columns the seed owns, set back to what this run proposed. */
export function restore(columns: readonly PgColumn[]): Record<string, SQL> {
  return Object.fromEntries(columns.map((column) => [propertyOf(column), proposed(column)]))
}

/**
 * True when the stored row disagrees with the one this run proposed. As the
 * `WHERE` of `DO UPDATE` it makes an unchanged row no write at all, so the
 * touch trigger does not fire and `updated_at` still says when the value last
 * really changed.
 */
export function changesSomething(columns: readonly PgColumn[]): SQL {
  return sql`(${sql.join(columns.map(stored), sql`, `)}) is distinct from (${sql.join(columns.map(proposed), sql`, `)})`
}

/** A table the seed can key by its `id` column, which every table of the schema spreads from columns.ts. */
type SeededTable = PgTable & { id: PgColumn }

/**
 * Inserts the rows, restores the owned columns of any that are already there
 * and differ, and answers how many rows were written — inserted or updated;
 * a row that already said all of this is not counted, because it was not
 * touched.
 */
export async function upsertOwned<T extends SeededTable>(tx: Tx, table: T, rows: readonly T["$inferInsert"][], owned: readonly PgColumn[]): Promise<number> {
  if (rows.length === 0) return 0
  if (owned.length === 0) {
    throw new Error(`upsertOwned: a table with no owned columns has nothing to restore; use onConflictDoNothing instead`)
  }
  const written = await tx
    .insert(table)
    .values([...rows] as PgInsertValue<T>[])
    .onConflictDoUpdate({ target: table.id, set: restore(owned) as PgUpdateSetSource<T>, setWhere: changesSomething(owned) })
    .returning({ id: table.id })
  return written.length
}
