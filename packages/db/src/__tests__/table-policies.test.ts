// Every table's declaration (schema/policies.ts), held to its table: one per
// table, beside it in the schema; an audit classification for every table
// but a ledger, which is exempt by being one; the audited tables exactly the
// domain's (`AUDITED_TABLES`), both ways; and only the table's own columns
// named as its parent, its door's or its counters, a counter under the
// table's own field name. No database.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { AUDITED_TABLES } from "@waste/domain/audit/vocabulary"
import { getTableColumns, getTableName, type Column } from "drizzle-orm"
import type { PgColumn, PgTable } from "drizzle-orm/pg-core"

import { columnName } from "../names"
import { isLedger } from "../schema/columns"
import { AUDITED, COUNTERS, DECLARATIONS, PUBLIC_DOOR_TABLES, TABLES } from "../table-policies"

const nameOf = (table: PgTable) => getTableName(table)
const own = (table: PgTable, column: PgColumn) => (column as Column).table === table

describe("the tables' declarations", () => {
  test("each names a table of the schema, and no table is declared twice", () => {
    const declared = DECLARATIONS.map((declaration) => declaration.table)
    for (const table of declared) assert.ok(TABLES.includes(table), `${nameOf(table)} is exported from schema/index.ts`)
    assert.deepEqual(
      declared.filter((table, index) => declared.indexOf(table) !== index).map(nameOf),
      [],
      "declared twice",
    )
  })

  test("every table but a ledger says whether the audit log keeps it — audited, or exempt and why — and a ledger is never audited", () => {
    const undeclared = TABLES.filter((table) => !isLedger(table))
      .filter((table) => {
        const declared = DECLARATIONS.find((declaration) => declaration.table === table)?.declared
        return declared?.audited === undefined && declared?.exempt === undefined
      })
      .map(nameOf)
    assert.deepEqual(undeclared, [], "declare each beside its table: policies(table, { audited: {} }) or policies(table, { exempt: why })")
    const ledgersAudited = DECLARATIONS.filter(({ table, declared }) => isLedger(table) && declared.audited !== undefined).map(({ table }) => nameOf(table))
    assert.deepEqual(ledgersAudited, [], "a ledger is its own history")
    for (const { table, declared } of DECLARATIONS) if (declared.exempt !== undefined) assert.ok(declared.exempt.length > 0, nameOf(table))
  })

  test("the audited tables are exactly the ones the domain names in AUDITED_TABLES, each under the domain's module", () => {
    const declared = new Set(AUDITED.map((entry) => nameOf(entry.table)))
    const named = new Set(Object.keys(AUDITED_TABLES))
    for (const table of declared) assert.ok(named.has(table), `${table} is declared audited, and AUDITED_TABLES (@waste/domain/audit/vocabulary) does not name it: name the module its history is read under there`)
    for (const table of named) assert.ok(declared.has(table), `AUDITED_TABLES names ${table}, and no table of the schema declares itself audited under that name: declare it beside its table, or take it out of the map`)
    for (const entry of AUDITED) assert.equal(entry.module, AUDITED_TABLES[nameOf(entry.table) as keyof typeof AUDITED_TABLES], nameOf(entry.table))
  })

  test("a parent, a door's columns and a counter are the table's own columns", () => {
    for (const { table, declared } of DECLARATIONS) {
      const parent = declared.audited?.parent
      if (parent !== undefined) assert.ok(own(table, parent), `${nameOf(table)}'s parent ${columnName(parent)}`)
      for (const column of declared.door?.columns ?? []) assert.ok(own(table, column), `${nameOf(table)}'s door column ${columnName(column)}`)
      for (const column of Object.values(declared.counters ?? {})) assert.ok(own(table, column), `${nameOf(table)}'s counter ${columnName(column)}`)
    }
  })

  test("a door names each column once, and brings rows", () => {
    for (const { table, columns, rows } of PUBLIC_DOOR_TABLES) {
      assert.equal(new Set(columns).size, columns.length, nameOf(table))
      assert.ok(rows.length > 0, nameOf(table))
    }
  })

  test("a counter is keyed by the table's own field name and is a whole number that starts from its column's default, which the reset puts back", () => {
    assert.ok(COUNTERS.length > 0, "the company's document counters")
    for (const { table, counters } of COUNTERS) {
      const fields = getTableColumns(table) as Record<string, PgColumn>
      for (const [key, column] of Object.entries(counters)) {
        assert.equal(fields[key], column, `${nameOf(table)}'s counter ${key} is its field ${key}`)
        assert.equal(column.notNull, true, `${nameOf(table)}.${columnName(column)}`)
        assert.equal(typeof column.default, "number", `${nameOf(table)}.${columnName(column)}`)
      }
    }
  })
})
