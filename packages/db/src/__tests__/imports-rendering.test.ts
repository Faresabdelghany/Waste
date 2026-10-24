// The CSV import's two tables (#291 slice 12) as drizzle-kit writes them:
// the run, the company's with an optional project, and its rows, a ledger.
// Then migration 0018, which has to begin with exactly those statements and
// carry below them the run's fence and trigger and the rows' fence and
// revoke. No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { IMPORT_KINDS, IMPORT_ROW_OUTCOMES } from "@waste/domain/imports/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { importRun, importRunRow } from "../schema/imports"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, COMPANY, companyFk, createTable, ID, index, oneOfCheck, positiveCheck, ref, tenantFk, uniqueKey } from "./rendering"
import { statementsFor } from "./specimen"

const MIGRATION = "0018_import_run.sql"

const COUNTS = ["created", "updated", "unchanged", "refused"].map((name) => `${ref("import_run", `${name}_count`)}`)
const COUNTS_SHAPE = `${COUNTS.map((count) => `${count} >= 0`).join(" and ")} and ${COUNTS.join(" + ")} <= ${ref("import_run", "row_count")}`
const OUTCOME_SHAPE = `(${ref("import_run_row", "outcome")} = 'refused') = (${ref("import_run_row", "detail")} is not null) and (${ref("import_run_row", "outcome")} = 'refused') = (${ref("import_run_row", "resource_id")} is null)`

/** A ledger's CREATE TABLE: the id, the tenant, the one stamp, then its own lines. */
const createLedger = (name: string, lines: string[]): string =>
  [`CREATE TABLE "wms"."${name}" (`, [ID, COMPANY, '"recorded_at" timestamp with time zone DEFAULT now() NOT NULL', ...lines].map((line) => `\t${line}`).join(",\n"), ");", ""].join("\n")

const expected = [
  createTable("import_run", "tenant", [
    '"project_id" uuid',
    '"kind" text NOT NULL',
    '"file_name" text NOT NULL',
    '"row_count" integer NOT NULL',
    '"created_count" integer DEFAULT 0 NOT NULL',
    '"updated_count" integer DEFAULT 0 NOT NULL',
    '"unchanged_count" integer DEFAULT 0 NOT NULL',
    '"refused_count" integer DEFAULT 0 NOT NULL',
    '"requested_by" uuid NOT NULL',
    uniqueKey("import_run_tenant_key", "company_id", "id"),
    oneOfCheck("import_run", "kind", ...IMPORT_KINDS),
    positiveCheck("import_run", "row_count"),
    `CONSTRAINT "import_run_project_shape" CHECK ((${ref("import_run", "kind")} = 'customers') = (${ref("import_run", "project_id")} is null))`,
    `CONSTRAINT "import_run_counts_shape" CHECK (${COUNTS_SHAPE})`,
  ]),
  createLedger("import_run_row", [
    '"import_run_id" uuid NOT NULL',
    '"row_number" integer NOT NULL',
    '"outcome" text NOT NULL',
    '"key" text',
    '"resource_id" uuid',
    '"detail" text',
    uniqueKey("import_run_row_import_run_id_row_number_key", "company_id", "import_run_id", "row_number"),
    oneOfCheck("import_run_row", "outcome", ...IMPORT_ROW_OUTCOMES),
    `CONSTRAINT "import_run_row_row_number_shape" CHECK (${ref("import_run_row", "row_number")} >= 2)`,
    `CONSTRAINT "import_run_row_outcome_shape" CHECK (${OUTCOME_SHAPE})`,
  ]),
  companyFk("import_run"),
  tenantFk("import_run", "project_id", "project"),
  tenantFk("import_run", "requested_by", "user_account"),
  companyFk("import_run_row"),
  tenantFk("import_run_row", "import_run_id", "import_run"),
  index("import_run", "import_run_project_id_idx", "company_id", "project_id"),
  index("import_run", "import_run_requested_by_idx", "company_id", "requested_by"),
]

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

describe("the import's tables as drizzle-kit writes them", () => {
  test("the run, the company's with an optional project, and its rows, a ledger keyed by the run and the row number", async () => {
    assert.deepEqual(await statementsFor({ importRun, importRunRow }), expected)
  })

  test("migration 0018 is exactly that, then the run's fence and trigger and the rows' fence and revoke", async () => {
    const statements = await fileStatements()
    assert.deepEqual(statements, [...expected, ...handWrittenStatements(importRun), ...handWrittenStatements(importRunRow)].map(normalised))
    assert.ok(statements.some((statement) => statement.startsWith('REVOKE UPDATE, DELETE ON "wms"."import_run_row"')), "the rows are a ledger")
    assert.ok(!statements.some((statement) => statement.includes('"import_run_row_touch_updated_at"')), "and have no trigger")
  })
})

describe("the checks", () => {
  test("a run's kind and a row's outcome read the import's vocabulary", () => {
    assert.deepEqual([...checksOf(importRun).keys()].sort(), ["import_run_counts_shape", "import_run_kind_one_of", "import_run_project_shape", "import_run_row_count_positive"])
    assert.deepEqual([...checksOf(importRunRow).keys()].sort(), ["import_run_row_outcome_one_of", "import_run_row_outcome_shape", "import_run_row_row_number_shape"])
  })
})
