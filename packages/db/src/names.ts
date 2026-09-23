// How this package spells a database object when it writes SQL itself: the
// table qualified by its schema, a column by the name Drizzle's casing gives
// it, a constraint, policy or trigger by `<table>_<suffix>`. drizzle-kit quotes
// every identifier it writes, and so does this, so a hand-written statement
// reads like a generated one.
//
// One rule every name goes through: Postgres truncates an identifier past 63
// bytes to 63, in a notice the client drops, and two truncated names collide
// on the second CREATE. A name that long is refused here, at definition time,
// with the fix in the message.
import { getTableName, type Table } from "drizzle-orm"
import { CasingCache } from "drizzle-orm/casing"
import { getTableConfig, type PgColumn, type PgTable } from "drizzle-orm/pg-core"

import { CASING } from "./casing"
import { wms } from "./schema/wms"

/** Postgres's NAMEDATALEN - 1: what a longer identifier is cut down to, silently. */
export const MAX_IDENTIFIER_BYTES = 63

/** The name, if Postgres would keep all of it; otherwise a refusal that names the helper. */
export function checkedIdentifier(name: string, helper: string): string {
  const bytes = Buffer.byteLength(name)
  if (bytes > MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `${helper}: "${name}" is ${bytes} bytes; Postgres would truncate it to ${MAX_IDENTIFIER_BYTES} silently, and two truncated names collide. Shorten the table or column name.`,
    )
  }
  return name
}

/** `"name"`, as drizzle-kit writes an identifier. */
export const quoted = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`

/** The table's schema and name as the migration spells them: `"wms"."table"`. Only `wms` tables have hand-written statements (ADR-0001). */
export function qualifiedTable(table: PgTable, helper: string): string {
  const { schema, name } = getTableConfig(table)
  if (schema !== wms.schemaName) {
    throw new Error(`${helper}: "${name}" is in schema ${schema ?? "public"}; domain tables live in ${wms.schemaName}`)
  }
  return `${quoted(schema)}.${quoted(name)}`
}

/** The column's name in the database: its explicit name, or its key in the package's casing. */
export function columnName(column: PgColumn): string {
  // A cache per call: it keys columns by schema and table name, and two
  // specimen tables in one process may share one.
  return new CasingCache(CASING).getColumnCasing(column)
}

/** The table's column with this database name, if it has one. */
export function columnNamed(table: PgTable, name: string): PgColumn | undefined {
  return getTableConfig(table).columns.find((column) => columnName(column) === name)
}

/** `<table>_<suffix>`, checked against the identifier limit. */
export function tableObjectName(table: Table, suffix: string, helper: string): string {
  return checkedIdentifier(`${getTableName(table)}_${suffix}`, helper)
}
