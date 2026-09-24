// The Organisation & Access tables (Issue #70, slice 1) as drizzle-kit writes
// them: the eight CREATE TABLE statements with their keys, uniques and checks,
// the composite foreign keys, the partial index on the primary administrator
// and, since migration 0005, the e-mail index the hook's first sign-in reads
// (#75); then migration 0002, which has to begin with exactly the statements
// generated as of 0002, so the file and `pnpm db:generate` cannot drift apart,
// and to carry the token hook with its grants below them; then 0005, which
// begins with the index and replaces the hook below it (#76). The key and
// check helpers by their text and their refusals. No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { getTableConfig, PgDialect, text, uuid } from "drizzle-orm/pg-core"

import { CASING } from "../casing"
import { MIGRATIONS_FOLDER } from "../migrate"
import { projectAccess, role, roleGrant, serviceProviderAccess, userAccount } from "../schema/access"
import { lowercase, oneOf } from "../schema/checks"
import { id, tenant, timestamps } from "../schema/columns"
import { company, project, serviceProvider } from "../schema/organisation"
import { companyReference, indexOn, tenantIndex, tenantKey, tenantReference, tenantUnique, uniqueOn } from "../schema/references"
import { wms } from "../schema/wms"
import { normalised, statementsOf } from "../sql/hand-written"
import { statementsFor } from "./specimen"

/** The eight tables in the order the Domain model lists them; drizzle-kit's own loader sorts a module's exports, which the migration test allows for. */
const tables = { company, project, serviceProvider, role, userAccount, roleGrant, projectAccess, serviceProviderAccess }

const MIGRATION = "0002_organisation_access.sql"
const LATER_MIGRATION = "0005_hook_email.sql"
const HOOK = "public.custom_access_token_hook"

/** The column sets every table begins with. */
const SETS = [
  '\t"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL,',
  '\t"company_id" uuid NOT NULL,',
  '\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,',
  '\t"updated_at" timestamp with time zone DEFAULT now() NOT NULL,',
]
const createTable = (name: string, lines: string[]): string => [`CREATE TABLE "wms"."${name}" (`, ...SETS, ...lines, ");", ""].join("\n")
const ref = (table: string, column: string): string => `"wms"."${table}"."${column}"`
const columns = (...names: string[]): string => names.map((name) => `"${name}"`).join(",")
const foreignKey = (table: string, name: string, own: string[], target: string, foreign: string[]): string =>
  `ALTER TABLE "wms"."${table}" ADD CONSTRAINT "${name}" FOREIGN KEY (${columns(...own)}) REFERENCES "wms"."${target}"(${columns(...foreign)}) ON DELETE no action ON UPDATE no action;`
const index = (table: string, name: string, ...own: string[]): string => `CREATE INDEX "${name}" ON "wms"."${table}" USING btree (${columns(...own)});`

/** What 0005 added to the schema after 0002 had been applied: 0002 begins with the generated statements less these, 0005 with exactly these. */
const ADDED_IN_0005 = [index("user_account", "user_account_email_idx", "email")]

const STATUS = "in ('active', 'onboarding')"

const expected = [
  createTable("company", [
    '\t"name" text NOT NULL,',
    '\t"legal_name" text NOT NULL,',
    '\t"registration_number" text NOT NULL,',
    '\t"country" text NOT NULL,',
    '\t"status" text NOT NULL,',
    '\tCONSTRAINT "company_country_registration_number_key" UNIQUE("country","registration_number"),',
    `\tCONSTRAINT "company_self" CHECK (${ref("company", "company_id")} = ${ref("company", "id")}),`,
    `\tCONSTRAINT "company_status_one_of" CHECK (${ref("company", "status")} ${STATUS})`,
  ]),
  createTable("project", [
    '\t"name" text NOT NULL,',
    '\t"kind" text NOT NULL,',
    '\t"language" text NOT NULL,',
    '\t"currency" text NOT NULL,',
    '\t"timezone" text NOT NULL,',
    '\t"status" text NOT NULL,',
    '\tCONSTRAINT "project_name_key" UNIQUE("company_id","name"),',
    '\tCONSTRAINT "project_tenant_key" UNIQUE("company_id","id"),',
    `\tCONSTRAINT "project_status_one_of" CHECK (${ref("project", "status")} ${STATUS})`,
  ]),
  createTable("service_provider", [
    '\t"legal_name" text NOT NULL,',
    '\t"registration_number" text NOT NULL,',
    '\t"country" text NOT NULL,',
    '\t"contact_name" text NOT NULL,',
    '\t"contact_email" text NOT NULL,',
    '\tCONSTRAINT "service_provider_country_registration_number_key" UNIQUE("company_id","country","registration_number"),',
    '\tCONSTRAINT "service_provider_tenant_key" UNIQUE("company_id","id")',
  ]),
  createTable("role", [
    '\t"key" text,',
    '\t"name" text NOT NULL,',
    '\t"scope" text NOT NULL,',
    '\t"description" text NOT NULL,',
    '\t"system" boolean NOT NULL,',
    '\tCONSTRAINT "role_key_key" UNIQUE("company_id","key"),',
    '\tCONSTRAINT "role_name_key" UNIQUE("company_id","name"),',
    '\tCONSTRAINT "role_tenant_key" UNIQUE("company_id","id")',
  ]),
  createTable("user_account", [
    '\t"auth_user_id" uuid,',
    '\t"email" text NOT NULL,',
    '\t"full_name" text NOT NULL,',
    '\t"role_id" uuid NOT NULL,',
    '\t"all_projects" boolean DEFAULT false NOT NULL,',
    '\t"service_provider_id" uuid,',
    '\t"primary_administrator" boolean DEFAULT false NOT NULL,',
    '\t"deactivated_at" timestamp with time zone,',
    '\tCONSTRAINT "user_account_auth_user_id_key" UNIQUE("auth_user_id"),',
    '\tCONSTRAINT "user_account_email_key" UNIQUE("company_id","email"),',
    '\tCONSTRAINT "user_account_tenant_key" UNIQUE("company_id","id"),',
    '\tCONSTRAINT "user_account_id_service_provider_id_key" UNIQUE("company_id","id","service_provider_id"),',
    `\tCONSTRAINT "user_account_email_lowercase" CHECK (${ref("user_account", "email")} = lower(${ref("user_account", "email")}))`,
  ]),
  createTable("role_grant", [
    '\t"role_id" uuid NOT NULL,',
    '\t"module_key" text NOT NULL,',
    '\t"action" text NOT NULL,',
    '\tCONSTRAINT "role_grant_role_id_module_key_action_key" UNIQUE("company_id","role_id","module_key","action")',
  ]),
  createTable("project_access", [
    '\t"user_account_id" uuid NOT NULL,',
    '\t"project_id" uuid NOT NULL,',
    '\tCONSTRAINT "project_access_user_account_id_project_id_key" UNIQUE("company_id","user_account_id","project_id")',
  ]),
  createTable("service_provider_access", [
    '\t"user_account_id" uuid NOT NULL,',
    '\t"service_provider_id" uuid NOT NULL,',
    '\tCONSTRAINT "service_provider_access_user_account_id_service_provider_id_key" UNIQUE("company_id","user_account_id","service_provider_id")',
  ]),
  foreignKey("project", "project_company_id_fk", ["company_id"], "company", ["id"]),
  foreignKey("service_provider", "service_provider_company_id_fk", ["company_id"], "company", ["id"]),
  foreignKey("role", "role_company_id_fk", ["company_id"], "company", ["id"]),
  foreignKey("user_account", "user_account_role_id_fk", ["company_id", "role_id"], "role", ["company_id", "id"]),
  foreignKey("user_account", "user_account_service_provider_id_fk", ["company_id", "service_provider_id"], "service_provider", ["company_id", "id"]),
  foreignKey("role_grant", "role_grant_role_id_fk", ["company_id", "role_id"], "role", ["company_id", "id"]),
  foreignKey("project_access", "project_access_user_account_id_fk", ["company_id", "user_account_id"], "user_account", ["company_id", "id"]),
  foreignKey("project_access", "project_access_project_id_fk", ["company_id", "project_id"], "project", ["company_id", "id"]),
  foreignKey(
    "service_provider_access",
    "service_provider_access_user_account_id_service_provider_id_fk",
    ["company_id", "user_account_id", "service_provider_id"],
    "user_account",
    ["company_id", "id", "service_provider_id"],
  ),
  ...ADDED_IN_0005,
  `CREATE UNIQUE INDEX "user_account_primary_administrator_idx" ON "wms"."user_account" USING btree ("company_id") WHERE ${ref("user_account", "primary_administrator")};`,
  index("user_account", "user_account_role_id_idx", "company_id", "role_id"),
  index("user_account", "user_account_service_provider_id_idx", "company_id", "service_provider_id"),
  index("project_access", "project_access_project_id_idx", "company_id", "project_id"),
]

describe("the Organisation & Access tables as drizzle-kit writes them", () => {
  test("eight tables, every column, key, unique, check and index as the Domain model spells them, every name within 63 bytes", async () => {
    assert.deepEqual(await statementsFor(tables), expected)
  })

  test("migration 0002 begins with exactly what drizzle-kit generated for the schema as of 0002, and carries the hook and its grants below", async () => {
    const statements = statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))
    // The same statements, whatever order drizzle-kit's loader gave the tables
    // (it sorts a module's exports), less what a later file added: an applied
    // file is never edited.
    const generated = (await statementsFor(tables))
      .filter((statement) => !ADDED_IN_0005.includes(statement))
      .map(normalised)
      .sort()
    assert.deepEqual([...statements.slice(0, generated.length)].sort(), generated)
    const handWritten = statements.slice(generated.length)
    assert.ok(handWritten.length > 0, "the hand-written statements follow the generated ones")
    assert.equal(handWritten.filter((statement) => statement.startsWith(`CREATE OR REPLACE FUNCTION ${HOOK}(event jsonb) RETURNS jsonb`)).length, 1)
    assert.ok(handWritten.includes(`GRANT EXECUTE ON FUNCTION ${HOOK}(jsonb) TO supabase_auth_admin;`))
    assert.ok(handWritten.includes(`REVOKE EXECUTE ON FUNCTION ${HOOK}(jsonb) FROM PUBLIC, anon, authenticated;`))
  })

  test("migration 0005 begins with exactly the e-mail index and replaces the hook below it, nothing else: privileges survive CREATE OR REPLACE, so 0002's grant and 0003's revoke stand", async () => {
    const statements = statementsOf(await readFile(join(MIGRATIONS_FOLDER, LATER_MIGRATION), "utf8"))
    assert.deepEqual(statements.slice(0, ADDED_IN_0005.length), ADDED_IN_0005.map(normalised))
    const handWritten = statements.slice(ADDED_IN_0005.length)
    assert.equal(handWritten.length, 1, handWritten.join("\n"))
    assert.ok(handWritten[0].startsWith(`CREATE OR REPLACE FUNCTION ${HOOK}(event jsonb) RETURNS jsonb`), handWritten[0])
  })
})

const dialect = new PgDialect({ casing: CASING })
/** The SQL of a table's checks by name, as drizzle-kit renders it into the migration: no parameters, or the file would say `$1`. */
const checksOf = (table: Parameters<typeof getTableConfig>[0]): Map<string, string> =>
  new Map(
    getTableConfig(table).checks.map((check) => {
      const query = dialect.sqlToQuery(check.value)
      assert.deepEqual(query.params, [], `${check.name} carries a parameter, which the migration file cannot`)
      return [check.name, query.sql]
    }),
  )

describe("the check helpers", () => {
  test("oneOf spells the listed values as literals, quotes doubled, named <table>_<column>_one_of", () => {
    const specimen = wms.table("specimen_one_of", { ...id, ...tenant, kind: text().notNull() }, (t) => [oneOf(t.kind, ["plain", "it's"])])
    assert.deepEqual([...checksOf(specimen)], [["specimen_one_of_kind_one_of", `"wms"."specimen_one_of"."kind" in ('plain', 'it''s')`]])
  })

  test("oneOf refuses an empty list, which would be a syntax error in the migration", () => {
    const empty = wms.table("specimen_one_of_empty", { ...id, ...tenant, kind: text().notNull() }, (t) => [oneOf(t.kind, [])])
    assert.throws(() => getTableConfig(empty), /oneOf: "specimen_one_of_empty"\."kind" has no values to be one of/)
  })

  test("lowercase holds the column equal to its lower(), named <table>_<column>_lowercase", () => {
    const specimen = wms.table("specimen_lowercase", { ...id, ...tenant, email: text().notNull() }, (t) => [lowercase(t.email)])
    assert.deepEqual([...checksOf(specimen)], [["specimen_lowercase_email_lowercase", `"wms"."specimen_lowercase"."email" = lower("wms"."specimen_lowercase"."email")`]])
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
