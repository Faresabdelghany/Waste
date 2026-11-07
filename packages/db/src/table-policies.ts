// Every table's policies, gathered in one walk over the schema's exports from
// what each table declares beside itself (schema/policies.ts says what a
// declaration holds), and the lists the package derives from them: which
// tables the audit trail keeps and which it does not and why, the trigger
// arguments of each audited table and the module the domain reads its
// history under (`AUDITED_TABLES`), the tables the reset to the seed keeps,
// the columns and rows the public door reads, and the document counters.
// The tests that hold the database to these lists read them here:
// audit-trail.test.ts, public-door.test.ts, reset-to-seed.test.ts and
// table-policies.test.ts, which holds every declaration to its table.
import type { ModuleKey } from "@waste/domain/access/modules"
import { AUDITED_TABLES } from "@waste/domain/audit/vocabulary"
import { getTableName, is } from "drizzle-orm"
import { getTableConfig, PgTable, type PgColumn } from "drizzle-orm/pg-core"

import { columnName } from "./names"
import * as schema from "./schema"
import { isLedger } from "./schema/columns"
import { TablePolicies, type Counters, type Declaration, type Door } from "./schema/policies"

const exported = Object.values(schema) as unknown[]

/** Every table of the schema, in the barrel's order. */
export const TABLES: readonly PgTable[] = exported.filter((value): value is PgTable => is(value, PgTable))

/** Every table's declaration, in the barrel's order. */
export const DECLARATIONS: readonly TablePolicies[] = exported.filter((value): value is TablePolicies => value instanceof TablePolicies)

const declared = (table: PgTable): Declaration | undefined => DECLARATIONS.find((declaration) => declaration.table === table)?.declared

/** An audited table: the module its history is read under, the parent it is a set of, and the columns whose moves are no history. */
export type Audited = {
  table: PgTable
  /** The domain's module for the table; undefined only for a table the domain does not name, which table-policies.test.ts refuses. */
  module: ModuleKey | undefined
  parent?: { table: PgTable; column: PgColumn }
  ignored: readonly PgColumn[]
}

/** A table the audit log does not keep, and why. */
export type Exempt = { table: PgTable; why: string }

export type PublicDoorTable = { table: PgTable } & Door

const LEDGER = "a ledger: its rows are its own history, appended and never rewritten"

const MODULE_OF: ReadonlyMap<string, ModuleKey> = new Map(Object.entries(AUDITED_TABLES))

/** The table a column of this table names a row of: the one foreign key that points the column at that table's `id`. */
function parentTableOf(table: PgTable, column: PgColumn): PgTable {
  const name = columnName(column)
  const keys = getTableConfig(table)
    .foreignKeys.map((key) => key.reference())
    .filter((reference) => {
      const at = reference.columns.map(columnName).indexOf(name)
      return at !== -1 && columnName(reference.foreignColumns[at]) === "id"
    })
  if (keys.length !== 1) {
    throw new Error(`${getTableName(table)} names its audit parent by ${name}, which ${keys.length} of its foreign keys point at a row's id; name the column a key points at the parent's id through`)
  }
  return keys[0].foreignTable
}

export const AUDITED: readonly Audited[] = TABLES.flatMap((table) => {
  const declaration = declared(table)
  if (declaration?.audited === undefined) return []
  const { parent } = declaration.audited
  return [
    {
      table,
      module: MODULE_OF.get(getTableName(table)),
      ...(parent === undefined ? {} : { parent: { table: parentTableOf(table, parent), column: parent } }),
      ignored: Object.values(declaration.counters ?? {}),
    },
  ]
})

/** The tables the log does not keep: a ledger in its own words or the ledger's, every other table as it declares. */
export const EXEMPT: readonly Exempt[] = TABLES.flatMap((table) => {
  const why = declared(table)?.exempt ?? (isLedger(table) ? LEDGER : undefined)
  return why === undefined ? [] : [{ table, why }]
})

/** The tables whose rows the reset to the seed keeps. */
export const KEPT_TABLES: readonly PgTable[] = TABLES.filter((table) => declared(table)?.kept === true)

/** Every table and column the public role may read, and the rows of each. */
export const PUBLIC_DOOR_TABLES: readonly PublicDoorTable[] = TABLES.flatMap((table) => {
  const door = declared(table)?.door
  return door === undefined ? [] : [{ table, ...door }]
})

/** The tables that carry document counters, and the counters. */
export const COUNTERS: readonly { table: PgTable; counters: Counters }[] = TABLES.flatMap((table) => {
  const counters = declared(table)?.counters
  return counters === undefined ? [] : [{ table, counters }]
})
