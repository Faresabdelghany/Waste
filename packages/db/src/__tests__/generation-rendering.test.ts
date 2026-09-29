// Generation's two tables (Issue #97 part B) as drizzle-kit writes them: the
// CREATE TABLE statements of `generation_run` and `generation_match` with
// their columns, keys, uniques and checks — the run's two `one_of` checks and
// its window check, the stamp's one-per-group-per-run key — and the three
// statements that give Execution's `route` the run that last wrote it: the
// column, its key into `generation_run` and its index; then migration 0012,
// which has to begin with exactly those statements, so the file and `pnpm
// db:generate` cannot drift apart, and to carry below them what the helpers
// write for each table, the fence and the trigger. No database.
//
// `route` was created in 0008 (Issue #104) and an applied file is never
// edited, so its ALTER TABLE is diffed here from 0008's spelling to today's
// — the route as of 0008 spelled beside the real one — and
// execution-rendering.test.ts maps today's CREATE TABLE back onto what 0008
// says (`CHANGED_IN_0012`) and leaves the key and the index out
// (`ADDED_IN_0012`), the way registry-rendering.test.ts holds 0004 to its
// own day.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { PICKUP_STATUSES, ROUTE_STATUSES } from "@waste/domain/execution/vocabulary"
import { GENERATION_RUN_STATUSES, GENERATION_TRIGGERS } from "@waste/domain/planning/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { route } from "../schema/execution"
import { generationMatch, generationRun } from "../schema/generation"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, companyFk, createTable, index, oneOfCheck, projectFk, projectFkTo, ref, uniqueKey } from "./rendering"
import { routeAsOf } from "./route-as-of"
import { statementsBetween, statementsFor } from "./specimen"

/** The two tables in the order src/schema/generation.ts defines them; drizzle-kit's own loader sorts a module's exports, which the migration test allows for. */
const tables = { generationRun, generationMatch }

const MIGRATION = "0012_generation.sql"
const INSTANT = "timestamp with time zone"

const expected = [
  createTable("generation_run", "project", [
    '"route_scheme_id" uuid NOT NULL',
    '"trigger" text NOT NULL',
    '"window_from" date NOT NULL',
    '"window_to" date NOT NULL',
    `"status" text DEFAULT 'queued' NOT NULL`,
    '"job_id" text',
    `"started_at" ${INSTANT}`,
    `"finished_at" ${INSTANT}`,
    '"routes_created" integer DEFAULT 0 NOT NULL',
    '"routes_refreshed" integer DEFAULT 0 NOT NULL',
    '"routes_cancelled" integer DEFAULT 0 NOT NULL',
    '"pickups_written" integer DEFAULT 0 NOT NULL',
    '"holidays_skipped" integer DEFAULT 0 NOT NULL',
    '"unlocated" integer DEFAULT 0 NOT NULL',
    `"warnings" text[] DEFAULT '{}'::text[] NOT NULL`,
    '"error" text',
    uniqueKey("generation_run_project_key", "company_id", "project_id", "id"),
    oneOfCheck("generation_run", "trigger", ...GENERATION_TRIGGERS),
    oneOfCheck("generation_run", "status", ...GENERATION_RUN_STATUSES),
    `CONSTRAINT "generation_run_window_ordered" CHECK (${ref("generation_run", "window_to")} >= ${ref("generation_run", "window_from")})`,
  ]),
  createTable("generation_match", "project", [
    '"collection_group_id" uuid NOT NULL',
    '"generation_run_id" uuid NOT NULL',
    '"rule_signature" text NOT NULL',
    '"container_ids" uuid[] NOT NULL',
    uniqueKey("generation_match_collection_group_id_generation_run_id_key", "company_id", "collection_group_id", "generation_run_id"),
  ]),
  companyFk("generation_run"),
  projectFk("generation_run"),
  projectFkTo("generation_run", "route_scheme_id", "route_scheme"),
  companyFk("generation_match"),
  projectFk("generation_match"),
  projectFkTo("generation_match", "collection_group_id", "collection_group"),
  projectFkTo("generation_match", "generation_run_id", "generation_run"),
  index("generation_run", "generation_run_route_scheme_id_idx", "company_id", "route_scheme_id"),
  index("generation_match", "generation_match_project_id_idx", "company_id", "project_id"),
  index("generation_match", "generation_match_generation_run_id_idx", "company_id", "generation_run_id"),
]

const routeAsOf0008 = routeAsOf("0008")
const routeAsOf0012 = routeAsOf("0012")

/** What 0012 does to `route`: the run that last wrote it, as a column, its key into the run and its index. */
const altered = [
  'ALTER TABLE "wms"."route" ADD COLUMN "generation_run_id" uuid;',
  projectFkTo("route", "generation_run_id", "generation_run"),
  index("route", "route_generation_run_id_idx", "company_id", "generation_run_id"),
]

/** What the two tables owe their migration file, in the order migrations/README.md lays out: fence and trigger, table by table. */
const handWritten = Object.values(tables).flatMap((table) => handWrittenStatements(table))

/** The ALTER TABLEs as drizzle-kit wrote them: the route from 0008's spelling to 0012's — 0013's active Plan is routing-rendering.test.ts's to pin. */
const generatedAlterations = (): Promise<string[]> => statementsBetween({ route: routeAsOf0008 }, { route: routeAsOf0012 })

/** Everything drizzle-kit wrote at the head of 0012: the two tables and the altered route. */
const generatedHead = async (): Promise<string[]> => [...(await statementsFor(tables)), ...(await generatedAlterations())]

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

describe("the Generation tables as drizzle-kit writes them", () => {
  test("two tables, every column, key, unique and check as the Domain model spells them, every name within 63 bytes", async () => {
    assert.deepEqual(await statementsFor(tables), expected)
  })

  test("the route gains the run that last wrote it: a column, its key into generation_run and its index, in three ALTER TABLE and CREATE INDEX statements", async () => {
    assert.deepEqual(await generatedAlterations(), altered)
  })

  test("migration 0012 begins with exactly what drizzle-kit generates for the schema: 15 statements", async () => {
    const statements = await fileStatements()
    // The same statements, whatever order drizzle-kit's loader gave the tables (it sorts a module's exports).
    const generated = (await generatedHead()).map(normalised).sort()
    assert.equal(generated.length, 15, "two CREATE TABLE, one ADD COLUMN, eight foreign keys, four indexes")
    assert.deepEqual([...statements.slice(0, generated.length)].sort(), generated)
  })

  test("and carries below them the fence and trigger of each table: 2 x 3 = 6 statements", async () => {
    const statements = await fileStatements()
    const generated = await generatedHead()
    const tail = statements.slice(generated.length)
    assert.equal(tail.length, 6)
    assert.deepEqual(tail, handWritten.map(normalised))
    assert.equal(tail.filter((statement) => statement.startsWith("CREATE TRIGGER")).length, 2, "neither is a ledger")
    assert.equal(tail.filter((statement) => statement.startsWith("CREATE POLICY")).length, 2, "every table")
    assert.equal(tail.filter((statement) => statement.startsWith("REVOKE")).length, 0)
  })
})

describe("the checks of this context", () => {
  test("every check of the two tables renders without parameters, the way every check in a migration must, and the run's read the vocabulary", () => {
    assert.deepEqual([...checksOf(generationRun).keys()], ["generation_run_trigger_one_of", "generation_run_status_one_of", "generation_run_window_ordered"])
    assert.deepEqual([...checksOf(generationMatch).keys()], [])
    const checks = checksOf(generationRun)
    for (const trigger of GENERATION_TRIGGERS) assert.ok(checks.get("generation_run_trigger_one_of")?.includes(`'${trigger}'`), trigger)
    for (const status of GENERATION_RUN_STATUSES) assert.ok(checks.get("generation_run_status_one_of")?.includes(`'${status}'`), status)
    assert.equal(checks.get("generation_run_window_ordered"), `${ref("generation_run", "window_to")} >= ${ref("generation_run", "window_from")}`)
  })

  test("the days read as strings, the instants as Dates, the stamp's ids as an array, and the run's counts default to nothing done", () => {
    for (const column of [generationRun.windowFrom, generationRun.windowTo]) assert.deepEqual({ dataType: column.dataType, sqlType: column.getSQLType() }, { dataType: "string", sqlType: "date" })
    for (const column of [generationRun.startedAt, generationRun.finishedAt]) assert.deepEqual({ dataType: column.dataType, sqlType: column.getSQLType() }, { dataType: "date", sqlType: "timestamp with time zone" })
    assert.equal(generationMatch.containerIds.getSQLType(), "uuid[]")
    assert.equal(generationRun.warnings.getSQLType(), "text[]")
    for (const column of [generationRun.routesCreated, generationRun.routesRefreshed, generationRun.routesCancelled, generationRun.pickupsWritten, generationRun.holidaysSkipped, generationRun.unlocated]) {
      assert.equal(column.getSQLType(), "integer")
      assert.equal(column.default, 0)
    }
    assert.equal(route.generationRunId.getSQLType(), "uuid")
    assert.equal(route.generationRunId.notNull, false, "a route no run has written names none")
    // Execution's statuses are what the run writes; pinned so a rename there is a migration here too.
    assert.deepEqual([...ROUTE_STATUSES], ["planned", "ready", "active", "completed", "cancelled"])
    assert.deepEqual([...PICKUP_STATUSES], ["planned", "completed", "skipped", "failed"])
  })
})
