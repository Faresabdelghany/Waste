// The Resources tables (Issue #101, slice 1) as drizzle-kit writes them: the
// thirteen CREATE TABLE statements with their columns, keys, uniques, checks
// and partial indexes — the first `recorded` and `window` column sets, the
// first CASE check, the four inline shape checks of the ledger — the ALTER
// TABLEs into Planning and the Registry (three columns added and the token
// dropped on `collection_group`, two on `route_scheme`, the placement's
// project key), and then migration 0007, which has to begin with exactly
// those statements, so the file and `pnpm db:generate` cannot drift apart, and
// to carry below them what the helpers write for each table — the fence and
// the trigger, or for the two ledgers the fence and the revoke — and the three
// window exclusion constraints. The two new column sets by their text, the
// window check by its refusal, and the asset-state CASE as text. No database.
//
// This is also what makes a change to the vocabulary a migration: the values
// are spelled here as the file spells them, so adding one to a list in
// @waste/domain/resources/vocabulary fails this test until a migration replaces
// the check.
//
// The ALTER TABLEs are generated in two steps, as the file was: drizzle-kit
// asks, on a TTY, whether `rule_vehicle_type_id` is `rule_vehicle_type` renamed
// whenever one table both gains and loses a column in one diff, so the first
// diff adds the columns and the second drops the token, and the union is what
// the CLI writes for "create column". Two things the file carries that
// drizzle-kit did not write there: the placement's project key stands above
// the foreign key that points at it (the head is compared as a set, and the
// order pinned by itself), and a hand-written guard stands before the `DROP
// COLUMN` — the migration fails when any row still holds a token, since 0007
// does not backfill and a database with data must refuse to lose it.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { HOLIDAY_POLICIES, RECURRENCE_FREQUENCIES, ROUTE_SCHEME_STATUSES, SCHEME_EDIT_POLICIES, SERVICE_DAYS, SERVICE_TYPES, STOP_SOURCES, WEEK_ROTATIONS } from "@waste/domain/planning/vocabulary"
import { eq, sql } from "drizzle-orm"
import { boolean, check, getTableConfig, integer, PgDialect, text, time, uuid } from "drizzle-orm/pg-core"

import { drizzle } from "drizzle-orm/postgres-js"

import { CASING } from "../casing"
import { MIGRATIONS_FOLDER } from "../migrate"
import { tableObjectName } from "../names"
import { ASSET_STATE, assetStateOf, assetStatus } from "../query/asset-state"
import { subscription } from "../schema/agreements"
import { vehicleAllocation, vehicleAllocationEvent } from "../schema/allocations"
import { serviceFrequency, wasteFraction } from "../schema/catalogue"
import { nonEmpty, oneOf, positive, subsetOf } from "../schema/checks"
import { id, orderedWindow, projectScoped, recorded, tenant, timestamps, validity, validPeriod, window } from "../schema/columns"
import { container, containerServicePlacement } from "../schema/containers"
import { driver, vehicle, vehicleCompartment, vehicleCompartmentFraction } from "../schema/fleet"
import { containerTypeVehicleType, vehicleType } from "../schema/fleet-types"
import { company, project, serviceProvider } from "../schema/organisation"
import { depot, unloadingStation, unloadingStationFraction, warehouse } from "../schema/places"
import { planningArea } from "../schema/planning-areas"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "../schema/references"
import { collectionGroup, routeScheme } from "../schema/route-schemes"
import { stockMovement } from "../schema/stock"
import { wms } from "../schema/wms"
import { excludeOverlappingWindow } from "../sql/exclude-overlapping-window"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, companyFk, createTable, foreignKey, geometryCheck, ID, index, lowercaseCheck, oneOfCheck, partialUniqueIndex, positiveCheck, projectFk, projectFkTo, ref, tenantFk, uniqueKey } from "./rendering"
import { statementsBetween, statementsFor } from "./specimen"

/** The thirteen tables in the order src/schema/index.ts exports them; drizzle-kit's own loader sorts a module's exports, which the migration test allows for. */
const tables = {
  vehicleType,
  containerTypeVehicleType,
  depot,
  warehouse,
  unloadingStation,
  unloadingStationFraction,
  vehicle,
  vehicleCompartment,
  vehicleCompartmentFraction,
  driver,
  stockMovement,
  vehicleAllocation,
  vehicleAllocationEvent,
}

const MIGRATION = "0007_resources.sql"
const COMPANY = '"company_id" uuid NOT NULL'
const PROJECT = '"project_id" uuid NOT NULL'
const RECORDED = '"recorded_at" timestamp with time zone DEFAULT now() NOT NULL'
const WINDOW = ['"planned_from" timestamp with time zone NOT NULL', '"planned_to" timestamp with time zone NOT NULL']

/** A ledger's CREATE TABLE: id, tenant, project, the one stamp, then its own lines. */
const createLedger = (name: string, lines: string[]): string => [`CREATE TABLE "wms"."${name}" (`, [ID, COMPANY, PROJECT, RECORDED, ...lines].map((line) => `\t${line}`).join(",\n"), ");", ""].join("\n")

const STOCK = ["warehouse", "maintenance"]
const PLACES = ["supplier", ...STOCK, "service", "scrap"]

/** The kind check as one CASE, spelled as the domain's MOVEMENT_SHAPES spells the pairs. */
const kindShape = (() => {
  const kind = ref("stock_movement", "kind")
  const from = ref("stock_movement", "from_kind")
  const to = ref("stock_movement", "to_kind")
  return `CONSTRAINT "stock_movement_kind_shape" CHECK (case ${kind} when 'receipt' then ${from} = 'supplier' and ${to} = 'warehouse' when 'issue' then ${from} in ('warehouse', 'maintenance') and ${to} = 'service' when 'return' then ${from} = 'service' and ${to} in ('warehouse', 'maintenance') when 'transfer' then ${from} in ('warehouse', 'maintenance') and ${to} in ('warehouse', 'maintenance') when 'decommission' then ${from} in ('warehouse', 'maintenance', 'service') and ${to} = 'scrap' when 'adjustment' then ${from} <> 'service' and ${to} in ('warehouse', 'maintenance', 'scrap') else false end)`
})()

const providerShape = (table: string, column = "ownership") => `CONSTRAINT "${table}_provider_shape" CHECK ((${ref(table, column)} = 'service-provider') = (${ref(table, "service_provider_id")} is not null))`
const hoursShape = (table: string) => `CONSTRAINT "${table}_hours_shape" CHECK ((${ref(table, "opens_at")} is null) = (${ref(table, "closes_at")} is null))`

const expected = [
  createTable("vehicle_type", "tenant", [
    '"key" text NOT NULL',
    '"name" text NOT NULL',
    '"description" text',
    uniqueKey("vehicle_type_key_key", "company_id", "key"),
    uniqueKey("vehicle_type_name_key", "company_id", "name"),
    uniqueKey("vehicle_type_tenant_key", "company_id", "id"),
    lowercaseCheck("vehicle_type", "key"),
  ]),
  createTable("container_type_vehicle_type", "tenant", [
    '"container_type_id" uuid NOT NULL',
    '"vehicle_type_id" uuid NOT NULL',
    uniqueKey("container_type_vehicle_type_membership_key", "company_id", "vehicle_type_id", "container_type_id"),
  ]),
  createTable("depot", "project", [
    '"code" text NOT NULL',
    '"name" text NOT NULL',
    '"address" text NOT NULL',
    '"location" geometry(Point, 4326) NOT NULL',
    '"ownership" text NOT NULL',
    '"service_provider_id" uuid',
    '"opens_at" time',
    '"closes_at" time',
    '"vehicle_capacity" integer',
    '"status" text NOT NULL',
    '"notes" text',
    uniqueKey("depot_project_id_code_key", "company_id", "project_id", "code"),
    uniqueKey("depot_project_id_name_key", "company_id", "project_id", "name"),
    uniqueKey("depot_project_key", "company_id", "project_id", "id"),
    oneOfCheck("depot", "ownership", "company", "service-provider"),
    oneOfCheck("depot", "status", "draft", "active", "seasonal", "closed"),
    geometryCheck("depot", "location"),
    positiveCheck("depot", "vehicle_capacity"),
    providerShape("depot"),
    hoursShape("depot"),
  ]),
  createTable("warehouse", "project", [
    '"code" text NOT NULL',
    '"name" text NOT NULL',
    '"address" text NOT NULL',
    '"location" geometry(Point, 4326)',
    '"depot_id" uuid',
    '"status" text NOT NULL',
    '"notes" text',
    uniqueKey("warehouse_project_id_code_key", "company_id", "project_id", "code"),
    uniqueKey("warehouse_project_id_name_key", "company_id", "project_id", "name"),
    uniqueKey("warehouse_project_key", "company_id", "project_id", "id"),
    oneOfCheck("warehouse", "status", "draft", "active", "restricted", "closed"),
    geometryCheck("warehouse", "location"),
  ]),
  createTable("unloading_station", "tenant", [
    '"code" text NOT NULL',
    '"name" text NOT NULL',
    '"address" text NOT NULL',
    '"location" geometry(Point, 4326) NOT NULL',
    '"ownership" text NOT NULL',
    '"service_provider_id" uuid',
    '"opens_at" time',
    '"closes_at" time',
    '"weighbridge" boolean DEFAULT false NOT NULL',
    '"status" text NOT NULL',
    '"notes" text',
    uniqueKey("unloading_station_code_key", "company_id", "code"),
    uniqueKey("unloading_station_name_key", "company_id", "name"),
    uniqueKey("unloading_station_tenant_key", "company_id", "id"),
    oneOfCheck("unloading_station", "ownership", "company", "service-provider", "external"),
    oneOfCheck("unloading_station", "status", "draft", "active", "seasonal", "closed"),
    geometryCheck("unloading_station", "location"),
    providerShape("unloading_station"),
    hoursShape("unloading_station"),
  ]),
  createTable("unloading_station_fraction", "tenant", [
    '"unloading_station_id" uuid NOT NULL',
    '"waste_fraction_id" uuid NOT NULL',
    uniqueKey("unloading_station_fraction_membership_key", "company_id", "unloading_station_id", "waste_fraction_id"),
  ]),
  createTable("vehicle", "project", [
    '"registration" text NOT NULL',
    '"callsign" text',
    '"kind" text NOT NULL',
    '"vehicle_type_id" uuid NOT NULL',
    '"ownership" text NOT NULL',
    '"service_provider_id" uuid',
    '"status" text NOT NULL',
    '"capacity_kg" integer',
    '"required_licence_class" text NOT NULL',
    '"home_depot_id" uuid',
    '"fuel" text',
    '"telematics_device_id" text',
    '"notes" text',
    uniqueKey("vehicle_registration_key", "company_id", "registration"),
    uniqueKey("vehicle_project_key", "company_id", "project_id", "id"),
    oneOfCheck("vehicle", "kind", "powered-vehicle", "trailer"),
    oneOfCheck("vehicle", "ownership", "company", "service-provider", "leased"),
    oneOfCheck("vehicle", "status", "active", "unavailable", "maintenance", "retired"),
    oneOfCheck("vehicle", "required_licence_class", "b", "c", "ce"),
    oneOfCheck("vehicle", "fuel", "diesel", "hvo", "biogas", "electric", "hybrid", "other"),
    positiveCheck("vehicle", "capacity_kg"),
    providerShape("vehicle"),
  ]),
  createTable("vehicle_compartment", "project", [
    '"vehicle_id" uuid NOT NULL',
    '"position" integer NOT NULL',
    '"name" text',
    '"capacity_kg" integer',
    '"volume_litres" integer',
    uniqueKey("vehicle_compartment_vehicle_id_position_key", "company_id", "vehicle_id", "position"),
    uniqueKey("vehicle_compartment_project_key", "company_id", "project_id", "id"),
    positiveCheck("vehicle_compartment", "position"),
    positiveCheck("vehicle_compartment", "capacity_kg"),
    positiveCheck("vehicle_compartment", "volume_litres"),
  ]),
  createTable("vehicle_compartment_fraction", "project", [
    '"vehicle_compartment_id" uuid NOT NULL',
    '"waste_fraction_id" uuid NOT NULL',
    uniqueKey("vehicle_compartment_fraction_membership_key", "company_id", "vehicle_compartment_id", "waste_fraction_id"),
  ]),
  createTable("driver", "project", [
    '"name" text NOT NULL',
    '"workforce_reference" text',
    '"employment" text NOT NULL',
    '"service_provider_id" uuid',
    '"home_depot_id" uuid',
    '"licence_class" text',
    '"licence_number" text',
    '"licence_expiry" date',
    '"user_account_id" uuid',
    '"status" text NOT NULL',
    '"notes" text',
    uniqueKey("driver_project_key", "company_id", "project_id", "id"),
    oneOfCheck("driver", "employment", "employee", "service-provider", "temporary"),
    oneOfCheck("driver", "licence_class", "b", "c", "ce"),
    oneOfCheck("driver", "status", "active", "inactive", "suspended"),
    providerShape("driver", "employment"),
  ]),
  createLedger("stock_movement", [
    '"container_id" uuid NOT NULL',
    '"kind" text NOT NULL',
    '"from_kind" text NOT NULL',
    '"from_warehouse_id" uuid',
    '"to_kind" text NOT NULL',
    '"to_warehouse_id" uuid',
    '"placement_id" uuid',
    '"occurred_at" timestamp with time zone NOT NULL',
    '"recorded_by" uuid NOT NULL',
    '"reason" text',
    '"reference" text',
    '"corrects_movement_id" uuid',
    uniqueKey("stock_movement_tenant_key", "company_id", "id"),
    oneOfCheck("stock_movement", "kind", "receipt", "issue", "return", "transfer", "adjustment", "decommission"),
    oneOfCheck("stock_movement", "from_kind", ...PLACES),
    oneOfCheck("stock_movement", "to_kind", ...PLACES),
    `CONSTRAINT "stock_movement_from_shape" CHECK ((${ref("stock_movement", "from_kind")} in ('warehouse', 'maintenance')) = (${ref("stock_movement", "from_warehouse_id")} is not null))`,
    `CONSTRAINT "stock_movement_to_shape" CHECK ((${ref("stock_movement", "to_kind")} in ('warehouse', 'maintenance')) = (${ref("stock_movement", "to_warehouse_id")} is not null))`,
    `CONSTRAINT "stock_movement_placement_shape" CHECK ((${ref("stock_movement", "from_kind")} = 'service' or ${ref("stock_movement", "to_kind")} = 'service') = (${ref("stock_movement", "placement_id")} is not null))`,
    kindShape,
  ]),
  createTable("vehicle_allocation", "project", [
    ...WINDOW,
    '"vehicle_id" uuid NOT NULL',
    '"driver_id" uuid',
    '"trailer_id" uuid',
    '"depot_id" uuid',
    '"waste_fraction_id" uuid',
    '"required_capacity_kg" integer',
    `"status" text DEFAULT 'planned' NOT NULL`,
    '"note" text',
    uniqueKey("vehicle_allocation_project_key", "company_id", "project_id", "id"),
    `CONSTRAINT "vehicle_allocation_window" CHECK (${ref("vehicle_allocation", "planned_to")} > ${ref("vehicle_allocation", "planned_from")})`,
    oneOfCheck("vehicle_allocation", "status", "planned", "confirmed", "released"),
    positiveCheck("vehicle_allocation", "required_capacity_kg"),
  ]),
  createLedger("vehicle_allocation_event", [
    '"vehicle_allocation_id" uuid NOT NULL',
    '"action" text NOT NULL',
    '"status" text NOT NULL',
    '"vehicle_id" uuid NOT NULL',
    '"driver_id" uuid',
    '"trailer_id" uuid',
    '"depot_id" uuid',
    ...WINDOW,
    '"reason" text',
    '"recorded_by" uuid NOT NULL',
    oneOfCheck("vehicle_allocation_event", "action", "allocate", "change", "confirm", "release"),
    oneOfCheck("vehicle_allocation_event", "status", "planned", "confirmed", "released"),
  ]),
  companyFk("vehicle_type"),
  companyFk("container_type_vehicle_type"),
  tenantFk("container_type_vehicle_type", "container_type_id", "container_type"),
  tenantFk("container_type_vehicle_type", "vehicle_type_id", "vehicle_type"),
  companyFk("depot"),
  projectFk("depot"),
  tenantFk("depot", "service_provider_id", "service_provider"),
  companyFk("warehouse"),
  projectFk("warehouse"),
  projectFkTo("warehouse", "depot_id", "depot"),
  companyFk("unloading_station"),
  tenantFk("unloading_station", "service_provider_id", "service_provider"),
  companyFk("unloading_station_fraction"),
  tenantFk("unloading_station_fraction", "unloading_station_id", "unloading_station"),
  tenantFk("unloading_station_fraction", "waste_fraction_id", "waste_fraction"),
  companyFk("vehicle"),
  projectFk("vehicle"),
  tenantFk("vehicle", "vehicle_type_id", "vehicle_type"),
  tenantFk("vehicle", "service_provider_id", "service_provider"),
  projectFkTo("vehicle", "home_depot_id", "depot"),
  companyFk("vehicle_compartment"),
  projectFk("vehicle_compartment"),
  projectFkTo("vehicle_compartment", "vehicle_id", "vehicle"),
  companyFk("vehicle_compartment_fraction"),
  projectFk("vehicle_compartment_fraction"),
  projectFkTo("vehicle_compartment_fraction", "vehicle_compartment_id", "vehicle_compartment"),
  tenantFk("vehicle_compartment_fraction", "waste_fraction_id", "waste_fraction"),
  companyFk("driver"),
  projectFk("driver"),
  tenantFk("driver", "service_provider_id", "service_provider"),
  tenantFk("driver", "user_account_id", "user_account"),
  projectFkTo("driver", "home_depot_id", "depot"),
  companyFk("stock_movement"),
  projectFk("stock_movement"),
  projectFkTo("stock_movement", "container_id", "container"),
  projectFkTo("stock_movement", "from_warehouse_id", "warehouse"),
  projectFkTo("stock_movement", "to_warehouse_id", "warehouse"),
  // The placement of the container it moves, by both columns: container A is never issued into container B's placement.
  foreignKey("stock_movement", "stock_movement_container_id_placement_id_fk", ["company_id", "project_id", "container_id", "placement_id"], "container_service_placement", ["company_id", "project_id", "container_id", "id"]),
  tenantFk("stock_movement", "recorded_by", "user_account"),
  tenantFk("stock_movement", "corrects_movement_id", "stock_movement"),
  companyFk("vehicle_allocation"),
  projectFk("vehicle_allocation"),
  projectFkTo("vehicle_allocation", "vehicle_id", "vehicle"),
  projectFkTo("vehicle_allocation", "trailer_id", "vehicle"),
  projectFkTo("vehicle_allocation", "driver_id", "driver"),
  projectFkTo("vehicle_allocation", "depot_id", "depot"),
  tenantFk("vehicle_allocation", "waste_fraction_id", "waste_fraction"),
  companyFk("vehicle_allocation_event"),
  projectFk("vehicle_allocation_event"),
  projectFkTo("vehicle_allocation_event", "vehicle_allocation_id", "vehicle_allocation"),
  projectFkTo("vehicle_allocation_event", "vehicle_id", "vehicle"),
  projectFkTo("vehicle_allocation_event", "trailer_id", "vehicle"),
  projectFkTo("vehicle_allocation_event", "driver_id", "driver"),
  projectFkTo("vehicle_allocation_event", "depot_id", "depot"),
  tenantFk("vehicle_allocation_event", "recorded_by", "user_account"),
  index("container_type_vehicle_type", "container_type_vehicle_type_container_type_id_idx", "company_id", "container_type_id"),
  index("depot", "depot_service_provider_id_idx", "company_id", "service_provider_id"),
  index("warehouse", "warehouse_depot_id_idx", "company_id", "depot_id"),
  index("unloading_station", "unloading_station_service_provider_id_idx", "company_id", "service_provider_id"),
  index("unloading_station_fraction", "unloading_station_fraction_waste_fraction_id_idx", "company_id", "waste_fraction_id"),
  partialUniqueIndex("vehicle", "vehicle_callsign_idx", ["company_id", "callsign"], `${ref("vehicle", "callsign")} is not null`),
  index("vehicle", "vehicle_vehicle_type_id_idx", "company_id", "vehicle_type_id"),
  index("vehicle", "vehicle_service_provider_id_idx", "company_id", "service_provider_id"),
  index("vehicle", "vehicle_home_depot_id_idx", "company_id", "home_depot_id"),
  index("vehicle_compartment", "vehicle_compartment_project_id_idx", "company_id", "project_id"),
  index("vehicle_compartment_fraction", "vehicle_compartment_fraction_project_id_idx", "company_id", "project_id"),
  index("vehicle_compartment_fraction", "vehicle_compartment_fraction_waste_fraction_id_idx", "company_id", "waste_fraction_id"),
  partialUniqueIndex("driver", "driver_workforce_reference_idx", ["company_id", "workforce_reference"], `${ref("driver", "workforce_reference")} is not null`),
  partialUniqueIndex("driver", "driver_user_account_id_idx", ["company_id", "user_account_id"], `${ref("driver", "user_account_id")} is not null`),
  index("driver", "driver_service_provider_id_idx", "company_id", "service_provider_id"),
  index("driver", "driver_home_depot_id_idx", "company_id", "home_depot_id"),
  // The fold's one probe per container: the latest movement first.
  `CREATE INDEX "stock_movement_container_id_idx" ON "wms"."stock_movement" USING btree ("company_id","container_id","id" DESC NULLS LAST);`,
  index("stock_movement", "stock_movement_project_id_idx", "company_id", "project_id"),
  index("stock_movement", "stock_movement_from_warehouse_id_idx", "company_id", "from_warehouse_id"),
  index("stock_movement", "stock_movement_to_warehouse_id_idx", "company_id", "to_warehouse_id"),
  index("stock_movement", "stock_movement_placement_id_idx", "company_id", "placement_id"),
  index("stock_movement", "stock_movement_recorded_by_idx", "company_id", "recorded_by"),
  index("stock_movement", "stock_movement_corrects_movement_id_idx", "company_id", "corrects_movement_id"),
  index("vehicle_allocation", "vehicle_allocation_vehicle_id_idx", "company_id", "vehicle_id"),
  index("vehicle_allocation", "vehicle_allocation_trailer_id_idx", "company_id", "trailer_id"),
  index("vehicle_allocation", "vehicle_allocation_driver_id_idx", "company_id", "driver_id"),
  index("vehicle_allocation", "vehicle_allocation_depot_id_idx", "company_id", "depot_id"),
  index("vehicle_allocation", "vehicle_allocation_waste_fraction_id_idx", "company_id", "waste_fraction_id"),
  index("vehicle_allocation", "vehicle_allocation_project_id_planned_from_idx", "company_id", "project_id", "planned_from"),
  index("vehicle_allocation_event", "vehicle_allocation_event_project_id_idx", "company_id", "project_id"),
  index("vehicle_allocation_event", "vehicle_allocation_event_vehicle_allocation_id_idx", "company_id", "vehicle_allocation_id"),
  index("vehicle_allocation_event", "vehicle_allocation_event_vehicle_id_idx", "company_id", "vehicle_id"),
  index("vehicle_allocation_event", "vehicle_allocation_event_trailer_id_idx", "company_id", "trailer_id"),
  index("vehicle_allocation_event", "vehicle_allocation_event_driver_id_idx", "company_id", "driver_id"),
  index("vehicle_allocation_event", "vehicle_allocation_event_depot_id_idx", "company_id", "depot_id"),
  index("vehicle_allocation_event", "vehicle_allocation_event_recorded_by_idx", "company_id", "recorded_by"),
]

const TOKENS = ["rear-loader", "organic-sealed", "paper-compactor", "glass-crane", "vacuum-tanker"]

/** The two Planning tables and the one Registry table as the files that created them left them, and collection_group at the step between the two diffs. Other table objects of the same names are fine here, since nothing connects to a database. */
const routeSchemeAsOf0006 = wms.table(
  "route_scheme",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    name: text().notNull(),
    planningAreaId: uuid(),
    serviceType: text().notNull(),
    frequency: text().notNull(),
    serviceDays: text().array().notNull(),
    weekRotation: text(),
    plannedStartTime: time(),
    holidayPolicy: text().notNull().default("skip"),
    editPolicy: text().notNull().default("ask"),
    planAhead: boolean().notNull().default(true),
    status: text().notNull().default("draft"),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.planningAreaId], planningArea),
    projectKey(t),
    validPeriod(t),
    oneOf(t.serviceType, SERVICE_TYPES),
    oneOf(t.frequency, RECURRENCE_FREQUENCIES),
    subsetOf(t.serviceDays, SERVICE_DAYS),
    nonEmpty(t.serviceDays),
    oneOf(t.weekRotation, WEEK_ROTATIONS),
    oneOf(t.holidayPolicy, HOLIDAY_POLICIES),
    oneOf(t.editPolicy, SCHEME_EDIT_POLICIES),
    oneOf(t.status, ROUTE_SCHEME_STATUSES),
    check(tableObjectName(t.id.table, "week_rotation_shape", "routeScheme"), sql`(${t.frequency} = 'every-2-weeks') = (${t.weekRotation} is not null)`),
    tenantIndex(t, t.planningAreaId),
  ],
)

/** collection_group's own columns and checks as of 0006, less the vehicle type token, which the two states below add back in their spelling. */
const groupColumns = {
  ...id,
  ...projectScoped,
  ...timestamps,
  routeSchemeId: uuid().notNull(),
  name: text().notNull(),
  position: integer().notNull(),
  days: text().array().notNull(),
  stopSource: text().notNull(),
}
const groupKeys = (t: typeof collectionGroup._.columns) => [
  companyReference(t, company),
  tenantReference(t, [t.projectId], project),
  projectReference(t, [t.routeSchemeId], routeSchemeAsOf0006),
  tenantReference(t, [t.serviceProviderId], serviceProvider),
  tenantUnique(t, t.routeSchemeId, t.name),
  projectKey(t),
  subsetOf(t.days, SERVICE_DAYS),
  oneOf(t.stopSource, STOP_SOURCES),
  positive(t.position),
  tenantIndex(t, t.serviceProviderId),
]
const collectionGroupAsOf0006 = wms.table("collection_group", { ...groupColumns, ruleVehicleType: text(), serviceProviderId: uuid() }, (t) => [
  ...groupKeys(t as unknown as typeof collectionGroup._.columns),
  oneOf(t.ruleVehicleType, TOKENS),
  check(tableObjectName(t.id.table, "rule_shape", "collectionGroup"), sql`${t.stopSource} = 'rule' or ${t.ruleVehicleType} is null`),
])
const collectionGroupBetween = wms.table(
  "collection_group",
  { ...groupColumns, ruleVehicleType: text(), ruleVehicleTypeId: uuid(), serviceProviderId: uuid(), vehicleId: uuid(), driverId: uuid() },
  (t) => [
    ...groupKeys(t as unknown as typeof collectionGroup._.columns),
    tenantReference(t, [t.ruleVehicleTypeId], vehicleType),
    projectReference(t, [t.vehicleId], vehicle),
    projectReference(t, [t.driverId], driver),
    oneOf(t.ruleVehicleType, TOKENS),
    check(tableObjectName(t.id.table, "rule_shape", "collectionGroup"), sql`${t.stopSource} = 'rule' or ${t.ruleVehicleType} is null`),
    tenantIndex(t, t.ruleVehicleTypeId),
    tenantIndex(t, t.vehicleId),
    tenantIndex(t, t.driverId),
  ],
)
const containerServicePlacementAsOf0004 = wms.table(
  "container_service_placement",
  { ...id, ...projectScoped, ...timestamps, ...validity, containerId: uuid().notNull(), subscriptionId: uuid().notNull(), wasteFractionId: uuid().notNull(), serviceFrequencyId: uuid() },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.containerId], container),
    projectReference(t, [t.subscriptionId], subscription),
    projectReference(t, [t.serviceFrequencyId], serviceFrequency),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    validPeriod(t),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.subscriptionId),
    tenantIndex(t, t.wasteFractionId),
    tenantIndex(t, t.serviceFrequencyId),
  ],
)

/** What 0007 does to the three tables, in the two diffs: everything added, then the token dropped and its checks re-spelled. */
const altered = {
  added: [
    'DROP INDEX "wms"."container_service_placement_project_id_idx";',
    'ALTER TABLE "wms"."collection_group" ADD COLUMN "rule_vehicle_type_id" uuid;',
    'ALTER TABLE "wms"."collection_group" ADD COLUMN "vehicle_id" uuid;',
    'ALTER TABLE "wms"."collection_group" ADD COLUMN "driver_id" uuid;',
    'ALTER TABLE "wms"."route_scheme" ADD COLUMN "depot_id" uuid;',
    'ALTER TABLE "wms"."route_scheme" ADD COLUMN "unloading_station_id" uuid;',
    tenantFk("collection_group", "rule_vehicle_type_id", "vehicle_type"),
    projectFkTo("collection_group", "vehicle_id", "vehicle"),
    projectFkTo("collection_group", "driver_id", "driver"),
    projectFkTo("route_scheme", "depot_id", "depot"),
    tenantFk("route_scheme", "unloading_station_id", "unloading_station"),
    index("collection_group", "collection_group_rule_vehicle_type_id_idx", "company_id", "rule_vehicle_type_id"),
    index("collection_group", "collection_group_vehicle_id_idx", "company_id", "vehicle_id"),
    index("collection_group", "collection_group_driver_id_idx", "company_id", "driver_id"),
    index("route_scheme", "route_scheme_depot_id_idx", "company_id", "depot_id"),
    index("route_scheme", "route_scheme_unloading_station_id_idx", "company_id", "unloading_station_id"),
    'ALTER TABLE "wms"."container_service_placement" ADD CONSTRAINT "container_service_placement_container_id_project_key" UNIQUE("company_id","project_id","container_id","id");',
  ],
  dropped: [
    'ALTER TABLE "wms"."collection_group" DROP CONSTRAINT "collection_group_rule_vehicle_type_one_of";',
    'ALTER TABLE "wms"."collection_group" DROP CONSTRAINT "collection_group_rule_shape";',
    'ALTER TABLE "wms"."collection_group" DROP COLUMN "rule_vehicle_type";',
    `ALTER TABLE "wms"."collection_group" ADD CONSTRAINT "collection_group_rule_shape" CHECK (${ref("collection_group", "stop_source")} = 'rule' or ${ref("collection_group", "rule_vehicle_type_id")} is null);`,
  ],
}

/** Which allocations are live: every one not released; the window constraints ignore the rest. */
const LIVE = { live: { column: vehicleAllocation.status, not: "released" } }

/** What the thirteen tables owe their migration file, in the order migrations/README.md lays out: fence and trigger, or fence and revoke, table by table, then the window exclusion constraints. */
const handWritten = [
  ...Object.values(tables).flatMap((table) => handWrittenStatements(table)),
  ...excludeOverlappingWindow(vehicleAllocation, [vehicleAllocation.vehicleId], LIVE),
  ...excludeOverlappingWindow(vehicleAllocation, [vehicleAllocation.driverId], LIVE),
  ...excludeOverlappingWindow(vehicleAllocation, [vehicleAllocation.trailerId], LIVE),
]

/** The hand-written guard before the DROP COLUMN: a database that still holds a token on some row refuses to lose it, since 0007 does not backfill. */
const GUARD = `DO $$ BEGIN IF EXISTS (SELECT 1 FROM "wms"."collection_group" WHERE "rule_vehicle_type" IS NOT NULL) THEN RAISE EXCEPTION 'collection_group.rule_vehicle_type still holds a token on some row; map each onto a vehicle_type row (rule_vehicle_type_id) before dropping the column, since 0007 does not backfill'; END IF; END $$;`
const DROP_TOKEN = 'ALTER TABLE "wms"."collection_group" DROP COLUMN "rule_vehicle_type";'

/** The file's statements as the migrator runs them, and where the guard stands among them. */
async function fileStatements(): Promise<{ all: string[]; guardAt: number; withoutGuard: string[] }> {
  const all = statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))
  const guardAt = all.indexOf(normalised(GUARD))
  return { all, guardAt, withoutGuard: all.filter((_, at) => at !== guardAt) }
}

/** The ALTER TABLEs as the two diffs write them: the columns and keys added on the way to the step between, the token dropped from there. */
const generatedAlterations = async (): Promise<string[]> => [
  ...(await statementsBetween(
    { collectionGroup: collectionGroupAsOf0006, routeScheme: routeSchemeAsOf0006, containerServicePlacement: containerServicePlacementAsOf0004 },
    { collectionGroup: collectionGroupBetween, routeScheme, containerServicePlacement },
  )),
  ...(await statementsBetween({ collectionGroup: collectionGroupBetween }, { collectionGroup })),
]

/** Everything drizzle-kit wrote at the head of 0007: the thirteen tables and the three altered ones. */
const generatedHead = async (): Promise<string[]> => [...(await statementsFor(tables)), ...(await generatedAlterations())]

describe("the Resources tables as drizzle-kit writes them", () => {
  test("thirteen tables, every column, key, unique, check and partial index as the Domain model spells them, every name within 63 bytes", async () => {
    assert.deepEqual(await statementsFor(tables), expected)
  })

  test("collection_group gains its vehicle, driver and vehicle type and loses the token, route_scheme its depot and station, the placement its project key, in ALTER TABLE statements", async () => {
    assert.deepEqual(await generatedAlterations(), [...altered.added, ...altered.dropped])
  })

  test("migration 0007 begins with exactly what drizzle-kit generates for the schema, the guard aside: 125 statements", async () => {
    const { withoutGuard } = await fileStatements()
    // The same statements, whatever order drizzle-kit's loader gave the tables, and wherever the placement's key was moved to.
    const generated = (await generatedHead()).map(normalised).sort()
    assert.equal(generated.length, 125, "thirteen CREATE TABLE, five ADD COLUMN, one DROP INDEX, sixty foreign keys, forty-one indexes, one unique, two DROP CONSTRAINT, one DROP COLUMN, one check")
    assert.deepEqual([...withoutGuard.slice(0, generated.length)].sort(), generated)
  })

  test("and the placement's project key stands before the foreign key that points at it, the one generated statement out of drizzle-kit's order", async () => {
    const { all } = await fileStatements()
    const key = all.findIndex((statement) => statement.includes('"container_service_placement_container_id_project_key"'))
    const reference = all.findIndex((statement) => statement.includes('"stock_movement_container_id_placement_id_fk"'))
    assert.ok(key >= 0 && reference >= 0)
    assert.ok(key < reference, "Postgres needs the key before the reference")
  })

  test("and the guard against losing stored tokens stands once, before the DROP COLUMN, and fails the migration when a row holds one", async () => {
    const { all, guardAt } = await fileStatements()
    assert.ok(guardAt >= 0, "the guard is in the file, spelled as the test spells it")
    assert.equal(all.filter((statement) => statement.startsWith("DO $$")).length, 1, "once")
    const dropAt = all.indexOf(DROP_TOKEN)
    assert.ok(dropAt >= 0)
    assert.ok(guardAt < dropAt, "before the column goes")
    assert.match(GUARD, /RAISE EXCEPTION/)
    assert.match(GUARD, /"rule_vehicle_type" IS NOT NULL/)
  })

  test("and carries below them the fence and trigger, or revoke, of each table and the three window constraints: 13 x 3 + 3 = 42 statements", async () => {
    const { withoutGuard } = await fileStatements()
    const generated = await generatedHead()
    const tail = withoutGuard.slice(generated.length)
    assert.equal(tail.length, 42, "thirteen tables, each two fence statements and one trigger or revoke, then three exclusion constraints on the reservation")
    assert.deepEqual(tail, handWritten.map(normalised))
    assert.equal(tail.filter((statement) => statement.startsWith("REVOKE UPDATE, DELETE")).length, 2, "the two ledgers")
    assert.equal(tail.filter((statement) => statement.startsWith("CREATE TRIGGER")).length, 11, "every table but the ledgers")
  })
})

describe("the column sets and check of this context", () => {
  test("recorded is the one stamp of a ledger, window two given instants, as drizzle-kit writes them", async () => {
    const specimen = wms.table("specimen_recorded_window", { ...id, ...tenant, ...recorded, ...window }, (t) => [orderedWindow(t)])
    const [statement] = await statementsFor({ specimen })
    assert.equal(
      statement,
      [
        'CREATE TABLE "wms"."specimen_recorded_window" (',
        `\t${ID},`,
        `\t${COMPANY},`,
        `\t${RECORDED},`,
        `\t${WINDOW[0]},`,
        `\t${WINDOW[1]},`,
        `\tCONSTRAINT "specimen_recorded_window_window" CHECK (${ref("specimen_recorded_window", "planned_to")} > ${ref("specimen_recorded_window", "planned_from")})`,
        ");",
        "",
      ].join("\n"),
    )
    assert.deepEqual(Object.keys(recorded), ["recordedAt"])
    assert.deepEqual(Object.keys(window), ["plannedFrom", "plannedTo"])
  })

  test("the window columns read and write as Dates, like the timestamps", () => {
    for (const column of [vehicleAllocation.plannedFrom, vehicleAllocation.plannedTo, stockMovement.recordedAt, stockMovement.occurredAt]) {
      assert.deepEqual({ dataType: column.dataType, sqlType: column.getSQLType() }, { dataType: "date", sqlType: "timestamp with time zone" })
    }
  })

  test("orderedWindow names the check after the table and refuses a name Postgres would truncate", () => {
    assert.deepEqual([...checksOf(vehicleAllocation).keys()], ["vehicle_allocation_window", "vehicle_allocation_status_one_of", "vehicle_allocation_required_capacity_kg_positive"])
    const long = wms.table(`specimen_${"o".repeat(50)}`, { ...window }, (columns) => [orderedWindow(columns)])
    assert.throws(() => getTableConfig(long), /orderedWindow: "specimen_o{50}_window" is 66 bytes; Postgres would truncate it to 63 silently/)
  })

  test("the four shape checks and the CASE render without parameters, the way every check in a migration must", () => {
    const checks = checksOf(stockMovement)
    assert.deepEqual([...checks.keys()], ["stock_movement_kind_one_of", "stock_movement_from_kind_one_of", "stock_movement_to_kind_one_of", "stock_movement_from_shape", "stock_movement_to_shape", "stock_movement_placement_shape", "stock_movement_kind_shape"])
    assert.equal(`CONSTRAINT "stock_movement_kind_shape" CHECK (${checks.get("stock_movement_kind_shape")})`, kindShape)
  })
})

describe("the asset-state query", () => {
  test("assetStatus is a CASE over the domain's fold, place by place, null otherwise", () => {
    const dialect = new PgDialect({ casing: CASING })
    const query = dialect.sqlToQuery(assetStatus(stockMovement.toKind))
    assert.equal(query.sql, `case "wms"."stock_movement"."to_kind" when 'warehouse' then 'in-warehouse' when 'maintenance' then 'in-maintenance' when 'service' then 'in-service' when 'scrap' then 'retired' else null end`)
    assert.deepEqual(query.params, [])
  })

  test("assetStateOf is a LATERAL lookup of one container's latest movement — one probe per row, never a fold of the whole ledger", () => {
    // A mock database renders the statement and connects to nothing.
    const db = drizzle.mock({ casing: CASING })
    const companyId = "018f7c31-a000-7000-8000-000000000001"
    const state = assetStateOf(db, companyId, container.id)
    const { sql: text, params } = db
      .select({ id: container.id, status: assetStatus(state.toKind), warehouseId: state.toWarehouseId })
      .from(container)
      .leftJoinLateral(state, sql`true`)
      .where(eq(container.companyId, companyId))
      .toSQL()
    assert.equal(
      text,
      `select "wms"."container"."id", case "asset_state"."to_kind" when 'warehouse' then 'in-warehouse' when 'maintenance' then 'in-maintenance' when 'service' then 'in-service' when 'scrap' then 'retired' else null end, "asset_state"."to_warehouse_id" from "wms"."container" left join lateral (select "id", "to_kind", "to_warehouse_id", "placement_id", "occurred_at" from "wms"."stock_movement" where ("wms"."stock_movement"."company_id" = $1 and "wms"."stock_movement"."container_id" = "wms"."container"."id") order by "wms"."stock_movement"."id" desc limit $2) "${ASSET_STATE}" on true where "wms"."container"."company_id" = $3`,
    )
    assert.deepEqual(params, [companyId, 1, companyId])
  })
})
