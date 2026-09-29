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
//
// The second write is for a set: the rows of one parent that the API
// replaces whole — deleted, and written back under ids it mints — on every
// edit of the set, a calendar's holidays or a collection group's picks among
// them (Issue #156). Keyed by its id such a row would meet its own content
// under another id after the first edit through the product, and the next
// run would stop at the set's unique key (23505) — the failure #140 met with
// an account's access rows, which are the pair they join for the same reason.
// So a set is compared by its content, parent by parent, and a set that
// differs is replaced whole, the way the API replaces it; one that says what
// this run proposes, whatever its ids, is not touched.
import { getTableName, inArray, sql, type SQL } from "drizzle-orm"
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
  // A column of another table would render as that table's name inside this
  // table's DO UPDATE and fail as 42P01 at run time, or worse, resolve to a
  // same-named column here; refused by name, as excludeOverlapping refuses one.
  for (const column of owned) {
    if (column.table !== table) {
      throw new Error(`upsertOwned: column "${columnName(column)}" is not a column of "${getTableName(table)}"`)
    }
  }
  const written = await tx
    .insert(table)
    .values([...rows] as PgInsertValue<T>[])
    .onConflictDoUpdate({ target: table.id, set: restore(owned) as PgUpdateSetSource<T>, setWhere: changesSomething(owned) })
    .returning({ id: table.id })
  return written.length
}

/** One member of a set as its compared columns say it, the way two members are told apart: a null and an absent value are one. */
const memberKey = (values: readonly unknown[]): string => JSON.stringify(values.map((value) => value ?? null))

/** Two sets as their members' keys: the same members, as often each. */
const sameMembers = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n")

/**
 * Writes the sets of `parents` — every parent whose set this run owns, an
 * empty set included — and answers how many rows it wrote. Parent by parent,
 * the stored set is compared with the proposed one on `compared`, the
 * member's columns; where they differ, the parent's rows are deleted and the
 * proposed ones inserted under their fixed ids, and where they agree nothing
 * is written, whatever ids the stored members carry.
 */
export async function replaceSets<T extends SeededTable>(
  tx: Tx,
  table: T,
  parent: PgColumn,
  parents: readonly string[],
  rows: readonly T["$inferInsert"][],
  compared: readonly PgColumn[],
): Promise<number> {
  if (parents.length === 0) return 0
  for (const column of [parent, ...compared]) {
    if (column.table !== table) {
      throw new Error(`replaceSets: column "${columnName(column)}" is not a column of "${getTableName(table)}"`)
    }
  }
  const parentOf = (row: Record<string, unknown>): string => row[propertyOf(parent)] as string
  const keyOf = (row: Record<string, unknown>): string => memberKey(compared.map((column) => row[propertyOf(column)]))

  const proposed = new Map<string, string[]>(parents.map((id) => [id, []]))
  for (const row of rows as Record<string, unknown>[]) {
    const members = proposed.get(parentOf(row))
    if (members === undefined) throw new Error(`replaceSets: a proposed row of "${getTableName(table)}" names ${parentOf(row)}, which is not one of its parents`)
    members.push(keyOf(row))
  }
  const found = new Map<string, string[]>(parents.map((id) => [id, []]))
  const stored = (await tx
    .select(Object.fromEntries([parent, ...compared].map((column) => [propertyOf(column), column])))
    .from(table as PgTable)
    .where(inArray(parent, [...parents]))) as Record<string, unknown>[]
  for (const row of stored) found.get(parentOf(row))?.push(keyOf(row))

  const differing = parents.filter((id) => !sameMembers(found.get(id) ?? [], proposed.get(id) ?? []))
  if (differing.length === 0) return 0
  const deleted = await tx.delete(table).where(inArray(parent, differing)).returning({ id: table.id })
  const replacing = (rows as Record<string, unknown>[]).filter((row) => differing.includes(parentOf(row)))
  const inserted = replacing.length === 0 ? [] : await tx.insert(table).values(replacing as PgInsertValue<T>[]).returning({ id: table.id })
  return deleted.length + inserted.length
}
