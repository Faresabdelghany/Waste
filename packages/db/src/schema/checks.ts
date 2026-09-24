// The CHECK constraints a text column carries for its contract, each named
// through names.ts (`<table>_<column>_<rule>`, refused past 63 bytes) and
// spelled once here so no two tables spell one differently.
//
// `oneOf(column, values)`: a status is text with a listed value, not a Postgres
// enum. An enum would make every new value a migration (`ALTER TYPE ... ADD
// VALUE`, which cannot run inside the migrator's transaction before Postgres
// 12 and cannot be undone at all); a check is one constraint to replace. The
// contracts' zod enum is the vocabulary the API checks first; this is the
// database's copy of it. drizzle-kit writes a check's SQL into the migration
// file as text, and a bound parameter would go in as `$1`, so the values are
// spelled as literals with their quotes doubled.
//
// `lowercase(column)`: the column equals its own lower(), so an address is
// stored the way it is compared and a unique constraint over it means what it
// says. The API lowercases before writing; the check is what holds when it
// does not.
//
// `positive(column)`: a count is a count. A null passes, which is what a
// nullable one wants — "no volume recorded" is not "a volume of zero", and the
// column says which by being null or not.
//
// `exactlyOne(columns, label, among)`: one of these columns is set and the
// others are not, counted rather than spelled as a chain of ands, so the text
// does not grow quadratically with a third column. The label names what the
// columns are two ways of saying, so the refusal reads as the rule
// (`subscription_location_exactly_one`) and not as a list of columns.
import { getTableName, sql } from "drizzle-orm"
import { check, type CheckBuilder, type PgColumn } from "drizzle-orm/pg-core"

import { columnName, quoted, tableObjectName } from "../names"
import type { TenantColumns } from "./references"

/** A SQL string literal: single quotes, quotes inside doubled. */
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`

/** `CHECK (<column> in ('a', 'b', ...))`, named `<table>_<column>_one_of`. */
export function oneOf(column: PgColumn, values: readonly string[]): CheckBuilder {
  const helper = "oneOf"
  if (values.length === 0) {
    // The table's name, not its config: this runs inside the builder getTableConfig would run again.
    throw new Error(`${helper}: ${quoted(getTableName(column.table))}.${quoted(columnName(column))} has no values to be one of`)
  }
  return check(tableObjectName(column.table, `${columnName(column)}_one_of`, helper), sql`${column} in (${sql.raw(values.map(literal).join(", "))})`)
}

/** `CHECK (<column> = lower(<column>))`, named `<table>_<column>_lowercase`. */
export function lowercase(column: PgColumn): CheckBuilder {
  return check(tableObjectName(column.table, `${columnName(column)}_lowercase`, "lowercase"), sql`${column} = lower(${column})`)
}

/** `CHECK (<column> > 0)`, named `<table>_<column>_positive`. A null passes: nothing recorded is not zero. */
export function positive(column: PgColumn): CheckBuilder {
  return check(tableObjectName(column.table, `${columnName(column)}_positive`, "positive"), sql`${column} > 0`)
}

/** `CHECK ((a is not null)::int + (b is not null)::int ... = 1)`, named `<table>_<label>_exactly_one`. */
export function exactlyOne(columns: TenantColumns, label: string, among: [PgColumn, PgColumn, ...PgColumn[]]): CheckBuilder {
  const helper = "exactlyOne"
  if (among.length < 2) {
    throw new Error(
      `${helper}: ${quoted(getTableName(columns.companyId.table))} names ${among.length} column(s) for "${label}"; with fewer than two there is nothing to choose between, and one column that must be set is NOT NULL`,
    )
  }
  const set = among.map((column) => sql`(${column} is not null)::int`)
  return check(tableObjectName(columns.companyId.table, `${label}_exactly_one`, helper), sql`${sql.join(set, sql` + `)} = 1`)
}
