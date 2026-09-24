// The Registry tables (Issue #78, slice 1) as drizzle-kit writes them: the
// fifteen CREATE TABLE statements with their columns, keys, uniques and
// checks, the generated location column, the composite and project-scoped
// foreign keys, the two partial unique indexes; then migration 0004, which has
// to begin with exactly those statements, so the file and `pnpm db:generate`
// cannot drift apart, and to carry below them what the helpers write for each
// table and the three exclusion constraints. The two new key helpers and the
// two new check helpers by their text and their refusals. No database.
//
// This is also what makes a change to the vocabulary a migration: the values
// are spelled here as the file spells them, so adding one to a list in
// @waste/domain/registry/vocabulary fails this test until a migration replaces
// the check.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { getTableConfig, integer, PgDialect, text, uuid } from "drizzle-orm/pg-core"

import { CASING } from "../casing"
import { MIGRATIONS_FOLDER } from "../migrate"
import { agreement, subscription } from "../schema/agreements"
import { containerType, product, serviceFrequency, wasteFraction } from "../schema/catalogue"
import { exactlyOne, positive } from "../schema/checks"
import { id, projectScoped, tenant, timestamps } from "../schema/columns"
import { container, containerServicePlacement } from "../schema/containers"
import { customer, property, propertyGroup, propertyGroupMember, propertyParty, sharedCollectionPoint, sharedCollectionPointMember } from "../schema/customers"
import { projectKey, projectReference } from "../schema/references"
import { wms } from "../schema/wms"
import { excludeOverlapping } from "../sql/exclude-overlapping"
import { normalised, statementsOf } from "../sql/hand-written"
import { tenantFence } from "../sql/tenant-fence"
import { touchUpdatedAt } from "../sql/touch-updated-at"
import { statementsFor } from "./specimen"

/** The fifteen tables in the order src/schema/index.ts exports them; drizzle-kit's own loader sorts a module's exports, which the migration test allows for. */
const tables = {
  wasteFraction,
  containerType,
  serviceFrequency,
  product,
  customer,
  property,
  propertyParty,
  propertyGroup,
  propertyGroupMember,
  sharedCollectionPoint,
  sharedCollectionPointMember,
  agreement,
  subscription,
  container,
  containerServicePlacement,
}

const MIGRATION = "0004_registry.sql"

const ID = '"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL'
const COMPANY = '"company_id" uuid NOT NULL'
const PROJECT = '"project_id" uuid NOT NULL'
const STAMPS = ['"created_at" timestamp with time zone DEFAULT now() NOT NULL', '"updated_at" timestamp with time zone DEFAULT now() NOT NULL']
const VALIDITY = ['"valid_from" date NOT NULL', '"valid_to" date']
/** The column sets a table of this context begins with, by the sets it spreads. */
const SETS = {
  tenant: [ID, COMPANY, ...STAMPS],
  project: [ID, COMPANY, PROJECT, ...STAMPS],
  dated: [ID, COMPANY, PROJECT, ...STAMPS, ...VALIDITY],
}

/** One CREATE TABLE as drizzle-kit writes it: the sets, then the table's own lines, one per tab-indented line and the last without a comma. */
const createTable = (name: string, sets: keyof typeof SETS, lines: string[]): string =>
  [`CREATE TABLE "wms"."${name}" (`, [...SETS[sets], ...lines].map((line) => `\t${line}`).join(",\n"), ");", ""].join("\n")

const ref = (table: string, column: string): string => `"wms"."${table}"."${column}"`
const columns = (...names: string[]): string => names.map((name) => `"${name}"`).join(",")
const foreignKey = (table: string, name: string, own: string[], target: string, foreign: string[]): string =>
  `ALTER TABLE "wms"."${table}" ADD CONSTRAINT "${name}" FOREIGN KEY (${columns(...own)}) REFERENCES "wms"."${target}"(${columns(...foreign)}) ON DELETE no action ON UPDATE no action;`
const index = (table: string, name: string, ...own: string[]): string => `CREATE INDEX "${name}" ON "wms"."${table}" USING btree (${columns(...own)});`
/** The tenant's plain key and the project-scoped one, which every project-scoped table here carries. */
const companyFk = (table: string): string => foreignKey(table, `${table}_company_id_fk`, ["company_id"], "company", ["id"])
const projectFk = (table: string): string => foreignKey(table, `${table}_project_id_fk`, ["company_id", "project_id"], "project", ["company_id", "id"])
const tenantFk = (table: string, column: string, target: string): string =>
  foreignKey(table, `${table}_${column}_fk`, ["company_id", column], target, ["company_id", "id"])
const projectFkTo = (table: string, column: string, target: string): string =>
  foreignKey(table, `${table}_${column}_fk`, ["company_id", "project_id", column], target, ["company_id", "project_id", "id"])

const uniqueKey = (name: string, ...own: string[]): string => `CONSTRAINT "${name}" UNIQUE(${columns(...own)})`
const oneOfCheck = (table: string, column: string, ...values: string[]): string =>
  `CONSTRAINT "${table}_${column}_one_of" CHECK (${ref(table, column)} in (${values.map((value) => `'${value}'`).join(", ")}))`
const positiveCheck = (table: string, column: string): string => `CONSTRAINT "${table}_${column}_positive" CHECK (${ref(table, column)} > 0)`
const lowercaseCheck = (table: string, column: string): string =>
  `CONSTRAINT "${table}_${column}_lowercase" CHECK (${ref(table, column)} = lower(${ref(table, column)}))`
const validityCheck = (table: string): string =>
  `CONSTRAINT "${table}_validity" CHECK (${ref(table, "valid_to")} is null or ${ref(table, "valid_to")} > ${ref(table, "valid_from")})`
const geometryCheck = (table: string, column: string): string => {
  const it = ref(table, column)
  return `CONSTRAINT "${table}_${column}_valid" CHECK (extensions.st_isvalid(${it}) and not extensions.st_isempty(${it}) and extensions.st_xmin(${it}) >= -180 and extensions.st_xmax(${it}) <= 180 and extensions.st_ymin(${it}) >= -90 and extensions.st_ymax(${it}) <= 90)`
}
const partialUniqueIndex = (table: string, name: string, own: string[], where: string): string =>
  `CREATE UNIQUE INDEX "${name}" ON "wms"."${table}" USING btree (${columns(...own)}) WHERE ${where};`

const expected = [
  createTable("waste_fraction", "tenant", [
    '"key" text NOT NULL',
    '"name" text NOT NULL',
    uniqueKey("waste_fraction_key_key", "company_id", "key"),
    uniqueKey("waste_fraction_name_key", "company_id", "name"),
    uniqueKey("waste_fraction_tenant_key", "company_id", "id"),
    lowercaseCheck("waste_fraction", "key"),
  ]),
  createTable("container_type", "tenant", [
    '"name" text NOT NULL',
    '"volume_litres" integer',
    uniqueKey("container_type_name_key", "company_id", "name"),
    uniqueKey("container_type_tenant_key", "company_id", "id"),
    positiveCheck("container_type", "volume_litres"),
  ]),
  createTable("service_frequency", "project", [
    '"name" text NOT NULL',
    '"description" text',
    '"collections_per_week" integer',
    '"weeks_between" integer',
    '"days_between" integer',
    uniqueKey("service_frequency_project_id_name_key", "company_id", "project_id", "name"),
    uniqueKey("service_frequency_project_key", "company_id", "project_id", "id"),
    positiveCheck("service_frequency", "collections_per_week"),
    positiveCheck("service_frequency", "weeks_between"),
    positiveCheck("service_frequency", "days_between"),
    `CONSTRAINT "service_frequency_shape" CHECK ((${ref("service_frequency", "collections_per_week")} is not null or (${ref("service_frequency", "weeks_between")} is null and ${ref("service_frequency", "days_between")} is null)) and (${ref("service_frequency", "weeks_between")} is null or ${ref("service_frequency", "days_between")} is null))`,
  ]),
  createTable("product", "project", [
    '"name" text NOT NULL',
    '"kind" text NOT NULL',
    '"status" text NOT NULL',
    '"unit" text NOT NULL',
    '"container_type_id" uuid',
    '"waste_fraction_id" uuid',
    '"service_frequency_id" uuid',
    uniqueKey("product_project_id_name_key", "company_id", "project_id", "name"),
    uniqueKey("product_project_key", "company_id", "project_id", "id"),
    oneOfCheck("product", "kind", "container-collection", "recurring-service", "additional-service"),
    oneOfCheck("product", "status", "draft", "active", "inactive"),
    oneOfCheck("product", "unit", "pickup", "month", "job"),
  ]),
  createTable("customer", "tenant", [
    '"kind" text NOT NULL',
    '"name" text NOT NULL',
    '"registration_number" text',
    '"email" text',
    '"phone" text',
    '"billing_address" text',
    '"service_messages_allowed" boolean DEFAULT true NOT NULL',
    '"status" text NOT NULL',
    uniqueKey("customer_tenant_key", "company_id", "id"),
    oneOfCheck("customer", "kind", "person", "organisation"),
    oneOfCheck("customer", "status", "active", "inactive"),
    lowercaseCheck("customer", "email"),
  ]),
  createTable("property", "project", [
    '"name" text NOT NULL',
    '"address" text NOT NULL',
    '"registry_id" text',
    '"kind" text NOT NULL',
    '"location" geometry(Point, 4326)',
    '"notes" text',
    '"status" text NOT NULL',
    uniqueKey("property_project_id_name_key", "company_id", "project_id", "name"),
    uniqueKey("property_project_key", "company_id", "project_id", "id"),
    oneOfCheck("property", "kind", "residential", "commercial", "public", "mixed", "other"),
    oneOfCheck("property", "status", "active", "inactive"),
    geometryCheck("property", "location"),
  ]),
  createTable("property_party", "project", [
    '"property_id" uuid NOT NULL',
    '"customer_id" uuid NOT NULL',
    '"role" text NOT NULL',
    uniqueKey("property_party_property_id_customer_id_role_key", "company_id", "property_id", "customer_id", "role"),
    oneOfCheck("property_party", "role", "owner", "payer", "tenant", "administrator", "service-contact"),
  ]),
  createTable("property_group", "project", [
    '"name" text NOT NULL',
    '"purpose" text NOT NULL',
    '"responsible_customer_id" uuid',
    '"status" text NOT NULL',
    uniqueKey("property_group_project_id_name_key", "company_id", "project_id", "name"),
    uniqueKey("property_group_project_key", "company_id", "project_id", "id"),
    oneOfCheck("property_group", "purpose", "administration", "reporting", "service", "agreement"),
    oneOfCheck("property_group", "status", "draft", "active", "inactive"),
  ]),
  createTable("property_group_member", "project", [
    '"property_group_id" uuid NOT NULL',
    '"property_id" uuid NOT NULL',
    '"role" text NOT NULL',
    uniqueKey("property_group_member_property_group_id_property_id_key", "company_id", "property_group_id", "property_id"),
    oneOfCheck("property_group_member", "role", "member", "administrator", "payer", "reporting"),
  ]),
  createTable("shared_collection_point", "project", [
    '"name" text NOT NULL',
    '"kind" text NOT NULL',
    '"address" text NOT NULL',
    '"location" geometry(Point, 4326) NOT NULL',
    '"eligibility_distance_m" integer',
    '"operating_model" text NOT NULL',
    '"access_mode" text NOT NULL',
    '"access_conditions" text',
    '"availability" text',
    '"billing_mode" text NOT NULL',
    '"responsible_customer_id" uuid',
    '"status" text NOT NULL',
    uniqueKey("shared_collection_point_project_id_name_key", "company_id", "project_id", "name"),
    uniqueKey("shared_collection_point_project_key", "company_id", "project_id", "id"),
    geometryCheck("shared_collection_point", "location"),
    positiveCheck("shared_collection_point", "eligibility_distance_m"),
    oneOfCheck("shared_collection_point", "kind", "surface", "underground", "recycling-station", "commercial", "other"),
    oneOfCheck("shared_collection_point", "operating_model", "municipal", "member-funded", "company-operated", "service-provider-operated"),
    oneOfCheck("shared_collection_point", "access_mode", "open", "member", "credential", "restricted"),
    oneOfCheck("shared_collection_point", "billing_mode", "municipal", "single-payer", "member-share", "usage"),
    oneOfCheck("shared_collection_point", "status", "draft", "open", "restricted", "closed"),
  ]),
  createTable("shared_collection_point_member", "project", [
    '"shared_collection_point_id" uuid NOT NULL',
    '"property_id" uuid NOT NULL',
    '"role" text NOT NULL',
    uniqueKey("shared_collection_point_member_membership_key", "company_id", "shared_collection_point_id", "property_id"),
    oneOfCheck("shared_collection_point_member", "role", "service-member", "administrator", "payer", "notification-contact"),
  ]),
  createTable("agreement", "dated", [
    '"number" text NOT NULL',
    '"customer_id" uuid NOT NULL',
    '"payer_customer_id" uuid NOT NULL',
    '"status" text NOT NULL',
    '"billing_cadence" text NOT NULL',
    '"currency" text NOT NULL',
    '"notes" text',
    uniqueKey("agreement_project_key", "company_id", "project_id", "id"),
    validityCheck("agreement"),
    oneOfCheck("agreement", "status", "draft", "active", "cancelled"),
    oneOfCheck("agreement", "billing_cadence", "monthly", "quarterly", "annual", "manual"),
  ]),
  createTable("subscription", "dated", [
    '"agreement_id" uuid NOT NULL',
    '"product_id" uuid NOT NULL',
    '"property_id" uuid',
    '"shared_collection_point_id" uuid',
    '"location_id" uuid GENERATED ALWAYS AS (coalesce("property_id", "shared_collection_point_id")) STORED NOT NULL',
    '"quantity" integer DEFAULT 1 NOT NULL',
    uniqueKey("subscription_project_key", "company_id", "project_id", "id"),
    validityCheck("subscription"),
    `CONSTRAINT "subscription_location_exactly_one" CHECK ((${ref("subscription", "property_id")} is not null)::int + (${ref("subscription", "shared_collection_point_id")} is not null)::int = 1)`,
    positiveCheck("subscription", "quantity"),
  ]),
  createTable("container", "project", [
    '"label" text NOT NULL',
    '"container_type_id" uuid NOT NULL',
    '"barcode" text',
    '"rfid" text',
    '"serial_number" text',
    '"ownership" text NOT NULL',
    '"notes" text',
    uniqueKey("container_label_key", "company_id", "label"),
    uniqueKey("container_project_key", "company_id", "project_id", "id"),
    oneOfCheck("container", "ownership", "company", "customer", "unrecorded"),
  ]),
  createTable("container_service_placement", "dated", [
    '"container_id" uuid NOT NULL',
    '"subscription_id" uuid NOT NULL',
    '"waste_fraction_id" uuid NOT NULL',
    '"service_frequency_id" uuid',
    validityCheck("container_service_placement"),
  ]),
  companyFk("waste_fraction"),
  companyFk("container_type"),
  companyFk("service_frequency"),
  projectFk("service_frequency"),
  companyFk("product"),
  projectFk("product"),
  tenantFk("product", "container_type_id", "container_type"),
  tenantFk("product", "waste_fraction_id", "waste_fraction"),
  projectFkTo("product", "service_frequency_id", "service_frequency"),
  companyFk("customer"),
  companyFk("property"),
  projectFk("property"),
  companyFk("property_party"),
  projectFk("property_party"),
  projectFkTo("property_party", "property_id", "property"),
  tenantFk("property_party", "customer_id", "customer"),
  companyFk("property_group"),
  projectFk("property_group"),
  tenantFk("property_group", "responsible_customer_id", "customer"),
  companyFk("property_group_member"),
  projectFk("property_group_member"),
  projectFkTo("property_group_member", "property_group_id", "property_group"),
  projectFkTo("property_group_member", "property_id", "property"),
  companyFk("shared_collection_point"),
  projectFk("shared_collection_point"),
  tenantFk("shared_collection_point", "responsible_customer_id", "customer"),
  companyFk("shared_collection_point_member"),
  projectFk("shared_collection_point_member"),
  projectFkTo("shared_collection_point_member", "shared_collection_point_id", "shared_collection_point"),
  projectFkTo("shared_collection_point_member", "property_id", "property"),
  companyFk("agreement"),
  projectFk("agreement"),
  tenantFk("agreement", "customer_id", "customer"),
  tenantFk("agreement", "payer_customer_id", "customer"),
  companyFk("subscription"),
  projectFk("subscription"),
  projectFkTo("subscription", "agreement_id", "agreement"),
  projectFkTo("subscription", "product_id", "product"),
  projectFkTo("subscription", "property_id", "property"),
  projectFkTo("subscription", "shared_collection_point_id", "shared_collection_point"),
  companyFk("container"),
  projectFk("container"),
  tenantFk("container", "container_type_id", "container_type"),
  companyFk("container_service_placement"),
  projectFk("container_service_placement"),
  projectFkTo("container_service_placement", "container_id", "container"),
  projectFkTo("container_service_placement", "subscription_id", "subscription"),
  projectFkTo("container_service_placement", "service_frequency_id", "service_frequency"),
  tenantFk("container_service_placement", "waste_fraction_id", "waste_fraction"),
  index("product", "product_container_type_id_idx", "company_id", "container_type_id"),
  index("product", "product_waste_fraction_id_idx", "company_id", "waste_fraction_id"),
  index("product", "product_service_frequency_id_idx", "company_id", "service_frequency_id"),
  partialUniqueIndex("customer", "customer_registration_number_idx", ["company_id", "registration_number"], `${ref("customer", "registration_number")} is not null`),
  partialUniqueIndex("property", "property_registry_id_idx", ["company_id", "registry_id"], `${ref("property", "registry_id")} is not null`),
  index("property_party", "property_party_customer_id_idx", "company_id", "customer_id"),
  index("property_group", "property_group_responsible_customer_id_idx", "company_id", "responsible_customer_id"),
  index("property_group_member", "property_group_member_property_id_idx", "company_id", "property_id"),
  index("shared_collection_point", "shared_collection_point_responsible_customer_id_idx", "company_id", "responsible_customer_id"),
  index("shared_collection_point_member", "shared_collection_point_member_property_id_idx", "company_id", "property_id"),
  index("agreement", "agreement_number_idx", "company_id", "number"),
  index("agreement", "agreement_customer_id_idx", "company_id", "customer_id"),
  index("agreement", "agreement_payer_customer_id_idx", "company_id", "payer_customer_id"),
  index("subscription", "subscription_product_id_idx", "company_id", "product_id"),
  index("subscription", "subscription_property_id_idx", "company_id", "property_id"),
  index("subscription", "subscription_shared_collection_point_id_idx", "company_id", "shared_collection_point_id"),
  index("container", "container_container_type_id_idx", "company_id", "container_type_id"),
  index("container_service_placement", "container_service_placement_subscription_id_idx", "company_id", "subscription_id"),
  index("container_service_placement", "container_service_placement_waste_fraction_id_idx", "company_id", "waste_fraction_id"),
  index("container_service_placement", "container_service_placement_service_frequency_id_idx", "company_id", "service_frequency_id"),
]

/** What the fifteen tables owe their migration file, in the order migrations/README.md lays out: fence and trigger table by table, then the exclusion constraints. */
const handWritten = [
  ...Object.values(tables).flatMap((table) => [...tenantFence(table), ...touchUpdatedAt(table)]),
  ...excludeOverlapping(agreement, [agreement.number]),
  ...excludeOverlapping(subscription, [subscription.agreementId, subscription.productId, subscription.locationId]),
  ...excludeOverlapping(containerServicePlacement, [containerServicePlacement.containerId]),
]

describe("the Registry tables as drizzle-kit writes them", () => {
  test("fifteen tables, every column, key, unique, check, generated column and index as the Domain model spells them, every name within 63 bytes", async () => {
    assert.deepEqual(await statementsFor(tables), expected)
  })

  test("migration 0004 begins with exactly what drizzle-kit generates for the schema", async () => {
    const statements = statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))
    // The same statements, whatever order drizzle-kit's loader gave the tables (it sorts a module's exports).
    const generated = (await statementsFor(tables)).map(normalised).sort()
    assert.deepEqual([...statements.slice(0, generated.length)].sort(), generated)
  })

  test("and carries below them the fence and trigger of each table and the three exclusion constraints: 15 x 3 + 3 = 48 statements", async () => {
    const statements = statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))
    const generated = await statementsFor(tables)
    const tail = statements.slice(generated.length)
    assert.equal(tail.length, 48, "fifteen tables, each two fence statements and one trigger, then one exclusion constraint per effective-dated table")
    assert.deepEqual(tail, handWritten.map(normalised))
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

describe("the check helpers of this context", () => {
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
    const long = wms.table(name, { ...id, ...tenant, quantity: integer() }, (t) => [positive(t.quantity)])
    assert.throws(() => getTableConfig(long), new RegExp(`positive: "${name}_quantity_positive" is 73 bytes; Postgres would truncate it to 63 silently`))
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
