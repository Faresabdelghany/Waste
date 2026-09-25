// What the two exclusion-constraint helpers share (Issue #101):
// exclude-overlapping.ts spells a constraint over a validity period,
// exclude-overlapping-window.ts one over a reservation window, and both begin
// by resolving the key the caller hands them — the table is a `wms` table
// with `company_id`, the range columns are there, every key column is the
// table's own and not one of the range, and `company_id` leads the key once
// whether or not the caller listed it. That is here once, so the two cannot
// drift on what a key is; each helper keeps its range, its check, its name
// and its predicate.
import type { PgColumn, PgTable } from "drizzle-orm/pg-core"

import { columnsByName, qualifiedTable } from "../names"

/** The range a helper spells its constraint over: its two column names, the noun a refusal calls it, and the column set that spreads it. */
export type KeyRange = { columns: readonly [string, string]; noun: string; set: string }

/** One column of a resolved key: its database name, and the column for what the caller still has to check of it (nullability). */
export type KeyColumn = { name: string; column: PgColumn }

/** A key as a helper writes it: the table it is on, its columns by database name (for whatever else the helper has to look up on the table), and the caller's columns after `company_id`, each once and none of the range. */
export type ResolvedKey = { target: string; columns: Map<string, PgColumn>; own: KeyColumn[] }

/**
 * The caller's key columns, checked and de-duplicated. `company_id` is not
 * in `own`: it leads every key, and the helper writes it first.
 */
export function resolveKey(table: PgTable, key: readonly PgColumn[], helper: string, range: KeyRange): ResolvedKey {
  const target = qualifiedTable(table, helper)
  const columns = columnsByName(table)
  const [from, to] = range.columns
  if (!columns.has(from) || !columns.has(to)) {
    throw new Error(`${helper}: ${target} has no ${from} and ${to}; spread the ${range.set} column set`)
  }
  if (!columns.has("company_id")) {
    throw new Error(`${helper}: ${target} has no company_id; spread the tenant column set`)
  }
  const own: KeyColumn[] = []
  for (const column of key) {
    const name = [...columns].find(([, candidate]) => candidate === column)?.[0]
    if (name === undefined) {
      throw new Error(`${helper}: column "${column.name}" is not a column of ${target}`)
    }
    if (name === from || name === to) {
      throw new Error(`${helper}: "${name}" is the ${range.noun}, not the key`)
    }
    if (name === "company_id" || own.some((seen) => seen.name === name)) continue
    own.push({ name, column })
  }
  return { target, columns, own }
}
