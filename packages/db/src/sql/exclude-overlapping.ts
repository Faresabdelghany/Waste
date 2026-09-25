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
// the foundation migration provides. Every key column has to be NOT NULL: in
// an exclusion constraint a null never equals anything, so two rows with a
// null in the key would overlap freely and the guarantee would hold for every
// row but those. The period is a half-open date range, so a row ending on the
// day another starts does not overlap it, and a null `valid_to` is an
// unbounded range that overlaps every later start. An empty period would be
// an empty range and overlap nothing, which is why the table must carry the
// `validPeriod` check (schema/columns.ts) before this constraint is written
// for it. Postgres refuses an overlap with SQLSTATE 23P01, naming the
// constraint. The key itself is resolved by sql/key.ts, shared with the
// window sibling (exclude-overlapping-window.ts).
import { getTableConfig, type PgColumn, type PgTable } from "drizzle-orm/pg-core"

import { VALIDITY_CHECK } from "../schema/columns"
import { quoted, tableObjectName } from "../names"
import { resolveKey } from "./key"

const HELPER = "excludeOverlapping"
/** The suffix of the constraint's name. */
export const NO_OVERLAP = "no_overlap"
/** The range this helper spells its constraint over. */
const VALIDITY_RANGE = { columns: ["valid_from", "valid_to"], noun: "period", set: "validity" } as const

/** The statement that adds the exclusion constraint for this business key, for the table's migration file. */
export function excludeOverlapping(table: PgTable, key: PgColumn[]): string[] {
  const { target, own } = resolveKey(table, key, HELPER, VALIDITY_RANGE)
  const checkName = tableObjectName(table, VALIDITY_CHECK, HELPER)
  if (!getTableConfig(table).checks.some((check) => check.name === checkName)) {
    throw new Error(`${HELPER}: ${target} has no "${checkName}" check; add validPeriod(columns) beside its columns, or an empty period would pass the constraint`)
  }
  for (const { name, column } of own) {
    if (!column.notNull) {
      throw new Error(`${HELPER}: "${name}" is nullable; a null never equals anything in an exclusion constraint, so rows with a null there would overlap freely. Make it NOT NULL or leave it out of the key.`)
    }
  }
  const equalities = ["company_id", ...own.map((column) => column.name)].map((name) => `${quoted(name)} WITH =`).join(", ")
  const period = `daterange(${quoted("valid_from")}, ${quoted("valid_to")}, '[)') WITH &&`
  return [`ALTER TABLE ${target} ADD CONSTRAINT ${quoted(tableObjectName(table, NO_OVERLAP, HELPER))} EXCLUDE USING gist (${equalities}, ${period});`]
}
