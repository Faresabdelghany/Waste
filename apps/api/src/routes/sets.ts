// The two statements every set of this API runs, once (Issue #101, review
// round A). A set — a Property's parties, a Group's or a Point's members, a
// Vehicle Type's container types, an Unloading Station's fractions, a
// Collection Group's picked containers — is read for a whole page in one query
// grouped by parent, and a body's entries are held to what their key allows
// in one query too. routes/members.ts and routes/id-sets.ts each spelled both
// (an entry there carries a role and a project, here neither), and
// routes/scheme-groups.ts a third time; the mechanics are here once and each
// module keeps only what is its own: which table, which columns, and what a
// row of it is called.
//
// `whereNamed` is the one filter every presence statement runs: the ids a
// body named, in this company, under whatever else the key demands (`also`,
// the project a project-scoped row belongs to). `firstMissing` runs it for the
// ids alone and answers the lowest entry that is not there, by the path the
// body spelled it at. The caller hands that entry to the singular check of
// routes/references.ts, which refuses it with the family's own sentence — so
// one bad id and one among two hundred are told the same thing — and
// `eachPresent` is that loop: a row that arrived between the two statements
// is a row that is there, the singular lets it through, and the set is asked
// again until nothing is missing, so no entry is written that no statement
// proved. The second statement is spent on the failure path only. The loop
// remembers every path the singular let through (a `Set`, since the last
// round of the #101 review): an entry the set finds missing again after that
// is a row flickering under the request and is thrown, so two entries taking
// turns cannot keep the loop going.
//
// `rowsPresent` is the same loop for a caller that does something with the
// rows a body named next — a status gate, a licence rule — and so needs every
// one of them. It reads the rows first, through the caller's `read` over the
// very same filter (only the caller knows the columns), derives the missing
// entry from what came back, and only on a miss runs the singular and reads
// again: presence and read are one statement and one filter on the happy
// path, and the map it answers holds every id the body named — a row the
// singular let through is read like the rest, and one the read still lacks
// after the singular passed it is the flicker, thrown. routes/scheme-groups.ts
// reads a body's vehicles and drivers this way.
//
// `groupedBy` is the read: a page's entries in one query, grouped by parent
// and in the order a set reads back in, the same for a page, a single read
// and the answer to a write.
import type { Tx } from "@waste/db/client"
import { and, asc, eq, inArray, type SQL } from "drizzle-orm"
import type { PgColumn, PgTable } from "drizzle-orm/pg-core"

import type { TenantTable } from "./shared"

/** One entry of a body as the plural check sees it: the id it names and the path it named it at. */
export type Named = { id: string; path: string }

/** The singular check a missing entry is handed to: routes/references.ts's, refusing at the entry's path with the family's sentence. */
export type Singular = (entry: Named) => Promise<unknown>

/** Every id the entries name, each once however often a body named it, in the order first named. */
export const idsNamed = (entries: readonly Named[]): string[] => [...new Set(entries.map((entry) => entry.id))]

/**
 * The one filter a presence statement runs: rows of `table` whose `column`
 * is one of `ids`, in this company, and under `also` — the project a
 * project-scoped row belongs to, the kind a vehicle is asked for. The check
 * and the read of a set run it alike, so what proves a row is there is what
 * reads it.
 */
export const whereNamed = (table: TenantTable, column: PgColumn, companyId: string, ids: readonly string[], also?: SQL): SQL | undefined =>
  and(eq(table.companyId, companyId), inArray(column, [...ids]), also)

/** The flicker: an entry the singular let through and the set finds missing again is a row that comes and goes under the request, which is not a client's doing. */
const flickering = (entry: Named) => new Error(`${entry.path} names ${entry.id}, which the singular check found and the set did not`)

/**
 * The lowest entry whose id is not a row of `table` in this company (and
 * under `also`), found in one statement over every id the body named, each
 * once however often it named it; undefined when every id is there. `column`
 * is the column the ids name, the table's own id.
 */
export async function firstMissing(
  tx: Tx,
  table: TenantTable,
  column: PgColumn,
  companyId: string,
  entries: readonly Named[],
  also?: SQL,
): Promise<Named | undefined> {
  const ids = idsNamed(entries)
  if (ids.length === 0) return undefined
  const rows = await tx
    .select({ id: column })
    .from(table)
    .where(whereNamed(table, column, companyId, ids, also))
  // A bare `PgColumn` carries `data: unknown`, so the selection reads as
  // unknown however plainly the column is `uuid`.
  const found = new Set((rows as { id: string }[]).map((row) => row.id))
  return entries.find((entry) => !found.has(entry.id))
}

/**
 * Every entry a row of `table` under the key, or the request refused at the
 * first that is not: `firstMissing` and then the singular, again until nothing
 * is missing. A row the singular let through is one that arrived between the
 * two statements and is there now; one it did not let through is the 400 the
 * family spells. An entry the singular passed and the set finds missing again
 * is a row flickering under the request, which is not a client's doing: it is
 * thrown, whichever of the passed entries it is, so no two entries can take
 * turns at the loop.
 */
export async function eachPresent(
  tx: Tx,
  table: TenantTable,
  column: PgColumn,
  companyId: string,
  entries: readonly Named[],
  singular: Singular,
  also?: SQL,
): Promise<void> {
  const passed = new Set<string>()
  for (;;) {
    const missing = await firstMissing(tx, table, column, companyId, entries, also)
    if (missing === undefined) return
    if (passed.has(missing.path)) throw flickering(missing)
    await singular(missing)
    passed.add(missing.path)
  }
}

/**
 * Every entry a row under the key, and the rows themselves, by id: `read` —
 * the caller's select over the filter handed to it, since only the caller
 * knows the columns — runs first, the lowest entry it did not bring back is
 * handed to the singular, and the read runs again until every id is there,
 * so the happy path is one statement and one filter and the map holds every
 * row the body named, a row that arrived between two statements included. An
 * entry the singular passed and the read still lacks is the flicker, thrown.
 * No entries is no statement and an empty map.
 */
export async function rowsPresent<Row extends { id: string }>(
  table: TenantTable,
  column: PgColumn,
  companyId: string,
  entries: readonly Named[],
  singular: Singular,
  read: (where: SQL | undefined) => Promise<Row[]>,
  also?: SQL,
): Promise<ReadonlyMap<string, Row>> {
  const ids = idsNamed(entries)
  if (ids.length === 0) return new Map()
  const passed = new Set<string>()
  for (;;) {
    const rows = new Map((await read(whereNamed(table, column, companyId, ids, also))).map((row) => [row.id, row] as const))
    const missing = entries.find((entry) => !rows.has(entry.id))
    if (missing === undefined) return rows
    if (passed.has(missing.path)) throw flickering(missing)
    await singular(missing)
    passed.add(missing.path)
  }
}

/**
 * The entries of a whole page in one query, grouped by parent: a list of
 * fifty records is two statements, never fifty-one. `columns` is what an
 * entry is made of — the id it names, and a role where the table has one —
 * and `orderBy` the columns a set reads back in.
 */
export async function groupedBy<Columns extends Record<string, PgColumn>>(
  tx: Tx,
  table: PgTable & { companyId: PgColumn },
  parentColumn: PgColumn,
  columns: Columns,
  orderBy: readonly PgColumn[],
  companyId: string,
  parentIds: readonly string[],
): Promise<Map<string, { [Key in keyof Columns]: string }[]>> {
  type Entry = { [Key in keyof Columns]: string }
  const byParent = new Map<string, Entry[]>()
  if (parentIds.length === 0) return byParent
  const rows = await tx
    .select({ ...columns, parent: parentColumn })
    .from(table)
    .where(and(eq(table.companyId, companyId), inArray(parentColumn, [...parentIds])))
    .orderBy(...orderBy.map((column) => asc(column)))
  // The same `data: unknown` as above: every column a set is made of is a
  // `uuid` or a `text`, and a narrower type in the descriptor is one no
  // family's columns would still fit. The entry is picked out by the
  // descriptor's keys, so the parent column never travels with it.
  const keys = Object.keys(columns)
  for (const row of rows as Record<string, string>[]) {
    const entry = Object.fromEntries(keys.map((key) => [key, row[key]])) as Entry
    const found = byParent.get(row.parent)
    if (found === undefined) byParent.set(row.parent, [entry])
    else found.push(entry)
  }
  return byParent
}
