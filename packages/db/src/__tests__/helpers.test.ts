// The helpers every table is built from, by their text and their refusals,
// over specimen tables: the check helpers (checks.ts), the key helpers
// (references.ts), the ledger's and the reservation's column sets
// (columns.ts) and the retention purge's grant (sql/retention-purge.ts). And
// one rule of the whole schema: a check renders without parameters, since
// drizzle-kit writes a check's SQL into the migration file as text and a
// parameter would go in as `$1`. No database.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { getTableName } from "drizzle-orm"
import { getTableConfig, integer, PgDialect, text, uuid } from "drizzle-orm/pg-core"

import { CASING } from "../casing"
import { exactlyOne, lowercase, nonEmpty, oneOf, positive, subsetOf } from "../schema/checks"
import { id, orderedWindow, projectScoped, recorded, tenant, timestamps, window } from "../schema/columns"
import { proofOfService, route } from "../schema/execution"
import { companyReference, indexOn, projectKey, projectReference, tenantIndex, tenantKey, tenantReference, tenantUnique, uniqueOn } from "../schema/references"
import { wms } from "../schema/wms"
import { retentionPurge } from "../sql/retention-purge"
import { TABLES } from "../table-policies"
import { statementsFor } from "./specimen"

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const

// How drizzle-kit spells what these helpers make.
const ID = '"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL'
const COMPANY = '"company_id" uuid NOT NULL'
const ref = (table: string, column: string): string => `"wms"."${table}"."${column}"`
const columns = (...names: string[]): string => names.map((name) => `"${name}"`).join(",")
const foreignKey = (table: string, name: string, own: string[], target: string, foreign: string[]): string =>
  `ALTER TABLE "wms"."${table}" ADD CONSTRAINT "${name}" FOREIGN KEY (${columns(...own)}) REFERENCES "wms"."${target}"(${columns(...foreign)}) ON DELETE no action ON UPDATE no action;`
const index = (table: string, name: string, ...own: string[]): string => `CREATE INDEX "${name}" ON "wms"."${table}" USING btree (${columns(...own)});`

const dialect = new PgDialect({ casing: CASING })
/** The SQL of a table's checks by name, as drizzle-kit renders it into the migration. */
const checksOf = (table: Parameters<typeof getTableConfig>[0]): Map<string, string> => new Map(getTableConfig(table).checks.map((check) => [check.name, dialect.sqlToQuery(check.value).sql]))

describe("every check of the schema", () => {
  test("renders without parameters, the way every check in a migration must", () => {
    const carrying = TABLES.flatMap((table) => getTableConfig(table).checks.filter((check) => dialect.sqlToQuery(check.value).params.length > 0).map((check) => `${getTableName(table)}: ${check.name}`))
    assert.deepEqual(carrying, [])
  })
})

describe("the check helpers", () => {
  test("oneOf spells the values the column declares as literals, quotes doubled, named <table>_<column>_one_of", () => {
    const specimen = wms.table("specimen_one_of", { ...id, ...tenant, kind: text({ enum: ["plain", "it's"] }).notNull() }, (t) => [oneOf(t.kind)])
    assert.deepEqual([...checksOf(specimen)], [["specimen_one_of_kind_one_of", `"wms"."specimen_one_of"."kind" in ('plain', 'it''s')`]])
  })

  test("oneOf refuses a column that declares no values, which would be a syntax error in the migration and a row typed string", () => {
    const empty = wms.table("specimen_one_of_empty", { ...id, ...tenant, kind: text().notNull() }, (t) => [oneOf(t.kind)])
    assert.throws(() => getTableConfig(empty), /oneOf: "specimen_one_of_empty"\."kind" declares no values to be one of/)
  })

  test("a declared column reads out as its values and stays text in SQL", () => {
    const specimen = wms.table("specimen_one_of_type", { ...id, ...tenant, kind: text({ enum: ["plain", "fancy"] }).notNull() }, (t) => [oneOf(t.kind)])
    type Kind = (typeof specimen.$inferSelect)["kind"]
    const declared: Kind[] = ["plain", "fancy"]
    // @ts-expect-error a value the column does not declare is not one a row reads out
    const undeclared: Kind = "other"
    assert.deepEqual([...declared, undeclared], ["plain", "fancy", "other"])
    assert.equal(getTableConfig(specimen).columns.find((column) => column.name === "kind")?.getSQLType(), "text")
  })

  test("lowercase holds the column equal to its lower(), named <table>_<column>_lowercase", () => {
    const specimen = wms.table("specimen_lowercase", { ...id, ...tenant, email: text().notNull() }, (t) => [lowercase(t.email)])
    assert.deepEqual([...checksOf(specimen)], [["specimen_lowercase_email_lowercase", `"wms"."specimen_lowercase"."email" = lower("wms"."specimen_lowercase"."email")`]])
  })

  test("subsetOf holds every element of an array to the list, as literals, named <table>_<column>_subset_of", () => {
    const specimen = wms.table("specimen_subset", { ...id, ...tenant, days: text({ enum: ["monday", "it's tuesday"] }).array().notNull() }, (t) => [subsetOf(t.days)])
    assert.deepEqual([...checksOf(specimen)], [["specimen_subset_days_subset_of", `"wms"."specimen_subset"."days" <@ ARRAY['monday', 'it''s tuesday']::text[]`]])
  })

  test("nonEmpty holds the array to at least one element, named <table>_<column>_non_empty", () => {
    const specimen = wms.table("specimen_non_empty", { ...id, ...tenant, days: text().array().notNull() }, (t) => [nonEmpty(t.days)])
    assert.deepEqual([...checksOf(specimen)], [["specimen_non_empty_days_non_empty", `cardinality("wms"."specimen_non_empty"."days") > 0`]])
  })

  test("subsetOf refuses an array whose elements declare no values, which would refuse every non-empty array and say nothing about why", () => {
    const empty = wms.table("specimen_subset_empty", { ...id, ...tenant, days: text().array() }, (t) => [subsetOf(t.days)])
    assert.throws(() => getTableConfig(empty), /subsetOf: "specimen_subset_empty"\."days" declares no values to be a subset of/)
  })

  test("positive holds a count above zero, named <table>_<column>_positive", () => {
    const specimen = wms.table("specimen_positive", { ...id, ...tenant, volumeLitres: integer() }, (t) => [positive(t.volumeLitres)])
    assert.deepEqual([...checksOf(specimen)], [["specimen_positive_volume_litres_positive", `"wms"."specimen_positive"."volume_litres" > 0`]])
  })

  test("exactlyOne counts the columns that are set, named <table>_<label>_exactly_one", () => {
    const specimen = wms.table("specimen_exactly_one", { ...id, ...tenant, here: uuid(), there: uuid(), elsewhere: uuid() }, (t) => [
      exactlyOne(t, "place", [t.here, t.there, t.elsewhere]),
    ])
    const it = (column: string) => `"wms"."specimen_exactly_one"."${column}"`
    assert.deepEqual(
      [...checksOf(specimen)],
      [["specimen_exactly_one_place_exactly_one", `(${it("here")} is not null)::int + (${it("there")} is not null)::int + (${it("elsewhere")} is not null)::int = 1`]],
    )
  })

  test("exactlyOne refuses fewer than two columns, which would be a NOT NULL constraint", () => {
    const one = wms.table("specimen_exactly_one_alone", { ...id, ...tenant, here: uuid() }, (t) => [
      exactlyOne(t, "place", [t.here] as unknown as [typeof t.here, typeof t.here]),
    ])
    assert.throws(
      () => getTableConfig(one),
      /exactlyOne: "specimen_exactly_one_alone" names 1 column\(s\) for "place"; with fewer than two there is nothing to choose between, and one column that must be set is NOT NULL/,
    )
  })

  test("refuse a check name Postgres would truncate, at definition time", () => {
    const name = `specimen_check_${"o".repeat(40)}`
    const long = wms.table(name, { ...id, ...tenant, days: text({ enum: DAYS }).array() }, (t) => [subsetOf(t.days)])
    assert.throws(() => getTableConfig(long), new RegExp(`subsetOf: "${name}_days_subset_of" is 70 bytes; Postgres would truncate it to 63 silently`))
    const longer = wms.table(`${name}_too`, { ...id, ...tenant, days: text().array() }, (t) => [nonEmpty(t.days)])
    assert.throws(() => getTableConfig(longer), new RegExp(`nonEmpty: "${name}_too_days_non_empty" is 74 bytes; Postgres would truncate it to 63 silently`))
    const counted = wms.table(`${name}_n`, { ...id, ...tenant, quantity: integer() }, (t) => [positive(t.quantity)])
    assert.throws(() => getTableConfig(counted), new RegExp(`positive: "${name}_n_quantity_positive" is 75 bytes; Postgres would truncate it to 63 silently`))
  })
})

describe("the key helpers", () => {
  const target = wms.table("specimen_key_target", { ...id, ...tenant, ...timestamps, code: text().notNull() }, (t) => [tenantKey(t), tenantUnique(t, t.code)])

  test("name every object through names.ts, the tenant column left out of a key's name since every key of a tenant's table begins with it", async () => {
    const specimen = wms.table(
      "specimen_key",
      { ...id, ...tenant, ...timestamps, targetId: uuid().notNull(), otherId: uuid(), code: text().notNull(), extra: text().notNull() },
      (t) => [
        companyReference(t, target),
        tenantReference(t, [t.targetId], target),
        tenantReference(t, [t.otherId, t.code], target, [target.id, target.code]),
        uniqueOn(t.code, t.extra),
        tenantUnique(t, t.code),
        tenantKey(t),
        tenantIndex(t, t.otherId),
        indexOn(t.extra),
      ],
    )
    const statements = await statementsFor({ target, specimen })
    assert.match(statements[0], /CONSTRAINT "specimen_key_target_tenant_key" UNIQUE\("company_id","id"\),\n\tCONSTRAINT "specimen_key_target_code_key" UNIQUE\("company_id","code"\)/)
    assert.match(statements[1], /CONSTRAINT "specimen_key_code_extra_key" UNIQUE\("code","extra"\),\n\tCONSTRAINT "specimen_key_code_key" UNIQUE\("company_id","code"\),\n\tCONSTRAINT "specimen_key_tenant_key" UNIQUE\("company_id","id"\)/)
    assert.deepEqual(statements.slice(2), [
      foreignKey("specimen_key", "specimen_key_company_id_fk", ["company_id"], "specimen_key_target", ["id"]),
      foreignKey("specimen_key", "specimen_key_target_id_fk", ["company_id", "target_id"], "specimen_key_target", ["company_id", "id"]),
      foreignKey("specimen_key", "specimen_key_other_id_code_fk", ["company_id", "other_id", "code"], "specimen_key_target", ["company_id", "id", "code"]),
      index("specimen_key", "specimen_key_other_id_idx", "company_id", "other_id"),
      index("specimen_key", "specimen_key_extra_idx", "extra"),
    ])
  })

  test("tenantReference refuses a key without columns and one whose two sides differ in length", () => {
    const empty = wms.table("specimen_key_empty", { ...id, ...tenant }, (t) => [tenantReference(t, [], target)])
    assert.throws(() => getTableConfig(empty), /tenantReference: "specimen_key_empty" names no columns beside company_id/)
    const uneven = wms.table("specimen_key_uneven", { ...id, ...tenant, targetId: uuid().notNull() }, (t) => [tenantReference(t, [t.targetId], target, [target.id, target.code])])
    assert.throws(() => getTableConfig(uneven), /tenantReference: "specimen_key_uneven" names 1 column\(s\) for a key of 2 in "specimen_key_target"/)
  })

  test("refuse a name Postgres would truncate, at definition time", () => {
    const name = "specimen_with_a_table_name_that_goes_on_and_on"
    const long = wms.table(name, { ...id, ...tenant, aRatherLongColumnName: uuid().notNull() }, (t) => [tenantReference(t, [t.aRatherLongColumnName], target)])
    assert.throws(() => getTableConfig(long), new RegExp(`tenantReference: "${name}_a_rather_long_column_name_fk" is 75 bytes; Postgres would truncate it to 63 silently`))
    const longKey = wms.table(`${name}_too`, { ...id, ...tenant, aRatherLongColumnName: uuid().notNull() }, (t) => [tenantUnique(t, t.aRatherLongColumnName)])
    assert.throws(() => getTableConfig(longKey), /tenantUnique: ".*_a_rather_long_column_name_key" is 80 bytes/)
  })
})

describe("the project-scoped key helpers", () => {
  const target = wms.table("specimen_project_target", { ...id, ...projectScoped, ...timestamps, code: text().notNull() }, (t) => [projectKey(t)])

  test("projectKey is the unique (company_id, project_id, id) a projectReference points at, both named through names.ts", async () => {
    const specimen = wms.table("specimen_project", { ...id, ...projectScoped, ...timestamps, targetId: uuid().notNull() }, (t) => [
      projectReference(t, [t.targetId], target),
      projectKey(t),
    ])
    const statements = await statementsFor({ target, specimen })
    assert.match(statements[0], /CONSTRAINT "specimen_project_target_project_key" UNIQUE\("company_id","project_id","id"\)/)
    assert.match(statements[1], /CONSTRAINT "specimen_project_project_key" UNIQUE\("company_id","project_id","id"\)/)
    assert.deepEqual(statements.slice(2), [
      foreignKey("specimen_project", "specimen_project_target_id_fk", ["company_id", "project_id", "target_id"], "specimen_project_target", ["company_id", "project_id", "id"]),
    ])
  })

  test("projectReference refuses a key without columns", () => {
    const empty = wms.table("specimen_project_empty", { ...id, ...projectScoped }, (t) => [projectReference(t, [], target)])
    assert.throws(() => getTableConfig(empty), /projectReference: "specimen_project_empty" names no columns beside company_id and project_id/)
  })

  test("a reference through another column points at the target's own columns, and a key through another column is of the table's own — a column of another table is refused by name", () => {
    const through = wms.table("specimen_project_through", { ...id, ...projectScoped, ...timestamps, ownerId: uuid().notNull(), code: text().notNull() }, (t) => [projectKey(t, t.ownerId)])
    const elsewhere = wms.table("specimen_project_elsewhere", { ...id, ...projectScoped, ownerId: uuid().notNull() })
    const sound = wms.table("specimen_project_via", { ...id, ...projectScoped, ownerId: uuid().notNull(), throughId: uuid() }, (t) => [
      projectReference(t, [t.ownerId, t.throughId], through, [through.ownerId, through.id]),
    ])
    assert.deepEqual(getTableConfig(sound).foreignKeys.length, 1)
    assert.match(getTableConfig(through).uniqueConstraints[0].name ?? "", /^specimen_project_through_owner_id_project_key$/)
    const astray = wms.table("specimen_project_astray", { ...id, ...projectScoped, ownerId: uuid().notNull(), throughId: uuid() }, (t) => [
      projectReference(t, [t.ownerId, t.throughId], through, [elsewhere.ownerId, through.id]),
    ])
    assert.throws(() => getTableConfig(astray), /projectReference: column "owner_id" is not a column of "specimen_project_through", the table the key points at/)
    const short = wms.table("specimen_project_short", { ...id, ...projectScoped, ownerId: uuid().notNull() }, (t) => [projectReference(t, [t.ownerId], through, [through.ownerId, through.id])])
    assert.throws(() => getTableConfig(short), /projectReference: "specimen_project_short" names 1 column\(s\) for a key of 2 in "specimen_project_through"/)
    const foreignKey = wms.table("specimen_project_foreign_key", { ...id, ...projectScoped, ...timestamps }, (t) => [projectKey(t, elsewhere.ownerId)])
    assert.throws(() => getTableConfig(foreignKey), /projectKey: column "owner_id" is not a column of "specimen_project_foreign_key"/)
  })

  test("refuse a name Postgres would truncate, at definition time", () => {
    const name = `specimen_project_key_${"o".repeat(31)}`
    const long = wms.table(name, { ...id, ...projectScoped }, (t) => [projectKey(t)])
    assert.throws(() => getTableConfig(long), new RegExp(`projectKey: "${name}_project_key" is 64 bytes; Postgres would truncate it to 63 silently`))
    const referring = wms.table(`${name}_too`, { ...id, ...projectScoped, aRatherLongColumnName: uuid().notNull() }, (t) => [
      projectReference(t, [t.aRatherLongColumnName], target),
    ])
    assert.throws(() => getTableConfig(referring), /projectReference: ".*_a_rather_long_column_name_fk" is 85 bytes/)
  })
})

describe("the ledger's and the reservation's column sets", () => {
  test("recorded is the one stamp of a ledger, window two given instants, as drizzle-kit writes them", async () => {
    const specimen = wms.table("specimen_recorded_window", { ...id, ...tenant, ...recorded, ...window }, (t) => [orderedWindow(t)])
    const [statement] = await statementsFor({ specimen })
    assert.equal(
      statement,
      [
        'CREATE TABLE "wms"."specimen_recorded_window" (',
        `\t${ID},`,
        `\t${COMPANY},`,
        '\t"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,',
        '\t"planned_from" timestamp with time zone NOT NULL,',
        '\t"planned_to" timestamp with time zone NOT NULL,',
        `\tCONSTRAINT "specimen_recorded_window_window" CHECK (${ref("specimen_recorded_window", "planned_to")} > ${ref("specimen_recorded_window", "planned_from")})`,
        ");",
        "",
      ].join("\n"),
    )
    assert.deepEqual(Object.keys(recorded), ["recordedAt"])
    assert.deepEqual(Object.keys(window), ["plannedFrom", "plannedTo"])
  })

  test("orderedWindow refuses a name Postgres would truncate", () => {
    const long = wms.table(`specimen_${"o".repeat(50)}`, { ...window }, (columns) => [orderedWindow(columns)])
    assert.throws(() => getTableConfig(long), /orderedWindow: "specimen_o{50}_window" is 66 bytes; Postgres would truncate it to 63 silently/)
  })
})

describe("retentionPurge", () => {
  test("grants the worker DELETE on a ledger, and refuses a current-state table, which spreads `timestamps`", () => {
    assert.deepEqual(retentionPurge(proofOfService), ['GRANT DELETE ON "wms"."proof_of_service" TO wms_worker;'])
    assert.throws(() => retentionPurge(route), /has no recorded_at/)
  })
})
