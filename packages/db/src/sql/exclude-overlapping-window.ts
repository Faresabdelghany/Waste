// The exclusion constraint of a reservation (Issue #101, ADR-0005 over
// instants): for one key, no two live rows whose windows overlap, enforced by
// the database. The sibling of exclude-overlapping.ts for a table that spreads
// `window` instead of `validity` — a Vehicle Allocation reserves a vehicle
// from a clock time to a clock time, two a day being ordinary, so the range is
// a `tstzrange` over `planned_from` and `planned_to` and not a `daterange`.
// Hand-written into the table's migration file, and this function is the one
// place that spells it:
//
//   ALTER TABLE "wms"."vehicle_allocation" ADD CONSTRAINT "vehicle_allocation_driver_no_overlap"
//     EXCLUDE USING gist ("company_id" WITH =, "driver_id" WITH =,
//                         tstzrange("planned_from", "planned_to", '[)') WITH &&)
//     WHERE ("driver_id" is not null and "status" <> 'released');
//
// Three things differ from the validity sibling. The constraint is named by
// its key, `<table>_<key>_no_overlap` with a trailing `_id` dropped from each
// key column, because one table may carry several — over the vehicle, over
// the driver, over the trailer — and Postgres names the one it refused with
// (23P01). It carries a predicate: a nullable key column is allowed, and the
// helper itself keeps its nulls out of the index with `"<column>" is not
// null` — a null never equals anything in an exclusion constraint, so rows
// with a null there would otherwise overlap freely, which is exactly what an
// allocation without a driver wants — and the caller may add which rows are
// live (`{ live: { column: status, not: "released" } }`), so a released
// reservation frees its window. And the `orderedWindow` check has to be on
// the table first, since an empty window is an empty range and overlaps
// nothing. The key itself is resolved by sql/key.ts, shared with the sibling:
// `company_id` leads it once whether or not the caller listed it.
import { getTableConfig, type PgColumn, type PgTable } from "drizzle-orm/pg-core"

import { WINDOW_CHECK } from "../schema/columns"
import { literal } from "../schema/checks"
import { columnsByName, quoted, tableObjectName } from "../names"
import { NO_OVERLAP } from "./exclude-overlapping"
import { resolveKey } from "./key"

const HELPER = "excludeOverlappingWindow"
/** The range this helper spells its constraint over. */
const WINDOW_COLUMNS = { columns: ["planned_from", "planned_to"], noun: "window", set: "window" } as const
/** The range as the constraint spells it, the part every window constraint carries whatever its key and predicate; the gate (hand-written.ts) reads it from here. */
export const WINDOW_RANGE = `tstzrange(${quoted("planned_from")}, ${quoted("planned_to")}, '[)') WITH &&`

/** Which rows are live: those whose `column` is not `not` — a released reservation is out of the index. */
export type LiveRows = { column: PgColumn; not: string }

/** What a caller may add to the predicate the helper spells for nullable key columns. */
export type WindowPredicate = { live?: LiveRows }

/** The part of the key's name that says what it is: `vehicle_id` is the vehicle's, so the constraint is `_vehicle_no_overlap`. */
const keyWord = (column: string): string => column.replace(/_id$/, "")

/** The statement that adds the exclusion constraint for this key over the window, for the table's migration file. */
export function excludeOverlappingWindow(table: PgTable, key: [PgColumn, ...PgColumn[]], where: WindowPredicate = {}): string[] {
  const { target, own } = resolveKey(table, key, HELPER, WINDOW_COLUMNS)
  const checkName = tableObjectName(table, WINDOW_CHECK, HELPER)
  if (!getTableConfig(table).checks.some((check) => check.name === checkName)) {
    throw new Error(`${HELPER}: ${target} has no "${checkName}" check; add orderedWindow(columns) beside its columns, or an empty window would pass the constraint`)
  }
  if (own.length === 0) {
    throw new Error(`${HELPER}: ${target} names no key beside company_id; a reservation is of something`)
  }
  const predicate = own.filter(({ column }) => !column.notNull).map(({ name }) => `${quoted(name)} is not null`)
  if (where.live !== undefined) {
    const columns = columnsByName(table)
    const name = [...columns].find(([, candidate]) => candidate === where.live?.column)?.[0]
    if (name === undefined) {
      throw new Error(`${HELPER}: live column "${where.live.column.name}" is not a column of ${target}`)
    }
    predicate.push(`${quoted(name)} <> ${literal(where.live.not)}`)
  }
  const equalities = ["company_id", ...own.map((column) => column.name)].map((name) => `${quoted(name)} WITH =`).join(", ")
  const name = tableObjectName(table, `${own.map((column) => keyWord(column.name)).join("_")}_${NO_OVERLAP}`, HELPER)
  const filter = predicate.length === 0 ? "" : ` WHERE (${predicate.join(" and ")})`
  return [`ALTER TABLE ${target} ADD CONSTRAINT ${quoted(name)} EXCLUDE USING gist (${equalities}, ${WINDOW_RANGE})${filter};`]
}
