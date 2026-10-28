// A warehouse's Stock Minimums (O30 of #290, row 9.8) as drizzle-kit writes
// them: one new table, a positive count per warehouse and container type,
// keyed into the warehouse through its project. Then the migration, which is
// exactly those statements under its header, then what the table owes the
// file by migrations/README.md: its fence and trigger, and its audit trail as
// its warehouse's set (`STOCK_MINIMUMS_AUDITED`). The file is found by its
// name, not its number, which it takes at its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MIGRATIONS_FOLDER } from "../migrate"
import { containerType } from "../schema/catalogue"
import { company, project } from "../schema/organisation"
import { depot, warehouse } from "../schema/places"
import { stockMinimum } from "../schema/stock"
import { auditTrail, STOCK_MINIMUMS_AUDITED } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, ref } from "./rendering"
import { statementsBetween } from "./specimen"

const referenced = { company, project, depot, warehouse, containerType }

/** What drizzle-kit writes for the migration: the one table. */
const generated = (): Promise<string[]> => statementsBetween(referenced, { ...referenced, stockMinimum })

/** What the table owes the file below drizzle-kit's statements: its fence and trigger, then its audit trail. */
const handWritten = [...handWrittenStatements(stockMinimum), ...STOCK_MINIMUMS_AUDITED.flatMap(auditTrail)]

async function fileText(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_stock_minimums\.sql$/.test(name))
  assert.ok(file !== undefined, "the stock minimums' migration")
  return readFile(join(MIGRATIONS_FOLDER, file), "utf8")
}

describe("the stock minimums as drizzle-kit writes them", () => {
  test("a minimum is one per warehouse and type, keys into the warehouse through its project, and is a positive count", async () => {
    const statements = await generated()
    assert.match(statements[0], /CONSTRAINT "stock_minimum_warehouse_id_container_type_id_key" UNIQUE\("company_id","warehouse_id","container_type_id"\)/)
    assert.ok(statements.includes('ALTER TABLE "wms"."stock_minimum" ADD CONSTRAINT "stock_minimum_warehouse_id_fk" FOREIGN KEY ("company_id","project_id","warehouse_id") REFERENCES "wms"."warehouse"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;'))
    assert.equal(checksOf(stockMinimum).get("stock_minimum_minimum_positive"), `${ref("stock_minimum", "minimum")} > 0`)
  })
})

describe("the stock minimums' migration", () => {
  test("begins with exactly what drizzle-kit generates for it, under its header", async () => {
    const text = await fileText()
    const head = (await generated()).map(normalised)
    assert.deepEqual(statementsOf(text).slice(0, head.length), head)
    assert.match(text, /^-- A warehouse's Stock Minimums \(O30 of #290, row 9\.8\)/)
  })

  test("and carries below them the table's fence, trigger and audit trail, in that order", async () => {
    const statements = statementsOf(await fileText())
    const head = (await generated()).length
    assert.deepEqual(statements.slice(head), handWritten.map(normalised))
    assert.equal(STOCK_MINIMUMS_AUDITED.length, 1)
  })
})
