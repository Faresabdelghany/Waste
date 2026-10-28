// The Registry tables (Issue #78, slice 1) as drizzle-kit writes them: the
// fifteen CREATE TABLE statements with their columns, keys, uniques and
// checks, the generated location column, the composite and project-scoped
// foreign keys, the two partial unique indexes; then migration 0004, which has
// to begin with exactly those statements, so the file and `pnpm db:generate`
// cannot drift apart, and to carry below them what the helpers write for each
// table and the three exclusion constraints. The two new key helpers and the
// two new check helpers by their text and their refusals. No database.
//
// Migration 0007 (Issue #101) gave `container_service_placement` a project
// key — through the container, `(company_id, project_id, container_id, id)`,
// since the Stock Movement ledger references the placement of the container it
// moves — and dropped the index on its project that the key now leads with.
// An applied file is never edited, so 0004 is held to the earlier spelling:
// `CHANGED_IN_0007` maps the CREATE TABLE as drizzle-kit writes it now onto
// what 0004 says, and `DROPPED_IN_0007` is what 0004 has that the schema no
// longer generates.
//
// Migration 0010 (Issue #112) changed two more of the fifteen: `product`
// gained its invoice name, invoice code and VAT rate with the rate's range
// check and a partial unique on the code, and `agreement` gained the price
// list it is priced under with its key and index. `CHANGED_IN_0010` maps the
// two CREATE TABLEs as drizzle-kit writes them now onto what 0004 says, and
// `ADDED_IN_0010` is left out of the comparison, the way
// planning-rendering.test.ts holds 0006 to its own day;
// finance-rendering.test.ts pins the ALTER TABLE statements themselves.
//
// Migration 0022 gave `property` and `shared_collection_point` the driver's
// instructions, a nullable text column each: `CHANGED_IN_0022` maps the two
// CREATE TABLEs as drizzle-kit writes them now onto what 0004 says, and
// driver-instructions-rendering.test.ts pins the ALTER TABLE statements.
//
// Migration 0029 (#291 slice 29) gave `waste_fraction` its `waste_code` and
// the check on its shape: `CHANGED_IN_0029` maps the CREATE TABLE as
// drizzle-kit writes it now onto what 0004 says, and
// waste-code-rendering.test.ts pins the two ALTER TABLE statements.
//
// Migration 0037 (#291 C4) gave `customer` its own payment terms, with the
// range the project's are held to: `CHANGED_IN_0037` maps its CREATE TABLE
// onto 0004's, and finance-settings-rendering.test.ts pins the statements.
//
// Migration 0043 (M13 of #293) gave `waste_fraction` its `treatment` and the
// check over the domain's list: `CHANGED_IN_0043` maps its CREATE TABLE onto
// 0029's spelling, and sustainability-rendering.test.ts pins the two ALTER
// TABLE statements.
//
// Migration 0050 (O10 of #290) gave `waste_fraction` its density and
// `container_type` its service seconds, each with its range:
// `CHANGED_IN_0050`, first of both chains, maps today's CREATE TABLEs onto
// 0043's and 0004's, and workload-rendering.test.ts pins the statements.
//
// Migration 0044 (M14 of #293) gave `product` the `day` unit and a hire's free
// days with their shape: `CHANGED_IN_0010` maps the product as drizzle-kit
// writes it as of 0044 onto 0004's, and container-hire-rendering.test.ts pins
// the statements.
//
// Migration 0054 (#393, M4 of #293) gave its unit `visit`, a recycling-centre
// visit's: `CHANGED_IN_0054` maps the product as of 0054 onto 0044's, and
// site-visits-rendering.test.ts pins the statements.
//
// Migration 0066 (O28 of #290) gave its unit `tonne`, a collection charged by
// its reviewed weight: `CHANGED_IN_0066`, now first of the product's chain,
// maps today's product onto 0054's, and weight-charges-rendering.test.ts pins
// the statements.
//
// Migration 0056 (O14 of #290) gave `property` and `agreement` their service
// window and its check: `CHANGED_IN_0056`, first of both chains, maps today's
// CREATE TABLEs onto 0022's and 0010's, and time-windows-rendering.test.ts
// pins the statements.
//
// Migration 0062 (#291 C13) gave `property` the address register's id and the
// address's parts, with their shape checks: `CHANGED_IN_0062`, first of the
// property's chain, maps today's CREATE TABLE onto 0056's, and
// address-register-rendering.test.ts pins the statements.
//
// This is also what makes a change to the vocabulary a migration: the values
// are spelled here as the file spells them, so adding one to a list in
// @waste/domain/registry/vocabulary fails this test until a migration replaces
// the check.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { WASTE_CODE_PATTERN } from "@waste/domain/registry/waste-code"
import { getTableConfig, integer, text, uuid } from "drizzle-orm/pg-core"

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
import {
  checksOf,
  companyFk,
  createTable,
  foreignKey,
  geometryCheck,
  index,
  lowercaseCheck,
  oneOfCheck,
  partialUniqueIndex,
  positiveCheck,
  projectFk,
  projectFkTo,
  ref,
  tenantFk,
  uniqueKey,
  validityCheck,
} from "./rendering"
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

/** container_service_placement as drizzle-kit writes it today, with the through-the-container project key 0007 added, and as it wrote it as of 0004, without. */
const placementTable = (resources: boolean): string =>
  createTable("container_service_placement", "dated", [
    '"container_id" uuid NOT NULL',
    '"subscription_id" uuid NOT NULL',
    '"waste_fraction_id" uuid NOT NULL',
    '"service_frequency_id" uuid',
    ...(resources ? [uniqueKey("container_service_placement_container_id_project_key", "company_id", "project_id", "container_id", "id")] : []),
    validityCheck("container_service_placement"),
  ])

/** What 0007 changed on a table 0004 created. */
const CHANGED_IN_0007 = new Map([[placementTable(true), placementTable(false)]])

/** What 0004 created and 0007 dropped: the index on the placement's project, which its key now leads with. */
const DROPPED_IN_0007 = [index("container_service_placement", "container_service_placement_project_id_idx", "company_id", "project_id")]

/** product as drizzle-kit wrote it as of 0004, as of 0010 with the invoice name, code and VAT rate (Issue #112), as of 0044 (M14 of #293) with the `day` unit and a hire's free days, as of 0054 (#393) with the `visit` unit, and as it writes it since 0066 (O28 of #290), with the `tonne` unit. */
const productTable = (asOf: "0004" | "0010" | "0044" | "0054" | "0066"): string => {
  const finance = asOf !== "0004"
  const hire = asOf === "0044" || asOf === "0054" || asOf === "0066"
  return createTable("product", "project", [
    '"name" text NOT NULL',
    '"kind" text NOT NULL',
    '"status" text NOT NULL',
    '"unit" text NOT NULL',
    '"container_type_id" uuid',
    '"waste_fraction_id" uuid',
    '"service_frequency_id" uuid',
    ...(finance ? ['"invoice_name" text', '"invoice_code" text', '"vat_percent" integer'] : []),
    ...(hire ? ['"free_days" integer'] : []),
    uniqueKey("product_project_id_name_key", "company_id", "project_id", "name"),
    uniqueKey("product_project_key", "company_id", "project_id", "id"),
    oneOfCheck("product", "kind", "container-collection", "recurring-service", "additional-service"),
    oneOfCheck("product", "status", "draft", "active", "inactive"),
    oneOfCheck("product", "unit", "pickup", "month", "job", ...(hire ? ["day"] : []), ...(asOf === "0054" || asOf === "0066" ? ["visit"] : []), ...(asOf === "0066" ? ["tonne"] : [])),
    ...(finance ? [`CONSTRAINT "product_vat_percent_range" CHECK (${ref("product", "vat_percent")} between 0 and 100)`] : []),
    ...(hire ? [`CONSTRAINT "product_free_days_shape" CHECK (${ref("product", "free_days")} is null or (${ref("product", "unit")} = 'day' and ${ref("product", "free_days")} between 0 and 366))`] : []),
  ])
}

/** agreement as drizzle-kit writes it today, with the service window 0056 added (O14 of #290); as of 0010, with the price list (Issue #112); and as of 0004, without either. */
const agreementTable = (asOf: "0004" | "0010" | "0056"): string =>
  createTable("agreement", "dated", [
    '"number" text NOT NULL',
    '"customer_id" uuid NOT NULL',
    '"payer_customer_id" uuid NOT NULL',
    '"status" text NOT NULL',
    '"billing_cadence" text NOT NULL',
    '"currency" text NOT NULL',
    '"notes" text',
    ...(asOf >= "0010" ? ['"price_list_id" uuid'] : []),
    ...(asOf >= "0056" ? ['"service_window_start" time', '"service_window_end" time'] : []),
    uniqueKey("agreement_project_key", "company_id", "project_id", "id"),
    ...(asOf >= "0056" ? [`CONSTRAINT "agreement_service_window" CHECK ((${ref("agreement", "service_window_start")} is null) = (${ref("agreement", "service_window_end")} is null) and (${ref("agreement", "service_window_start")} is null or ${ref("agreement", "service_window_end")} > ${ref("agreement", "service_window_start")}))`] : []),
    validityCheck("agreement"),
    oneOfCheck("agreement", "status", "draft", "active", "cancelled"),
    oneOfCheck("agreement", "billing_cadence", "monthly", "quarterly", "annual", "manual"),
  ])

/** What 0066 changed (O28 of #290): the product's CREATE TABLE as drizzle-kit generates it now onto what it generated as of 0054. Applied first. */
const CHANGED_IN_0066 = new Map([[productTable("0066"), productTable("0054")]])

/** What 0054 changed (#393): the product's CREATE TABLE as drizzle-kit generated it as of 0054 onto what it generated as of 0044. Applied after `CHANGED_IN_0066`. */
const CHANGED_IN_0054 = new Map([[productTable("0054"), productTable("0044")]])

/** What 0010 changed on two tables 0004 created (Issue #112), and 0044 on the product again: the statement as drizzle-kit generated it as of 0044 (the agreement's as it generates it now), and as it generated it as of 0004. */
const CHANGED_IN_0010 = new Map([
  [productTable("0044"), productTable("0004")],
  [agreementTable("0010"), agreementTable("0004")],
])

/** What 0010 added to the two tables beside the columns: the agreement's key into Finance and its index, and the product's partial unique on the invoice code. 0004 begins with the generated statements less these. */
const ADDED_IN_0010 = [
  projectFkTo("agreement", "price_list_id", "price_list"),
  partialUniqueIndex("product", "product_invoice_code_idx", ["company_id", "project_id", "invoice_code"], `${ref("product", "invoice_code")} is not null`),
  index("agreement", "agreement_price_list_id_idx", "company_id", "price_list_id"),
]

/** The address's parts 0062 added (#291 C13), in the schema's order. */
const ADDRESS_PARTS = ["street_name", "house_number", "floor", "door", "postcode", "post_town", "municipality_code"]
const PRESENT_WITH_THE_ID = ["street_name", "house_number", "postcode", "post_town", "municipality_code"]
const ADDRESS_SHAPE = `${PRESENT_WITH_THE_ID.map((column) => `(${ref("property", "address_id")} is null) = (${ref("property", column)} is null)`).join(" and ")} and (${ref("property", "address_id")} is not null or (${ref("property", "floor")} is null and ${ref("property", "door")} is null))`

/** property as drizzle-kit writes it today, with the address register's id and parts 0062 added (#291 C13); as of 0056, with the service window (O14 of #290); as of 0022, with the driver's instructions; and as of 0004, without any. */
const propertyTable = (asOf: "0004" | "0022" | "0056" | "0062"): string =>
  createTable("property", "project", [
    '"name" text NOT NULL',
    '"address" text NOT NULL',
    ...(asOf >= "0062" ? ['"address_id" uuid', ...ADDRESS_PARTS.map((column) => `"${column}" text`)] : []),
    '"registry_id" text',
    '"kind" text NOT NULL',
    '"location" geometry(Point, 4326)',
    '"notes" text',
    ...(asOf >= "0022" ? ['"driver_instructions" text'] : []),
    '"status" text NOT NULL',
    ...(asOf >= "0056" ? ['"service_window_start" time', '"service_window_end" time'] : []),
    uniqueKey("property_project_id_name_key", "company_id", "project_id", "name"),
    uniqueKey("property_project_key", "company_id", "project_id", "id"),
    ...(asOf >= "0056" ? [`CONSTRAINT "property_service_window" CHECK ((${ref("property", "service_window_start")} is null) = (${ref("property", "service_window_end")} is null) and (${ref("property", "service_window_start")} is null or ${ref("property", "service_window_end")} > ${ref("property", "service_window_start")}))`] : []),
    oneOfCheck("property", "kind", "residential", "commercial", "public", "mixed", "other"),
    oneOfCheck("property", "status", "active", "inactive"),
    geometryCheck("property", "location"),
    ...(asOf >= "0062"
      ? [
          `CONSTRAINT "property_address_shape" CHECK (${ADDRESS_SHAPE})`,
          `CONSTRAINT "property_postcode_shape" CHECK (${ref("property", "postcode")} ~ '^[0-9]{4}$')`,
          `CONSTRAINT "property_municipality_code_shape" CHECK (${ref("property", "municipality_code")} ~ '^[0-9]{4}$')`,
        ]
      : []),
  ])

/** shared_collection_point as drizzle-kit writes it today, with the driver's instructions 0022 added, and as of 0004, without. */
const pointTable = (instructions: boolean): string =>
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
    ...(instructions ? ['"driver_instructions" text'] : []),
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
  ])

/** customer as drizzle-kit writes it today, and as it wrote it as of 0004, before 0037 gave it its own payment terms (#291 C4). */
const customerTable = (terms: boolean): string =>
  createTable("customer", "tenant", [
    '"kind" text NOT NULL',
    '"name" text NOT NULL',
    '"registration_number" text',
    '"email" text',
    '"phone" text',
    '"billing_address" text',
    '"service_messages_allowed" boolean DEFAULT true NOT NULL',
    ...(terms ? ['"payment_terms_days" integer'] : []),
    '"status" text NOT NULL',
    uniqueKey("customer_tenant_key", "company_id", "id"),
    oneOfCheck("customer", "kind", "person", "organisation"),
    oneOfCheck("customer", "status", "active", "inactive"),
    lowercaseCheck("customer", "email"),
    ...(terms ? [`CONSTRAINT "customer_payment_terms_range" CHECK (${ref("customer", "payment_terms_days")} between 0 and 365)`] : []),
  ])

/** What 0037 changed on one table 0004 created: the statement as drizzle-kit generates it now, and as it generated it as of 0004. */
const CHANGED_IN_0037 = new Map([[customerTable(true), customerTable(false)]])

/** What 0062 changed (#291 C13): the property's CREATE TABLE as drizzle-kit generates it now onto what it was before it. Applied first. */
const CHANGED_IN_0062 = new Map([[propertyTable("0062"), propertyTable("0056")]])

/** What 0056 changed (O14 of #290): the property's and the agreement's CREATE TABLEs as drizzle-kit generates them now onto what they were before it. Applied first, one file at a time. */
const CHANGED_IN_0056 = new Map([
  [propertyTable("0056"), propertyTable("0022")],
  [agreementTable("0056"), agreementTable("0010")],
])

/** What 0022 changed on two tables 0004 created: the statement as drizzle-kit generates it now, and as it generated it as of 0004. */
const CHANGED_IN_0022 = new Map([
  [propertyTable("0022"), propertyTable("0004")],
  [pointTable(true), pointTable(false)],
])

/** waste_fraction as drizzle-kit wrote it as of 0004; as of 0029, with the waste code and its shape check; as of 0043, with the treatment and its check; and as it writes it since 0050, with the density and its range. */
const fractionTable = (asOf: "0004" | "0029" | "0043" | "0050"): string =>
  createTable("waste_fraction", "tenant", [
    '"key" text NOT NULL',
    '"name" text NOT NULL',
    ...(asOf >= "0029" ? ['"waste_code" text'] : []),
    ...(asOf >= "0043" ? ['"treatment" text'] : []),
    ...(asOf >= "0050" ? ['"density_kg_per_cubic_metre" integer'] : []),
    uniqueKey("waste_fraction_key_key", "company_id", "key"),
    uniqueKey("waste_fraction_name_key", "company_id", "name"),
    uniqueKey("waste_fraction_tenant_key", "company_id", "id"),
    lowercaseCheck("waste_fraction", "key"),
    ...(asOf >= "0029" ? [`CONSTRAINT "waste_fraction_waste_code_shape" CHECK (${ref("waste_fraction", "waste_code")} ~ '${WASTE_CODE_PATTERN}')`] : []),
    ...(asOf >= "0043" ? [oneOfCheck("waste_fraction", "treatment", "reuse", "recycling", "energy-recovery", "disposal")] : []),
    ...(asOf >= "0050" ? [`CONSTRAINT "waste_fraction_density_kg_per_cubic_metre_range" CHECK (${ref("waste_fraction", "density_kg_per_cubic_metre")} between 1 and 2000)`] : []),
  ])

/** container_type as drizzle-kit wrote it as of 0004, and as it writes it since 0050, with the service seconds and their range. */
const containerTypeTable = (asOf: "0004" | "0050"): string =>
  createTable("container_type", "tenant", [
    '"name" text NOT NULL',
    '"volume_litres" integer',
    ...(asOf >= "0050" ? ['"service_seconds" integer'] : []),
    uniqueKey("container_type_name_key", "company_id", "name"),
    uniqueKey("container_type_tenant_key", "company_id", "id"),
    positiveCheck("container_type", "volume_litres"),
    ...(asOf >= "0050" ? [`CONSTRAINT "container_type_service_seconds_range" CHECK (${ref("container_type", "service_seconds")} between 1 and 3600)`] : []),
  ])

/** What 0050 changed: the fraction's and the container type's CREATE TABLEs as drizzle-kit generates them now onto what they were before it. Applied first, one file at a time. */
const CHANGED_IN_0050 = new Map([
  [fractionTable("0050"), fractionTable("0043")],
  [containerTypeTable("0050"), containerTypeTable("0004")],
])

/** What 0043 changed: the fraction's CREATE TABLE as drizzle-kit generated it as of 0043 onto what it generated as of 0029. Applied after `CHANGED_IN_0050`. */
const CHANGED_IN_0043 = new Map([[fractionTable("0043"), fractionTable("0029")]])

/** What 0029 changed: the fraction's CREATE TABLE as drizzle-kit generated it as of 0029 onto what 0004 says. Applied after `CHANGED_IN_0043`. */
const CHANGED_IN_0029 = new Map([[fractionTable("0029"), fractionTable("0004")]])

const expected = [
  fractionTable("0050"),
  containerTypeTable("0050"),
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
  productTable("0066"),
  customerTable(true),
  propertyTable("0062"),
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
  pointTable(true),
  createTable("shared_collection_point_member", "project", [
    '"shared_collection_point_id" uuid NOT NULL',
    '"property_id" uuid NOT NULL',
    '"role" text NOT NULL',
    uniqueKey("shared_collection_point_member_membership_key", "company_id", "shared_collection_point_id", "property_id"),
    oneOfCheck("shared_collection_point_member", "role", "service-member", "administrator", "payer", "notification-contact"),
  ]),
  agreementTable("0056"),
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
  placementTable(true),
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
  projectFkTo("agreement", "price_list_id", "price_list"),
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
  partialUniqueIndex("product", "product_invoice_code_idx", ["company_id", "project_id", "invoice_code"], `${ref("product", "invoice_code")} is not null`),
  partialUniqueIndex("customer", "customer_registration_number_idx", ["company_id", "registration_number"], `${ref("customer", "registration_number")} is not null`),
  partialUniqueIndex("property", "property_registry_id_idx", ["company_id", "registry_id"], `${ref("property", "registry_id")} is not null`),
  index("property_party", "property_party_project_id_idx", "company_id", "project_id"),
  index("property_party", "property_party_customer_id_idx", "company_id", "customer_id"),
  index("property_group", "property_group_responsible_customer_id_idx", "company_id", "responsible_customer_id"),
  index("property_group_member", "property_group_member_project_id_idx", "company_id", "project_id"),
  index("property_group_member", "property_group_member_property_id_idx", "company_id", "property_id"),
  index("shared_collection_point", "shared_collection_point_responsible_customer_id_idx", "company_id", "responsible_customer_id"),
  index("shared_collection_point_member", "shared_collection_point_member_project_id_idx", "company_id", "project_id"),
  index("shared_collection_point_member", "shared_collection_point_member_property_id_idx", "company_id", "property_id"),
  index("agreement", "agreement_number_idx", "company_id", "number"),
  index("agreement", "agreement_customer_id_idx", "company_id", "customer_id"),
  index("agreement", "agreement_payer_customer_id_idx", "company_id", "payer_customer_id"),
  index("agreement", "agreement_price_list_id_idx", "company_id", "price_list_id"),
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

  /** Everything drizzle-kit wrote at the head of 0004, as it was generated as of 0004: the placement, the product, the agreement and the two places in their earlier spelling, what 0010 added left out, and the index 0007 dropped back in. */
  const generatedHead = async (): Promise<string[]> => [
    ...(await statementsFor(tables))
      .filter((statement) => !ADDED_IN_0010.includes(statement))
      .map((statement) => CHANGED_IN_0062.get(statement) ?? statement)
      .map((statement) => CHANGED_IN_0056.get(statement) ?? statement)
      .map((statement) => CHANGED_IN_0066.get(statement) ?? statement)
      .map((statement) => CHANGED_IN_0054.get(statement) ?? statement)
      .map((statement) => CHANGED_IN_0050.get(statement) ?? statement)
      .map((statement) => CHANGED_IN_0043.get(statement) ?? statement)
      .map((statement) => CHANGED_IN_0007.get(statement) ?? CHANGED_IN_0010.get(statement) ?? CHANGED_IN_0022.get(statement) ?? CHANGED_IN_0029.get(statement) ?? CHANGED_IN_0037.get(statement) ?? statement),
    ...DROPPED_IN_0007,
  ]

  test("migration 0004 begins with exactly what drizzle-kit generated for the schema as of 0004", async () => {
    const statements = statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))
    // The same statements, whatever order drizzle-kit's loader gave the tables (it sorts a module's exports).
    const generated = (await generatedHead()).map(normalised).sort()
    assert.deepEqual([...statements.slice(0, generated.length)].sort(), generated)
    const today = await statementsFor(tables)
    for (const statement of CHANGED_IN_0007.keys()) assert.ok(today.includes(statement), statement.split("\n")[0])
    for (const statement of CHANGED_IN_0066.keys()) assert.ok(today.includes(statement), statement.split("\n")[0])
    for (const statement of CHANGED_IN_0054.keys()) assert.ok([...CHANGED_IN_0066.values()].includes(statement), statement.split("\n")[0])
    for (const statement of CHANGED_IN_0062.keys()) assert.ok(today.includes(statement), statement.split("\n")[0])
    for (const statement of CHANGED_IN_0056.keys()) assert.ok(today.includes(statement) || [...CHANGED_IN_0062.values()].includes(statement), statement.split("\n")[0])
    for (const statement of CHANGED_IN_0010.keys()) assert.ok([...CHANGED_IN_0054.values(), ...CHANGED_IN_0056.values()].includes(statement), statement.split("\n")[0])
    for (const statement of CHANGED_IN_0022.keys()) assert.ok(today.includes(statement) || [...CHANGED_IN_0056.values()].includes(statement), statement.split("\n")[0])
    for (const statement of CHANGED_IN_0050.keys()) assert.ok(today.includes(statement), statement.split("\n")[0])
    for (const statement of CHANGED_IN_0043.keys()) assert.ok([...CHANGED_IN_0050.values()].includes(statement), statement.split("\n")[0])
    for (const statement of CHANGED_IN_0029.keys()) assert.ok([...CHANGED_IN_0043.values()].includes(statement), statement.split("\n")[0])
    for (const statement of CHANGED_IN_0037.keys()) assert.ok(today.includes(statement), statement.split("\n")[0])
    for (const statement of ADDED_IN_0010) assert.ok(today.includes(statement), statement)
    for (const statement of DROPPED_IN_0007) assert.equal(today.includes(statement), false, statement)
  })

  test("and carries below them the fence and trigger of each table and the three exclusion constraints: 15 x 3 + 3 = 48 statements", async () => {
    const statements = statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))
    const generated = await generatedHead()
    const tail = statements.slice(generated.length)
    assert.equal(tail.length, 48, "fifteen tables, each two fence statements and one trigger, then one exclusion constraint per effective-dated table")
    assert.deepEqual(tail, handWritten.map(normalised))
  })
})

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
