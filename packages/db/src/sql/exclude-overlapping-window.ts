// The exclusion constraint of a reservation (Issue #101, ADR-0005 over
// instants): for one key, no two live rows whose windows overlap, enforced by
// the database. The sibling of exclude-overlapping.ts for a table that spreads
// `window` instead of `validity` — a Vehicle Allocation reserves a vehicle
// from a clock time to a clock time, two a day being ordinary, so the range is
// a `tstzrange` over `planned_from` and `planned_to` and not a `daterange`.
// Hand-written into the table's migration file, and this function is the one
// place that spells it:
//
//   ALTER TABLE "wms"."vehicle_allocation" ADD CONSTRAINT "vehicle_allocation_vehicle_no_overlap"
//     EXCLUDE USING gist ("company_id" WITH =, "vehicle_id" WITH =,
//                         tstzrange("planned_from", "planned_to", '[)') WITH &&)
//     WHERE ("status" <> 'released');
//
// Three things differ from the validity sibling. The constraint is named by
// its key, `<table>_<key>_no_overlap` with a trailing `_id` dropped from each
// key column, because one table may carry several — over the vehicle, over
// the driver, over the trailer — and Postgres names the one it refused with
// (23P01). It takes a `where`: a released reservation frees its window, and
// only the rows the predicate keeps are in the index. And a nullable key
// column is allowed, but only when the predicate says `"<column>" is not null`
// — a null never equals anything in an exclusion constraint, so rows with a
// null there would overlap freely unless the predicate keeps them out of the
// index, which is exactly what an allocation without a driver wants. The
// `orderedWindow` check has to be on the table first, since an empty window is
// an empty range and overlaps nothing.
import { getTableConfig, type PgColumn, type PgTable } from "drizzle-orm/pg-core"

import { WINDOW_CHECK } from "../schema/columns"
import { columnsByName, qualifiedTable, quoted, tableObjectName } from "../names"
import { NO_OVERLAP } from "./exclude-overlapping"

const HELPER = "excludeOverlappingWindow"

/** The part of the key's name that says what it is: `vehicle_id` is the vehicle's, so the constraint is `_vehicle_no_overlap`. */
const keyWord = (column: string): string => column.replace(/_id$/, "")

/** The statement that adds the exclusion constraint for this key over the window, for the table's migration file. */
export function excludeOverlappingWindow(table: PgTable, key: [PgColumn, ...PgColumn[]], where?: string): string[] {
  const target = qualifiedTable(table, HELPER)
  const columns = columnsByName(table)
  if (!columns.has("planned_from") || !columns.has("planned_to")) {
    throw new Error(`${HELPER}: ${target} has no planned_from and planned_to; spread the window column set`)
  }
  const checkName = tableObjectName(table, WINDOW_CHECK, HELPER)
  if (!getTableConfig(table).checks.some((check) => check.name === checkName)) {
    throw new Error(`${HELPER}: ${target} has no "${checkName}" check; add orderedWindow(columns) beside its columns, or an empty window would pass the constraint`)
  }
  const companyId = columns.get("company_id")
  if (!companyId) {
    throw new Error(`${HELPER}: ${target} has no company_id; spread the tenant column set`)
  }
  const names = key.map((column) => {
    const name = [...columns].find(([, candidate]) => candidate === column)?.[0]
    if (name === undefined) {
      throw new Error(`${HELPER}: column "${column.name}" is not a column of ${target}`)
    }
    if (name === "planned_from" || name === "planned_to") {
      throw new Error(`${HELPER}: "${name}" is the window, not the key`)
    }
    if (name === "company_id") {
      throw new Error(`${HELPER}: "company_id" leads every key already; name the key beside it`)
    }
    if (!column.notNull && !(where ?? "").includes(`${quoted(name)} is not null`)) {
      throw new Error(
        `${HELPER}: "${name}" is nullable; a null never equals anything in an exclusion constraint, so rows with a null there would overlap freely. Make it NOT NULL, or keep them out of the index with a where of ${quoted(name)} is not null.`,
      )
    }
    return name
  })
  const equalities = [quoted("company_id"), ...names.map(quoted)].map((name) => `${name} WITH =`).join(", ")
  const period = `tstzrange(${quoted("planned_from")}, ${quoted("planned_to")}, '[)') WITH &&`
  const predicate = where === undefined ? "" : ` WHERE (${where})`
  const name = tableObjectName(table, `${names.map(keyWord).join("_")}_${NO_OVERLAP}`, HELPER)
  return [`ALTER TABLE ${target} ADD CONSTRAINT ${quoted(name)} EXCLUDE USING gist (${equalities}, ${period})${predicate};`]
}
