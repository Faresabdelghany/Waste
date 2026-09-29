// Routing's three tables (#169, #124/#132) as drizzle-kit writes them: the
// Plan with its solver, status, trip, fingerprint, totals, deferral and
// provenance, and the two result ledgers, the stops and the legs — the legs'
// `path` the system's first `geometry(LineString, 4326)` column — and the two
// statements that give Execution's `route` its active Plan: the column and its
// index, diffed from 0012's spelling (route-as-of.ts) since an applied file is
// never edited; execution-rendering.test.ts maps today's route back
// (`CHANGED_IN_0013`, `ADDED_IN_0013`). Then migration 0013, which has to
// begin with exactly those statements and to carry below them what the
// helpers write — the fence for all three, the trigger for the plan, the
// revoke for the two ledgers — and, last, the one statement drizzle-kit
// cannot express: the active Plan's key with its SET NULL column subset
// (src/sql/active-plan.ts), pinned here byte for byte. No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { PLAN_SOLVERS, PLAN_STATUSES, PLAN_TRIPS } from "@waste/domain/routing/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { route } from "../schema/execution"
import { plan, planLeg, planStop } from "../schema/routing"
import { activePlanKey } from "../sql/active-plan"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, COMPANY, companyFk, createTable, foreignKey, geometryCheck, ID, index, oneOfCheck, positiveCheck, PROJECT, projectFk, projectFkTo, ref, uniqueKey } from "./rendering"
import { routeAsOf } from "./route-as-of"
import { statementsBetween, statementsFor } from "./specimen"

/** The three tables in the order 0013's hand-written tail carries them. */
const tables = { plan, planStop, planLeg }

const MIGRATION = "0013_routing.sql"
const INSTANT = "timestamp with time zone"
const RECORDED = '"recorded_at" timestamp with time zone DEFAULT now() NOT NULL'
const createLedger = (name: string, lines: string[]): string =>
  [`CREATE TABLE "wms"."${name}" (`, [ID, COMPANY, PROJECT, RECORDED, ...lines].map((line) => `\t${line}`).join(",\n"), ");", ""].join("\n")

const planFk = (table: string): string =>
  foreignKey(table, `${table}_route_id_plan_id_fk`, ["company_id", "project_id", "route_id", "plan_id"], "plan", ["company_id", "project_id", "route_id", "id"])

const expected = [
  createTable("plan", "project", [
    '"route_id" uuid NOT NULL',
    '"solver" text NOT NULL',
    `"status" text DEFAULT 'calculating' NOT NULL`,
    '"fingerprint" text NOT NULL',
    '"trip" text NOT NULL',
    '"distance_metres" integer',
    '"duration_seconds" integer',
    `"deferred_until" ${INSTANT}`,
    '"failure_reason" text',
    '"provider" text NOT NULL',
    '"engine_version" text',
    '"graph_date" date',
    uniqueKey("plan_route_id_project_key", "company_id", "project_id", "route_id", "id"),
    oneOfCheck("plan", "solver", ...PLAN_SOLVERS),
    oneOfCheck("plan", "status", ...PLAN_STATUSES),
    oneOfCheck("plan", "trip", ...PLAN_TRIPS),
    `CONSTRAINT "plan_totals_shape" CHECK (case ${ref("plan", "status")} when 'ready' then ${ref("plan", "distance_metres")} is not null and ${ref("plan", "distance_metres")} >= 0 and ${ref("plan", "duration_seconds")} is not null and ${ref("plan", "duration_seconds")} >= 0 else ${ref("plan", "distance_metres")} is null and ${ref("plan", "duration_seconds")} is null end)`,
    `CONSTRAINT "plan_failure_shape" CHECK ((${ref("plan", "status")} = 'failed') = (${ref("plan", "failure_reason")} is not null))`,
    `CONSTRAINT "plan_deferred_shape" CHECK (${ref("plan", "deferred_until")} is null or ${ref("plan", "status")} = 'calculating')`,
  ]),
  createLedger("plan_stop", [
    '"route_id" uuid NOT NULL',
    '"plan_id" uuid NOT NULL',
    '"pickup_id" uuid NOT NULL',
    '"position" integer NOT NULL',
    uniqueKey("plan_stop_plan_id_position_key", "company_id", "plan_id", "position"),
    uniqueKey("plan_stop_plan_id_pickup_id_key", "company_id", "plan_id", "pickup_id"),
    positiveCheck("plan_stop", "position"),
  ]),
  createLedger("plan_leg", [
    '"route_id" uuid NOT NULL',
    '"plan_id" uuid NOT NULL',
    '"position" integer NOT NULL',
    '"path" geometry(LineString, 4326) NOT NULL',
    '"metres" integer NOT NULL',
    '"seconds" integer NOT NULL',
    uniqueKey("plan_leg_plan_id_position_key", "company_id", "plan_id", "position"),
    positiveCheck("plan_leg", "position"),
    geometryCheck("plan_leg", "path"),
    `CONSTRAINT "plan_leg_measure_shape" CHECK (${ref("plan_leg", "metres")} >= 0 and ${ref("plan_leg", "seconds")} >= 0)`,
  ]),
  companyFk("plan"),
  projectFk("plan"),
  projectFkTo("plan", "route_id", "route"),
  companyFk("plan_stop"),
  projectFk("plan_stop"),
  projectFkTo("plan_stop", "route_id", "route"),
  planFk("plan_stop"),
  foreignKey("plan_stop", "plan_stop_route_id_pickup_id_fk", ["company_id", "project_id", "route_id", "pickup_id"], "pickup", ["company_id", "project_id", "route_id", "id"]),
  companyFk("plan_leg"),
  projectFk("plan_leg"),
  projectFkTo("plan_leg", "route_id", "route"),
  planFk("plan_leg"),
  index("plan", "plan_fingerprint_idx", "company_id", "fingerprint"),
  index("plan_stop", "plan_stop_pickup_id_idx", "company_id", "pickup_id"),
]

/** What 0013 does to `route`: the active Plan as a column and its index — the key is hand-written, so drizzle-kit never sees it. */
const altered = ['ALTER TABLE "wms"."route" ADD COLUMN "active_plan_id" uuid;', index("route", "route_active_plan_id_idx", "company_id", "active_plan_id")]

/** What the three tables owe their migration file: the fence for each, the trigger for the plan, the revoke for the two ledgers. */
const handWritten = Object.values(tables).flatMap((table) => handWrittenStatements(table))

/** The ALTER TABLEs as drizzle-kit wrote them: the route from 0012's spelling to today's. */
const generatedAlterations = (): Promise<string[]> => statementsBetween({ route: routeAsOf("0012") }, { route })

/** Everything drizzle-kit wrote at the head of 0013: the three tables and the altered route. */
const generatedHead = async (): Promise<string[]> => [...(await statementsFor(tables)), ...(await generatedAlterations())]

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

describe("the Routing tables as drizzle-kit writes them", () => {
  test("three tables, every column, key, unique and check as the decisions spell them, every name within 63 bytes", async () => {
    assert.deepEqual(await statementsFor(tables), expected)
  })

  test("the route gains its active Plan: a column and its index, and no drizzle-kit key", async () => {
    assert.deepEqual(await generatedAlterations(), altered)
  })

  test("migration 0013 begins with exactly what drizzle-kit generates for the schema: 19 statements", async () => {
    const statements = await fileStatements()
    // The same statements, whatever order drizzle-kit's loader gave the tables (it sorts a module's exports).
    const generated = (await generatedHead()).map(normalised).sort()
    assert.equal(generated.length, 19, "three CREATE TABLE, one ADD COLUMN, twelve foreign keys, three indexes")
    assert.deepEqual([...statements.slice(0, generated.length)].sort(), generated)
  })

  test("and carries below them the fence of each, the plan's trigger, the ledgers' revokes, and, last, the hand-written active-plan key", async () => {
    const statements = await fileStatements()
    const generated = await generatedHead()
    const tail = statements.slice(generated.length)
    assert.deepEqual(tail, [...handWritten, activePlanKey()].map(normalised))
    assert.equal(tail.filter((statement) => statement.startsWith("CREATE TRIGGER")).length, 1, "the plan alone has an updated_at to touch")
    assert.equal(tail.filter((statement) => statement.startsWith("REVOKE")).length, 2, "the stops and the legs are ledgers")
    assert.equal(tail.filter((statement) => statement.startsWith("CREATE POLICY")).length, 3, "every table")
  })

  test("the active-plan key clears itself on exactly its own column: SET NULL with the referencing-column subset", () => {
    assert.equal(
      activePlanKey(),
      'ALTER TABLE "wms"."route" ADD CONSTRAINT "route_active_plan_id_fk" ' +
        'FOREIGN KEY ("company_id","project_id","id","active_plan_id") ' +
        'REFERENCES "wms"."plan"("company_id","project_id","route_id","id") ' +
        'ON DELETE SET NULL ("active_plan_id");',
    )
  })
})

describe("the checks of this context", () => {
  test("every check renders without parameters, and the three one_of checks read the routing vocabulary", () => {
    assert.deepEqual([...checksOf(plan).keys()], ["plan_solver_one_of", "plan_status_one_of", "plan_trip_one_of", "plan_totals_shape", "plan_failure_shape", "plan_deferred_shape"])
    assert.deepEqual([...checksOf(planStop).keys()], ["plan_stop_position_positive"])
    assert.deepEqual([...checksOf(planLeg).keys()], ["plan_leg_position_positive", "plan_leg_path_valid", "plan_leg_measure_shape"])
    const checks = checksOf(plan)
    for (const solver of PLAN_SOLVERS) assert.ok(checks.get("plan_solver_one_of")?.includes(`'${solver}'`), solver)
    for (const status of PLAN_STATUSES) assert.ok(checks.get("plan_status_one_of")?.includes(`'${status}'`), status)
    for (const trip of PLAN_TRIPS) assert.ok(checks.get("plan_trip_one_of")?.includes(`'${trip}'`), trip)
  })

  test("the columns read as the decisions expect: the leg a LineString, the graph date a day, the deferral an instant, the route's pointer nullable", () => {
    assert.equal(planLeg.path.getSQLType(), "geometry(LineString, 4326)")
    assert.equal(planLeg.path.notNull, true, "a leg without geometry is no leg")
    assert.deepEqual({ dataType: plan.graphDate.dataType, sqlType: plan.graphDate.getSQLType() }, { dataType: "string", sqlType: "date" })
    assert.deepEqual({ dataType: plan.deferredUntil.dataType, sqlType: plan.deferredUntil.getSQLType() }, { dataType: "date", sqlType: INSTANT })
    for (const column of [plan.distanceMetres, plan.durationSeconds, planLeg.metres, planLeg.seconds, planStop.position, planLeg.position]) assert.equal(column.getSQLType(), "integer")
    assert.equal(route.activePlanId.getSQLType(), "uuid")
    assert.equal(route.activePlanId.notNull, false, "null means the generated baseline stands unmeasured, drawn dashed (#124)")
    assert.equal(plan.status.default, "calculating")
  })
})
