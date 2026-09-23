// The exclusion constraint of ADR-0005: for one business key, no two rows
// whose validity periods overlap, enforced by the database. Drizzle has no
// builder for it (drizzle-team/drizzle-orm#3388), so the statement is
// hand-written into the table's migration file, and this function is the one
// place that spells it:
//
//   ALTER TABLE "wms"."agreement" ADD CONSTRAINT "agreement_no_overlap"
//     EXCLUDE USING gist ("company_id" WITH =, "container_id" WITH =,
//                         daterange("valid_from", "valid_to", '[)') WITH &&);
//
// `company_id` always leads the key: a business key is a tenant's, and a
// caller cannot leave it out. The rest of the key is the caller's; `=` on a
// uuid or text column inside a gist index is what the btree_gist extension of
// the foundation migration provides. The period is a half-open date range, so
// a row ending on the day another starts does not overlap it, and a null
// `valid_to` is an unbounded range that overlaps every later start. An empty
// period would be an empty range and overlap nothing, which is why the table
// must carry the `validPeriod` check (schema/columns.ts) before this
// constraint is written for it. Postgres refuses an overlap with SQLSTATE
// 23P01, naming the constraint.
import { getTableConfig, type PgColumn, type PgTable } from "drizzle-orm/pg-core"

import { VALIDITY_CHECK } from "../schema/columns"
import { columnName, columnNamed, qualifiedTable, quoted, tableObjectName } from "../names"

const HELPER = "excludeOverlapping"
/** The suffix of the constraint's name. */
export const NO_OVERLAP = "no_overlap"

/** The statement that adds the exclusion constraint for this business key, for the table's migration file. */
export function excludeOverlapping(table: PgTable, key: PgColumn[]): string[] {
  const target = qualifiedTable(table, HELPER)
  const validFrom = columnNamed(table, "valid_from")
  const validTo = columnNamed(table, "valid_to")
  if (!validFrom || !validTo) {
    throw new Error(`${HELPER}: ${target} has no valid_from and valid_to; spread the validity column set`)
  }
  const checkName = tableObjectName(table, VALIDITY_CHECK, HELPER)
  if (!getTableConfig(table).checks.some((check) => check.name === checkName)) {
    throw new Error(`${HELPER}: ${target} has no "${checkName}" check; add validPeriod(columns) beside its columns, or an empty period would pass the constraint`)
  }
  const companyId = columnNamed(table, "company_id")
  if (!companyId) {
    throw new Error(`${HELPER}: ${target} has no company_id; spread the tenant column set`)
  }
  const names = [companyId, ...key].map((column) => {
    if (column.table !== table) {
      throw new Error(`${HELPER}: column "${columnName(column)}" is not a column of ${target}`)
    }
    return columnName(column)
  })
  for (const name of names) {
    if (name === "valid_from" || name === "valid_to") {
      throw new Error(`${HELPER}: "${name}" is the period, not the key`)
    }
  }
  const unique = names.filter((name, index) => names.indexOf(name) === index)
  const equalities = unique.map((name) => `${quoted(name)} WITH =`).join(", ")
  const period = `daterange(${quoted("valid_from")}, ${quoted("valid_to")}, '[)') WITH &&`
  return [`ALTER TABLE ${target} ADD CONSTRAINT ${quoted(tableObjectName(table, NO_OVERLAP, HELPER))} EXCLUDE USING gist (${equalities}, ${period});`]
}
