// The Planning tables (Issue #97, slice 1) as drizzle-kit writes them: the
// nine CREATE TABLE statements with their columns, keys, uniques and checks —
// the first `text[]` columns with their subset and non-empty checks, the
// first stored polygon with its GiST index, the two inline shape checks and
// the two inline-named membership keys — and the ALTER TABLE that gives
// `project` its working week; then migration 0006, which has to begin with
// exactly those statements as they were generated as of 0006, so the file and
// `pnpm db:generate` cannot drift apart, and to carry below them what the
// helpers write for each table and the three exclusion constraints. The two
// new check helpers by their text and their refusals. No database.
//
// Migration 0007 (Issue #101) changed two of the nine: `collection_group`
// gained `rule_vehicle_type_id`, `vehicle_id` and `driver_id` and lost the
// `rule_vehicle_type` token, `route_scheme` gained `depot_id` and
// `unloading_station_id`, each with its keys and indexes. An applied file is
// never edited, so 0006 is held to the earlier spelling: `CHANGED_IN_0007`
// maps the two CREATE TABLEs as drizzle-kit writes them now onto what 0006
// says, and `ADDED_IN_0007` is left out of the comparison, the way
// organisation-access-rendering.test.ts holds 0002 to its own day.
// resources-rendering.test.ts pins the ALTER TABLE statements themselves.
//
// This is also what makes a change to the vocabulary a migration: the values
// are spelled here as the file spells them, so adding one to a list in
// @waste/domain/planning/vocabulary fails this test until a migration replaces
// the check.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { sql } from "drizzle-orm"
import { check, getTableConfig, text } from "drizzle-orm/pg-core"

import { MIGRATIONS_FOLDER } from "../migrate"
import { nonEmpty, oneOf, subsetOf } from "../schema/checks"
import { collectionCalendar, collectionCalendarHoliday } from "../schema/collection-calendars"
import { id, tenant, timestamps } from "../schema/columns"
import { tableObjectName } from "../names"
import { company, project, PROJECT_STATUSES } from "../schema/organisation"
import { planningArea, planningAreaBoundary } from "../schema/planning-areas"
import { companyReference, tenantKey, tenantUnique } from "../schema/references"
import { collectionGroup, collectionGroupContainer, collectionGroupContainerType, collectionGroupFraction, routeScheme } from "../schema/route-schemes"
import { wms } from "../schema/wms"
import { excludeOverlapping } from "../sql/exclude-overlapping"
import { normalised, statementsOf } from "../sql/hand-written"
import { tenantFence } from "../sql/tenant-fence"
import { touchUpdatedAt } from "../sql/touch-updated-at"
import {
  checksOf,
  companyFk,
  createTable,
  geometryCheck,
  gistIndex,
  index,
  list,
  nonEmptyCheck,
  oneOfCheck,
  positiveCheck,
  projectFk,
  projectFkTo,
  ref,
  subsetCheck,
  tenantFk,
  uniqueKey,
  validityCheck,
} from "./rendering"
import { statementsBetween, statementsFor } from "./specimen"

/** The nine tables in the order src/schema/index.ts exports them; drizzle-kit's own loader sorts a module's exports, which the migration test allows for. */
const tables = {
  planningArea,
  planningAreaBoundary,
  collectionCalendar,
  collectionCalendarHoliday,
  routeScheme,
  collectionGroup,
  collectionGroupFraction,
  collectionGroupContainerType,
  collectionGroupContainer,
}

const MIGRATION = "0006_planning.sql"

/**
 * The project table as 0005 left it, so `statementsBetween` can write the
 * ALTER TABLE of 0006: the same name and columns as src/schema/organisation.ts
 * had before Issue #97, less `weekend` and `holiday_list`. Another table
 * object of the same name is fine here, since nothing connects to a database.
 */
const projectAsOf0005 = wms.table(
  "project",
  {
    ...id,
    ...tenant,
    ...timestamps,
    name: text().notNull(),
    kind: text().notNull(),
    language: text().notNull(),
    currency: text().notNull(),
    timezone: text().notNull(),
    status: text().notNull(),
  },
  (t) => [companyReference(t, company), tenantUnique(t, t.name), tenantKey(t), oneOf(t.status, PROJECT_STATUSES)],
)

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

/** What 0006 does to `project`: the two columns and the two checks, as `ALTER TABLE` statements. The default is the domain's `DEFAULT_WEEKEND` spelled as an array literal. */
const projectAltered = [
  `ALTER TABLE "wms"."project" ADD COLUMN "weekend" text[] DEFAULT '{saturday,sunday}' NOT NULL;`,
  `ALTER TABLE "wms"."project" ADD COLUMN "holiday_list" text;`,
  `ALTER TABLE "wms"."project" ADD CONSTRAINT "project_weekend_subset_of" CHECK (${ref("project", "weekend")} <@ ARRAY[${list(...DAYS)}]::text[]);`,
  `ALTER TABLE "wms"."project" ADD CONSTRAINT "project_weekend_not_every_day" CHECK (cardinality(${ref("project", "weekend")}) < 7);`,
]

/** route_scheme as drizzle-kit writes it today, and as it wrote it as of 0006, before 0007 gave it a depot and a station. */
const routeSchemeTable = (resources: boolean): string =>
  createTable("route_scheme", "dated", [
    '"name" text NOT NULL',
    '"planning_area_id" uuid',
    '"service_type" text NOT NULL',
    '"frequency" text NOT NULL',
    '"service_days" text[] NOT NULL',
    '"week_rotation" text',
    '"planned_start_time" time',
    `"holiday_policy" text DEFAULT 'skip' NOT NULL`,
    `"edit_policy" text DEFAULT 'ask' NOT NULL`,
    '"plan_ahead" boolean DEFAULT true NOT NULL',
    `"status" text DEFAULT 'draft' NOT NULL`,
    ...(resources ? ['"depot_id" uuid', '"unloading_station_id" uuid'] : []),
    uniqueKey("route_scheme_project_key", "company_id", "project_id", "id"),
    validityCheck("route_scheme"),
    oneOfCheck("route_scheme", "service_type", "container-collection", "underground-collection", "kerbside-collection", "crane-collection", "tank-emptying"),
    oneOfCheck("route_scheme", "frequency", "daily", "weekly", "every-2-weeks", "every-3-weeks", "every-4-weeks", "monthly"),
    subsetCheck("route_scheme", "service_days", ...DAYS),
    nonEmptyCheck("route_scheme", "service_days"),
    oneOfCheck("route_scheme", "week_rotation", "odd", "even"),
    oneOfCheck("route_scheme", "holiday_policy", "shift-next", "shift-prev", "skip", "collect"),
    oneOfCheck("route_scheme", "edit_policy", "ask", "future", "single"),
    oneOfCheck("route_scheme", "status", "draft", "validated"),
    `CONSTRAINT "route_scheme_week_rotation_shape" CHECK ((${ref("route_scheme", "frequency")} = 'every-2-weeks') = (${ref("route_scheme", "week_rotation")} is not null))`,
  ])

/** collection_group as drizzle-kit writes it today — the vehicle type a key, a vehicle and a driver — and as of 0006, with the token and its check. */
const collectionGroupTable = (resources: boolean): string =>
  createTable("collection_group", "project", [
    '"route_scheme_id" uuid NOT NULL',
    '"name" text NOT NULL',
    '"position" integer NOT NULL',
    '"days" text[] NOT NULL',
    '"stop_source" text NOT NULL',
    ...(resources ? ['"rule_vehicle_type_id" uuid', '"service_provider_id" uuid', '"vehicle_id" uuid', '"driver_id" uuid'] : ['"rule_vehicle_type" text', '"service_provider_id" uuid']),
    uniqueKey("collection_group_route_scheme_id_name_key", "company_id", "route_scheme_id", "name"),
    uniqueKey("collection_group_project_key", "company_id", "project_id", "id"),
    subsetCheck("collection_group", "days", ...DAYS),
    oneOfCheck("collection_group", "stop_source", "rule", "manual"),
    ...(resources ? [] : [oneOfCheck("collection_group", "rule_vehicle_type", "rear-loader", "organic-sealed", "paper-compactor", "glass-crane", "vacuum-tanker")]),
    positiveCheck("collection_group", "position"),
    `CONSTRAINT "collection_group_rule_shape" CHECK (${ref("collection_group", "stop_source")} = 'rule' or ${ref("collection_group", resources ? "rule_vehicle_type_id" : "rule_vehicle_type")} is null)`,
  ])

/** What 0007 changed on two tables 0006 created: the statement as drizzle-kit generates it now, and as it generated it as of 0006. */
const CHANGED_IN_0007 = new Map([
  [routeSchemeTable(true), routeSchemeTable(false)],
  [collectionGroupTable(true), collectionGroupTable(false)],
])

/** What 0007 added to the two tables beside the columns: their keys into Resources and the indexes those need. 0006 begins with the generated statements less these. */
const ADDED_IN_0007 = [
  projectFkTo("route_scheme", "depot_id", "depot"),
  tenantFk("route_scheme", "unloading_station_id", "unloading_station"),
  tenantFk("collection_group", "rule_vehicle_type_id", "vehicle_type"),
  projectFkTo("collection_group", "vehicle_id", "vehicle"),
  projectFkTo("collection_group", "driver_id", "driver"),
  index("route_scheme", "route_scheme_depot_id_idx", "company_id", "depot_id"),
  index("route_scheme", "route_scheme_unloading_station_id_idx", "company_id", "unloading_station_id"),
  index("collection_group", "collection_group_rule_vehicle_type_id_idx", "company_id", "rule_vehicle_type_id"),
  index("collection_group", "collection_group_vehicle_id_idx", "company_id", "vehicle_id"),
  index("collection_group", "collection_group_driver_id_idx", "company_id", "driver_id"),
]

const expected = [
  createTable("planning_area", "project", [
    '"code" text NOT NULL',
    '"name" text NOT NULL',
    '"purpose" text NOT NULL',
    uniqueKey("planning_area_project_id_code_key", "company_id", "project_id", "code"),
    uniqueKey("planning_area_project_id_name_key", "company_id", "project_id", "name"),
    uniqueKey("planning_area_project_key", "company_id", "project_id", "id"),
    oneOfCheck("planning_area", "purpose", "route-planning", "service-operations", "notification"),
  ]),
  createTable("planning_area_boundary", "dated", [
    '"planning_area_id" uuid NOT NULL',
    '"boundary" geometry(Polygon, 4326) NOT NULL',
    validityCheck("planning_area_boundary"),
    geometryCheck("planning_area_boundary", "boundary"),
  ]),
  createTable("collection_calendar", "dated", [
    '"name" text NOT NULL',
    uniqueKey("collection_calendar_project_id_name_key", "company_id", "project_id", "name"),
    uniqueKey("collection_calendar_project_key", "company_id", "project_id", "id"),
    validityCheck("collection_calendar"),
  ]),
  createTable("collection_calendar_holiday", "project", [
    '"collection_calendar_id" uuid NOT NULL',
    '"day" date NOT NULL',
    '"name" text',
    uniqueKey("collection_calendar_holiday_collection_calendar_id_day_key", "company_id", "collection_calendar_id", "day"),
  ]),
  routeSchemeTable(true),
  collectionGroupTable(true),
  createTable("collection_group_fraction", "project", [
    '"collection_group_id" uuid NOT NULL',
    '"waste_fraction_id" uuid NOT NULL',
    uniqueKey("collection_group_fraction_membership_key", "company_id", "collection_group_id", "waste_fraction_id"),
  ]),
  createTable("collection_group_container_type", "project", [
    '"collection_group_id" uuid NOT NULL',
    '"container_type_id" uuid NOT NULL',
    uniqueKey("collection_group_container_type_membership_key", "company_id", "collection_group_id", "container_type_id"),
  ]),
  createTable("collection_group_container", "project", [
    '"collection_group_id" uuid NOT NULL',
    '"container_id" uuid NOT NULL',
    '"position" integer NOT NULL',
    // Exactly 63 bytes: the longest name Postgres keeps whole.
    uniqueKey("collection_group_container_collection_group_id_container_id_key", "company_id", "collection_group_id", "container_id"),
    uniqueKey("collection_group_container_collection_group_id_position_key", "company_id", "collection_group_id", "position"),
    positiveCheck("collection_group_container", "position"),
  ]),
  companyFk("planning_area"),
  projectFk("planning_area"),
  companyFk("planning_area_boundary"),
  projectFk("planning_area_boundary"),
  projectFkTo("planning_area_boundary", "planning_area_id", "planning_area"),
  companyFk("collection_calendar"),
  projectFk("collection_calendar"),
  companyFk("collection_calendar_holiday"),
  projectFk("collection_calendar_holiday"),
  projectFkTo("collection_calendar_holiday", "collection_calendar_id", "collection_calendar"),
  companyFk("route_scheme"),
  projectFk("route_scheme"),
  projectFkTo("route_scheme", "planning_area_id", "planning_area"),
  projectFkTo("route_scheme", "depot_id", "depot"),
  tenantFk("route_scheme", "unloading_station_id", "unloading_station"),
  companyFk("collection_group"),
  projectFk("collection_group"),
  projectFkTo("collection_group", "route_scheme_id", "route_scheme"),
  tenantFk("collection_group", "service_provider_id", "service_provider"),
  tenantFk("collection_group", "rule_vehicle_type_id", "vehicle_type"),
  projectFkTo("collection_group", "vehicle_id", "vehicle"),
  projectFkTo("collection_group", "driver_id", "driver"),
  companyFk("collection_group_fraction"),
  projectFk("collection_group_fraction"),
  projectFkTo("collection_group_fraction", "collection_group_id", "collection_group"),
  tenantFk("collection_group_fraction", "waste_fraction_id", "waste_fraction"),
  companyFk("collection_group_container_type"),
  projectFk("collection_group_container_type"),
  projectFkTo("collection_group_container_type", "collection_group_id", "collection_group"),
  tenantFk("collection_group_container_type", "container_type_id", "container_type"),
  companyFk("collection_group_container"),
  projectFk("collection_group_container"),
  projectFkTo("collection_group_container", "collection_group_id", "collection_group"),
  projectFkTo("collection_group_container", "container_id", "container"),
  index("planning_area_boundary", "planning_area_boundary_project_id_idx", "company_id", "project_id"),
  index("planning_area_boundary", "planning_area_boundary_planning_area_id_idx", "company_id", "planning_area_id"),
  gistIndex("planning_area_boundary", "planning_area_boundary_boundary_idx", "boundary"),
  index("collection_calendar_holiday", "collection_calendar_holiday_project_id_idx", "company_id", "project_id"),
  index("route_scheme", "route_scheme_planning_area_id_idx", "company_id", "planning_area_id"),
  index("route_scheme", "route_scheme_depot_id_idx", "company_id", "depot_id"),
  index("route_scheme", "route_scheme_unloading_station_id_idx", "company_id", "unloading_station_id"),
  index("collection_group", "collection_group_service_provider_id_idx", "company_id", "service_provider_id"),
  index("collection_group", "collection_group_rule_vehicle_type_id_idx", "company_id", "rule_vehicle_type_id"),
  index("collection_group", "collection_group_vehicle_id_idx", "company_id", "vehicle_id"),
  index("collection_group", "collection_group_driver_id_idx", "company_id", "driver_id"),
  index("collection_group_fraction", "collection_group_fraction_project_id_idx", "company_id", "project_id"),
  index("collection_group_fraction", "collection_group_fraction_waste_fraction_id_idx", "company_id", "waste_fraction_id"),
  index("collection_group_container_type", "collection_group_container_type_project_id_idx", "company_id", "project_id"),
  index("collection_group_container_type", "collection_group_container_type_container_type_id_idx", "company_id", "container_type_id"),
  index("collection_group_container", "collection_group_container_project_id_idx", "company_id", "project_id"),
  index("collection_group_container", "collection_group_container_container_id_idx", "company_id", "container_id"),
]

/** What the nine tables owe their migration file, in the order migrations/README.md lays out: fence and trigger table by table, then the exclusion constraints. */
const handWritten = [
  ...Object.values(tables).flatMap((table) => [...tenantFence(table), ...touchUpdatedAt(table)]),
  ...excludeOverlapping(planningAreaBoundary, [planningAreaBoundary.planningAreaId]),
  ...excludeOverlapping(collectionCalendar, [collectionCalendar.projectId]),
  ...excludeOverlapping(routeScheme, [routeScheme.projectId, routeScheme.name]),
]

/** Everything drizzle-kit wrote at the head of 0006: the altered project and the nine tables, as they were generated as of 0006 — the two tables 0007 changed in their earlier spelling, and what 0007 added left out. */
const generatedHead = async (): Promise<string[]> => [
  ...(await statementsBetween({ project: projectAsOf0005 }, { project })),
  ...(await statementsFor(tables)).filter((statement) => !ADDED_IN_0007.includes(statement)).map((statement) => CHANGED_IN_0007.get(statement) ?? statement),
]

describe("the Planning tables as drizzle-kit writes them", () => {
  test("nine tables, every column, key, unique, check and index as the Domain model spells them, every name within 63 bytes", async () => {
    assert.deepEqual(await statementsFor(tables), expected)
  })

  test("the project gains its working week as two columns and a subset check, in ALTER TABLE statements", async () => {
    assert.deepEqual(await statementsBetween({ project: projectAsOf0005 }, { project }), projectAltered)
  })

  test("migration 0006 begins with exactly what drizzle-kit generated for the schema as of 0006: 54 statements", async () => {
    const statements = statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))
    // The same statements, whatever order drizzle-kit's loader gave the tables (it sorts a module's exports).
    const generated = (await generatedHead()).map(normalised).sort()
    assert.equal(generated.length, 54, "nine CREATE TABLE, two ADD COLUMN, twenty-nine foreign keys, twelve indexes, two checks on project")
    assert.deepEqual([...statements.slice(0, generated.length)].sort(), generated)
    // Every statement 0007 added is one the schema generates today, so the filter leaves nothing out by mistake.
    const today = await statementsFor(tables)
    for (const statement of ADDED_IN_0007) assert.ok(today.includes(statement), statement)
    for (const statement of CHANGED_IN_0007.keys()) assert.ok(today.includes(statement), statement.split("\n")[0])
  })

  test("and carries below them the fence and trigger of each table and the three exclusion constraints: 9 x 3 + 3 = 30 statements", async () => {
    const statements = statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))
    const generated = await generatedHead()
    const tail = statements.slice(generated.length)
    assert.equal(tail.length, 30, "nine tables, each two fence statements and one trigger, then one exclusion constraint per effective-dated table")
    assert.deepEqual(tail, handWritten.map(normalised))
  })
})

describe("the check helpers of this context", () => {
  test("subsetOf holds every element of an array to the list, as literals, named <table>_<column>_subset_of", () => {
    const specimen = wms.table("specimen_subset", { ...id, ...tenant, days: text().array().notNull() }, (t) => [subsetOf(t.days, ["monday", "it's tuesday"])])
    assert.deepEqual([...checksOf(specimen)], [["specimen_subset_days_subset_of", `"wms"."specimen_subset"."days" <@ ARRAY['monday', 'it''s tuesday']::text[]`]])
  })

  test("nonEmpty holds the array to at least one element, named <table>_<column>_non_empty", () => {
    const specimen = wms.table("specimen_non_empty", { ...id, ...tenant, days: text().array().notNull() }, (t) => [nonEmpty(t.days)])
    assert.deepEqual([...checksOf(specimen)], [["specimen_non_empty_days_non_empty", `cardinality("wms"."specimen_non_empty"."days") > 0`]])
  })

  test("subsetOf refuses an empty list, which would refuse every non-empty array and say nothing about why", () => {
    const empty = wms.table("specimen_subset_empty", { ...id, ...tenant, days: text().array() }, (t) => [subsetOf(t.days, [])])
    assert.throws(() => getTableConfig(empty), /subsetOf: "specimen_subset_empty"\."days" has no values to be a subset of/)
  })

  test("refuse a check name Postgres would truncate, at definition time", () => {
    const name = `specimen_check_${"o".repeat(40)}`
    const long = wms.table(name, { ...id, ...tenant, days: text().array() }, (t) => [subsetOf(t.days, DAYS)])
    assert.throws(() => getTableConfig(long), new RegExp(`subsetOf: "${name}_days_subset_of" is 70 bytes; Postgres would truncate it to 63 silently`))
    const longer = wms.table(`${name}_too`, { ...id, ...tenant, days: text().array() }, (t) => [nonEmpty(t.days)])
    assert.throws(() => getTableConfig(longer), new RegExp(`nonEmpty: "${name}_too_days_non_empty" is 74 bytes; Postgres would truncate it to 63 silently`))
  })

  test("an inline shape check renders its SQL without parameters, the way the two of this context do", () => {
    // The same spelling as route_scheme_week_rotation_shape, on a specimen: what the migration file says is what the table says.
    const specimen = wms.table("specimen_shape", { ...id, ...tenant, frequency: text().notNull(), weekRotation: text() }, (t) => [
      check(tableObjectName(t.id.table, "week_rotation_shape", "specimen"), sql`(${t.frequency} = 'every-2-weeks') = (${t.weekRotation} is not null)`),
    ])
    assert.deepEqual(
      [...checksOf(specimen)],
      [["specimen_shape_week_rotation_shape", `("wms"."specimen_shape"."frequency" = 'every-2-weeks') = ("wms"."specimen_shape"."week_rotation" is not null)`]],
    )
  })
})
