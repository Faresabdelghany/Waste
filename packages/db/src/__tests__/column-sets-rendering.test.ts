// The column sets as drizzle-kit writes them into a migration file, and the
// validity check beside them. No database.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { getTableConfig, text } from "drizzle-orm/pg-core"

import { columnNamed } from "../names"
import { id, projectScoped, tenant, timestamps, validity, validPeriod } from "../schema/columns"
import { wms } from "../schema/wms"
import { statementsFor } from "./specimen"

// An effective-dated, project-scoped record with every set spread in.
const specimen = wms.table(
  "specimen_column_sets_rendering",
  { ...id, ...projectScoped, ...timestamps, ...validity, subject: text().notNull() },
  (columns) => [validPeriod(columns)],
)

describe("the column sets as drizzle-kit writes them", () => {
  test("id, tenant, project, timestamps and validity, each column as the Data model rules spell it", async () => {
    const [createTable, ...rest] = await statementsFor({ specimen })
    assert.equal(rest.length, 0)
    assert.equal(
      createTable,
      [
        'CREATE TABLE "wms"."specimen_column_sets_rendering" (',
        '\t"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,',
        '\t"company_id" uuid NOT NULL,',
        '\t"project_id" uuid NOT NULL,',
        '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,',
        '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,',
        '\t"valid_from" date NOT NULL,',
        '\t"valid_to" date,',
        '\t"subject" text NOT NULL,',
        '\tCONSTRAINT "specimen_column_sets_rendering_validity" CHECK ("wms"."specimen_column_sets_rendering"."valid_to" is null or "wms"."specimen_column_sets_rendering"."valid_to" > "wms"."specimen_column_sets_rendering"."valid_from")',
        ");",
        "",
      ].join("\n"),
    )
  })

  test("projectScoped includes the tenant column, so a project-scoped table spreads it alone", () => {
    assert.deepEqual(Object.keys(projectScoped), ["companyId", "projectId"])
    assert.deepEqual(Object.keys(tenant), ["companyId"])
  })

  test("the sets are shared: two tables spreading the same objects render independently", async () => {
    const one = wms.table("specimen_shared_one", { ...id, ...tenant, ...timestamps })
    const two = wms.table("specimen_shared_two", { ...id, ...tenant, ...timestamps })
    const statements = await statementsFor({ one, two })
    assert.equal(statements.length, 2)
    for (const [statement, name] of [
      [statements[0], "specimen_shared_one"],
      [statements[1], "specimen_shared_two"],
    ] as const) {
      assert.match(statement, new RegExp(`^CREATE TABLE "wms"\\."${name}" \\(`))
      assert.match(statement, /\t"id" uuid PRIMARY KEY DEFAULT wms\.uuidv7\(\) NOT NULL,\n\t"company_id" uuid NOT NULL,\n\t"created_at"/)
    }
  })

  test("the validity columns read and write as YYYY-MM-DD strings, the timestamps as Dates", () => {
    const modeOf = (name: string) => {
      const column = columnNamed(specimen, name)
      assert.ok(column, name)
      return { dataType: column.dataType, sqlType: column.getSQLType() }
    }
    assert.deepEqual(modeOf("valid_from"), { dataType: "string", sqlType: "date" })
    assert.deepEqual(modeOf("valid_to"), { dataType: "string", sqlType: "date" })
    assert.deepEqual(modeOf("created_at"), { dataType: "date", sqlType: "timestamp with time zone" })
    assert.deepEqual(modeOf("updated_at"), { dataType: "date", sqlType: "timestamp with time zone" })
  })

  test("validPeriod names the check after the table and refuses a name Postgres would truncate", () => {
    assert.deepEqual(
      getTableConfig(specimen).checks.map((check) => check.name),
      ["specimen_column_sets_rendering_validity"],
    )
    const long = wms.table(
      "specimen_with_a_table_name_that_goes_on_and_on_and_on_and_on_and_on",
      { ...validity },
      (columns) => [validPeriod(columns)],
    )
    assert.throws(() => getTableConfig(long), /validPeriod: "specimen_with_a_table_name_that_goes_on_and_on_and_on_and_on_and_on_validity" is 76 bytes; Postgres would truncate it to 63 silently/)
  })
})
