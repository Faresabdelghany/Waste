// The trigger that keeps `updated_at` honest, hand-written into the migration
// file of every table that spreads the `timestamps` column set:
//
//   CREATE TRIGGER "agreement_touch_updated_at" BEFORE UPDATE ON "wms"."agreement"
//     FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();
//
// The function is the foundation migration's; it sets `updated_at` to the
// transaction's `now()` on every UPDATE, including one that changes nothing
// and one that tried to set `updated_at` itself. An INSERT is left to the
// column's default, the same `now()`, so a fresh row has `created_at` equal to
// `updated_at`.
import type { PgTable } from "drizzle-orm/pg-core"

import { columnNamed, qualifiedTable, quoted, tableObjectName } from "../names"

const HELPER = "touchUpdatedAt"
/** The suffix of the trigger's name. */
export const TOUCH_UPDATED_AT = "touch_updated_at"

/** The statement that adds the trigger to this table, for the table's migration file. */
export function touchUpdatedAt(table: PgTable): string[] {
  const target = qualifiedTable(table, HELPER)
  if (!columnNamed(table, "updated_at")) {
    throw new Error(`${HELPER}: ${target} has no updated_at; spread the timestamps column set`)
  }
  return [
    `CREATE TRIGGER ${quoted(tableObjectName(table, TOUCH_UPDATED_AT, HELPER))} BEFORE UPDATE ON ${target} FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();`,
  ]
}
