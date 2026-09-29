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
// this run proposes, whatever its ids, is not touched. A set whose members
// carry a set of their own — a vehicle's compartments, each with the
// fractions it takes, which `PUT /vehicles/{id}/compartments` replaces
// together — is compared and replaced with it, the inner set first out and
// last in.
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

/** The rows of a set, and what tells two of its members apart. */
type SetOf<T extends SeededTable> = {
  table: T
  /** The column naming what the row belongs to: the set's parent, or the member of the outer set it is carried by. */
  of: PgColumn
  rows: readonly T["$inferInsert"][]
  /** The member's own columns, beside `of`. */
  compared: readonly PgColumn[]
}

/** The sets of `parents` — every parent whose set this run owns, an empty set included — and a set each member carries, where it carries one. */
export type SeededSets<T extends SeededTable, N extends SeededTable> = SetOf<T> & {
  parents: readonly string[]
  nested?: SetOf<N>
}

/** A row's value of a column, keyed as Drizzle keys it: by the column's property name. */
const valueOf = (row: Record<string, unknown>, column: PgColumn): unknown => row[propertyOf(column)]

function refuseForeign(set: { table: PgTable; of: PgColumn; compared: readonly PgColumn[] }): void {
  for (const column of [set.of, ...set.compared]) {
    if (column.table !== set.table) throw new Error(`replaceSets: column "${columnName(column)}" is not a column of "${getTableName(set.table)}"`)
  }
}

/**
 * Writes the sets and answers how many rows it wrote. Parent by parent, the
 * stored set is compared with the proposed one — each member on its
 * `compared` columns and, with `nested`, on the set it carries — and where
 * they differ the parent's rows are deleted and the proposed ones inserted
 * under their fixed ids; where they agree nothing is written, whatever ids
 * the stored members carry.
 */
export async function replaceSets<T extends SeededTable, N extends SeededTable = SeededTable>(tx: Tx, sets: SeededSets<T, N>): Promise<number> {
  const { table, of, parents, compared, nested } = sets
  if (parents.length === 0) return 0
  refuseForeign(sets)
  if (nested) refuseForeign(nested)
  const rows = sets.rows as readonly Record<string, unknown>[]
  const inner = (nested?.rows ?? []) as readonly Record<string, unknown>[]

  /** The keys of the inner members, by the id of the member that carries them. */
  const carriedBy = (innerRows: readonly Record<string, unknown>[]): Map<string, string[]> => {
    const byMember = new Map<string, string[]>()
    for (const row of innerRows) {
      const member = valueOf(row, nested!.of) as string
      byMember.set(member, [...(byMember.get(member) ?? []), memberKey(nested!.compared.map((column) => valueOf(row, column)))])
    }
    return byMember
  }
  const keyOf = (row: Record<string, unknown>, carried: Map<string, string[]>): string =>
    memberKey([...compared.map((column) => valueOf(row, column)), ...(nested ? [[...(carried.get(row.id as string) ?? [])].sort()] : [])])
  const bySet = (members: readonly Record<string, unknown>[], carried: Map<string, string[]>): Map<string, string[]> => {
    const sets = new Map<string, string[]>(parents.map((id) => [id, []]))
    for (const row of members) {
      const set = sets.get(valueOf(row, of) as string)
      if (set === undefined) throw new Error(`replaceSets: a row of "${getTableName(table)}" names ${String(valueOf(row, of))}, which is not one of its parents`)
      set.push(keyOf(row, carried))
    }
    return sets
  }

  const proposed = bySet(rows, carriedBy(inner))
  const stored = (await tx
    .select({ id: table.id, ...Object.fromEntries([of, ...compared].map((column) => [propertyOf(column), column])) })
    .from(table as PgTable)
    .where(inArray(of, [...parents]))) as Record<string, unknown>[]
  const storedIds = stored.map((row) => row.id as string)
  const storedInner =
    nested && storedIds.length > 0
      ? ((await tx
          .select(Object.fromEntries([nested.of, ...nested.compared].map((column) => [propertyOf(column), column])))
          .from(nested.table as PgTable)
          .where(inArray(nested.of, storedIds))) as Record<string, unknown>[])
      : []
  const found = bySet(stored, carriedBy(storedInner))

  const differing = parents.filter((id) => !sameMembers(found.get(id) ?? [], proposed.get(id) ?? []))
  if (differing.length === 0) return 0
  let written = 0
  const replaced = stored.filter((row) => differing.includes(valueOf(row, of) as string)).map((row) => row.id as string)
  if (nested && replaced.length > 0) written += (await tx.delete(nested.table).where(inArray(nested.of, replaced)).returning({ id: nested.table.id })).length
  written += (await tx.delete(table).where(inArray(of, differing)).returning({ id: table.id })).length
  const replacing = rows.filter((row) => differing.includes(valueOf(row, of) as string))
  if (replacing.length > 0) written += (await tx.insert(table).values(replacing as PgInsertValue<T>[]).returning({ id: table.id })).length
  const members = new Set(replacing.map((row) => row.id as string))
  const carried = inner.filter((row) => members.has(valueOf(row, nested!.of) as string))
  if (nested && carried.length > 0) written += (await tx.insert(nested.table).values(carried as PgInsertValue<N>[]).returning({ id: nested.table.id })).length
  return written
}
