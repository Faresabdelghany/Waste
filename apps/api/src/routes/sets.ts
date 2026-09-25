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
// `firstMissing` is the plural check's first statement: every id a row of the
// table in this company, under whatever else the key demands (`also`, the
// project a project-scoped row belongs to), and the lowest entry that is not,
// by the path the body spelled it at. The caller hands that entry to the
// singular check of routes/references.ts, which refuses it with the family's
// own sentence — so one bad id and one among two hundred are told the same
// thing — and `eachPresent` is that loop: a row that arrived between the two
// statements is a row that is there, the singular lets it through, and the
// set is asked again until nothing is missing, so no entry is written that no
// statement proved. The second statement is spent on the failure path only.
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
  const ids = [...new Set(entries.map((entry) => entry.id))]
  if (ids.length === 0) return undefined
  const rows = await tx
    .select({ id: column })
    .from(table)
    .where(and(eq(table.companyId, companyId), inArray(column, ids), also))
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
 * is a row flickering under the request, which is not a client's doing.
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
  let passed: string | undefined
  for (;;) {
    const missing = await firstMissing(tx, table, column, companyId, entries, also)
    if (missing === undefined) return
    if (missing.path === passed) throw new Error(`${missing.path} names ${missing.id}, which the singular check found and the set did not`)
    await singular(missing)
    passed = missing.path
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
