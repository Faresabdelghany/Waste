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
//
// `subsetOf(column, values)` and `nonEmpty(column)` are `oneOf` for a set
// (Issue #97): a closed vocabulary that a row holds several of — the days a
// scheme serves, the days a project rests on — is a `text[]` and not a child
// table, since a weekday is not a row anyone references, and Postgres has no
// `in` for an array. `<@` holds every element to the list (`'{}' <@ anything`
// is true, so an empty array passes it), and `cardinality(...) > 0` is the
// separate rule that the set has something in it, for the column where an
// empty set would be a scheme that never runs. A null array passes both, like
// a null count passes `positive`, and the column says whether it may be null.
// Neither refuses an element twice (`'{monday,monday}'` is a subset of the
// seven) or bounds the set's size: the database holds subset-ness and
// non-emptiness, and distinctness and size are the contracts' rule
// (`ServiceDays` in @waste/contracts/planning, `WEEKEND_MAX` in
// @waste/contracts/organisation), since the API is the only writer — a SQL
// function for the two would be a second spelling of a rule already held.
import { getTableName, sql } from "drizzle-orm"
import { check, type CheckBuilder, type PgColumn } from "drizzle-orm/pg-core"

import { columnName, quoted, tableObjectName } from "../names"
import type { TenantColumns } from "./references"

/** A SQL string literal: single quotes, quotes inside doubled. The one spelling for every value this package writes into SQL text — a check's, a predicate's, a CASE's. */
export const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`

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

/** `CHECK (<column> <@ ARRAY['a', 'b', ...]::text[])`, named `<table>_<column>_subset_of`: every element is one of the values. An empty array passes; `nonEmpty` is the other rule. */
export function subsetOf(column: PgColumn, values: readonly string[]): CheckBuilder {
  const helper = "subsetOf"
  if (values.length === 0) {
    throw new Error(`${helper}: ${quoted(getTableName(column.table))}.${quoted(columnName(column))} has no values to be a subset of`)
  }
  return check(
    tableObjectName(column.table, `${columnName(column)}_subset_of`, helper),
    sql`${column} <@ ARRAY[${sql.raw(values.map(literal).join(", "))}]::text[]`,
  )
}

/** `CHECK (cardinality(<column>) > 0)`, named `<table>_<column>_non_empty`: the set has something in it. A null passes, like a null count. */
export function nonEmpty(column: PgColumn): CheckBuilder {
  return check(tableObjectName(column.table, `${columnName(column)}_non_empty`, "nonEmpty"), sql`cardinality(${column}) > 0`)
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
