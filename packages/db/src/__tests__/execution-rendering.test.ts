// The Execution tables (Issue #104, slice 1) as drizzle-kit writes them: the
// seven CREATE TABLE statements with their columns, keys, uniques, checks and
// partial indexes — three more ledgers, the two shape checks tying a route's
// columns to its status, the pickup's and the session's project keys that
// carry the route, the proof's CASE built from the domain's PROOF_SHAPES, the
// first jsonb columns, the second index without the tenant — and the ALTER
// TABLE that gives `company` its route-number counter; then migration 0008,
// which has to begin with exactly those statements, so the file and `pnpm
// db:generate` cannot drift apart, and to carry below them what the helpers
// write for each table — the fence and the trigger, or for the three ledgers
// the fence and the revoke — and then what is nobody's table, the sync role
// and the publication, verbatim from sql/publication.ts. No database.
//
// This is also what makes a change to the vocabulary or to PROOF_SHAPES a
// migration: the values and the CASE are spelled here as the file spells
// them, so adding a kind or moving a column in the domain fails this test
// until a migration replaces the check.
//
// Migration 0009 (Issue #109) changed one of the seven and the company once
// more: `outbox_event`'s two checks grew by Resolution's three kinds and its
// `ticket` aggregate, and `company` gained `next_ticket_number`; 0010 (Issue
// #112) grew the two checks again, by Finance's two kinds and its `invoice`
// and `settlement`, gave `unload` the project key the weight review points
// at, and gave `company` `next_invoice_number`. An applied file is never
// edited, so 0008 is held to the earlier spelling: `CHANGED_IN_0010` maps the
// outbox's CREATE TABLE as drizzle-kit writes it now onto what it wrote as of
// 0009 and the unload's onto what 0008 says, `CHANGED_IN_0009` maps the
// outbox's 0009 spelling onto 0008's, and the
// company's ALTER TABLE is diffed from 0002's spelling to 0008's rather than
// to today's, the way planning-rendering.test.ts holds 0006 to its own day.
// resolution-rendering.test.ts and finance-rendering.test.ts pin the
// replacements themselves. Migration 0012 (Issue #97 part B) changed `route`
// once more: the run that last wrote it, `generation_run_id`, with its key
// into `generation_run` and its index, so `CHANGED_IN_0012` maps the route's
// CREATE TABLE as drizzle-kit writes it now onto what 0008 says and
// `ADDED_IN_0012` is left out of the comparison; generation-rendering.test.ts
// pins the three statements themselves.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { PROOF_SHAPES } from "@waste/domain/execution/proof-shapes"
import { PICKUP_OUTCOMES, PICKUP_REASONS, PICKUP_STATUSES, PROOF_KINDS } from "@waste/domain/execution/vocabulary"
import { getTableName, is, sql } from "drizzle-orm"
import { check, integer, PgTable, text } from "drizzle-orm/pg-core"

import { MIGRATIONS_FOLDER } from "../migrate"
import { tableObjectName } from "../names"
import { API_ROLE, SYNC_ROLE } from "../roles"
import * as schema from "../schema"
import { oneOf } from "../schema/checks"
import { id, tenant, timestamps } from "../schema/columns"
import { driverCommand, outboxEvent, pickup, proofOfService, route, session, unload } from "../schema/execution"
import { COMPANY_STATUSES } from "../schema/organisation"
import { uniqueOn } from "../schema/references"
import { wms } from "../schema/wms"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { PUBLICATION, powersyncStatements, publicationStatement, SYNCED_TABLES, syncedTableNames, syncGrantStatements, syncRoleStatements } from "../sql/publication"
import { checksOf, companyFk, createTable, foreignKey, geometryCheck, ID, index, list, oneOfCheck, partialUniqueIndex, positiveCheck, projectFk, projectFkTo, ref, tenantFk, uniqueKey } from "./rendering"
import { statementsBetween, statementsFor } from "./specimen"

/** The seven tables in the order src/schema/execution.ts defines them; drizzle-kit's own loader sorts a module's exports, which the migration test allows for. */
const tables = { route, pickup, session, proofOfService, unload, driverCommand, outboxEvent }

const MIGRATION = "0008_execution.sql"
const COMPANY = '"company_id" uuid NOT NULL'
const PROJECT = '"project_id" uuid NOT NULL'
const RECORDED = '"recorded_at" timestamp with time zone DEFAULT now() NOT NULL'
const INSTANT = "timestamp with time zone"

/** A ledger's CREATE TABLE: id, tenant, project, the one stamp, then its own lines. */
const createLedger = (name: string, lines: string[]): string => [`CREATE TABLE "wms"."${name}" (`, [ID, COMPANY, PROJECT, RECORDED, ...lines].map((line) => `\t${line}`).join(",\n"), ");", ""].join("\n")

const REASONS = [...PICKUP_REASONS]
const STATUSES = [...PICKUP_STATUSES]
const SOURCES = ["driver-app", "dispatch", "integration"]

/** A FOREIGN KEY through the route: `(company_id, project_id, route_id, <column>) → target (company_id, project_id, route_id, id)`. */
const throughRouteFk = (table: string, column: string, target: string): string =>
  foreignKey(table, `${table}_route_id_${column}_fk`, ["company_id", "project_id", "route_id", column], target, ["company_id", "project_id", "route_id", "id"])

const sessionShape = (table: string): string => `CONSTRAINT "${table}_session_shape" CHECK ((${ref(table, "source")} = 'driver-app') = (${ref(table, "session_id")} is not null))`

/** The proof's kind CASE, spelled as the file spells it, kind by kind. */
const kindShape = (() => {
  const column = (name: string) => ref("proof_of_service", name)
  const none = (name: string) => `${column(name)} is null`
  const some = (name: string) => `${column(name)} is not null`
  const bare = [none("reason"), none("object_key"), none("weight_kg"), none("outcome")].join(" and ")
  const reasoned = [some("reason"), none("object_key"), none("weight_kg"), none("outcome")].join(" and ")
  const clauses = [
    `when 'arrival' then ${bare}`,
    `when 'completion' then ${bare}`,
    `when 'skip' then ${reasoned}`,
    `when 'failure' then ${reasoned}`,
    `when 'problem' then ${reasoned} and ${some("note")}`,
    `when 'route-started' then ${bare}`,
    `when 'route-ended' then ${bare}`,
    `when 'photo' then ${[none("reason"), some("object_key"), none("weight_kg"), none("outcome")].join(" and ")}`,
    `when 'weight' then ${[none("reason"), none("object_key"), some("weight_kg"), none("outcome")].join(" and ")}`,
    `when 'signature' then ${[none("reason"), some("object_key"), none("weight_kg"), none("outcome")].join(" and ")}`,
    `when 'note' then ${bare} and ${some("note")}`,
    `when 'correction' then ${[none("object_key"), none("weight_kg"), some("outcome"), some("note")].join(" and ")} and ${column("source")} = 'dispatch'`,
  ]
  return `CONSTRAINT "proof_of_service_kind_shape" CHECK (case ${column("kind")} ${clauses.join(" ")} else false end)`
})()

const stampsShape = (() => {
  const column = (name: string) => ref("route", name)
  const stamps = (dispatched: boolean, started: boolean, completed: boolean, cancelled: boolean) =>
    [
      `${column("dispatched_at")} is ${dispatched ? "not null" : "null"}`,
      `${column("started_at")} is ${started ? "not null" : "null"}`,
      `${column("completed_at")} is ${completed ? "not null" : "null"}`,
      `${column("cancelled_at")} is ${cancelled ? "not null" : "null"}`,
    ].join(" and ")
  return `CONSTRAINT "route_stamps_shape" CHECK (case ${column("status")} when 'planned' then ${stamps(false, false, false, false)} when 'ready' then ${stamps(true, false, false, false)} when 'active' then ${stamps(true, true, false, false)} when 'completed' then ${stamps(true, true, true, false)} when 'cancelled' then ${column("cancelled_at")} is not null and ${column("completed_at")} is null and (${column("started_at")} is null or ${column("dispatched_at")} is not null) else false end)`
})()

/**
 * outbox_event as drizzle-kit writes it at each of its spellings — the
 * outbox's vocabulary being the union of every context's news: as of 0008,
 * Execution's twelve kinds about four aggregates; as of 0009, Resolution's
 * three kinds and its ticket beside them (Issue #109); today, Finance's two
 * and its invoice and settlement after those (Issue #112).
 */
const outboxEventTable = (asOf: "0008" | "0009" | "0010"): string =>
  createTable("outbox_event", "project", [
    '"kind" text NOT NULL',
    '"aggregate_kind" text NOT NULL',
    '"aggregate_id" uuid NOT NULL',
    `"occurred_at" ${INSTANT} NOT NULL`,
    '"payload" jsonb NOT NULL',
    `"published_at" ${INSTANT}`,
    oneOfCheck(
      "outbox_event",
      "kind",
      "route-dispatched",
      "route-started",
      "route-completed",
      "route-cancelled",
      "route-reassigned",
      "pickup-completed",
      "pickup-failed",
      "pickup-skipped",
      "pickup-problem-reported",
      "pickup-corrected",
      "unload-recorded",
      "command-rejected",
      ...(asOf >= "0009" ? ["ticket-opened", "ticket-completed", "ticket-rejected"] : []),
      ...(asOf >= "0010" ? ["invoice-issued", "settlement-closed"] : []),
    ),
    oneOfCheck("outbox_event", "aggregate_kind", "route", "pickup", "unload", "command", ...(asOf >= "0009" ? ["ticket"] : []), ...(asOf >= "0010" ? ["invoice", "settlement"] : [])),
  ])

/** What 0009 changed on a table 0008 created: the outbox's CREATE TABLE as drizzle-kit generated it as of 0009, and as it generated it as of 0008. */
const CHANGED_IN_0009 = new Map([[outboxEventTable("0009"), outboxEventTable("0008")]])

/** unload as drizzle-kit writes it today — with the project key 0010 added for the weight review to point at (Issue #112), the day something pointed at it — and as it wrote it as of 0008, without. */
const unloadTable = (finance: boolean): string =>
  createLedger("unload", [
    '"route_id" uuid NOT NULL',
    '"session_id" uuid',
    '"unloading_station_id" uuid NOT NULL',
    '"waste_fraction_id" uuid NOT NULL',
    '"source" text NOT NULL',
    `"occurred_at" ${INSTANT} NOT NULL`,
    '"recorded_by" uuid NOT NULL',
    '"device_id" text',
    '"location" geometry(Point, 4326)',
    '"gross_kg" integer',
    '"tare_kg" integer',
    '"net_kg" integer NOT NULL',
    '"weighbridge_ticket" text',
    '"object_key" text',
    '"note" text',
    ...(finance ? [uniqueKey("unload_project_key", "company_id", "project_id", "id")] : []),
    oneOfCheck("unload", "source", ...SOURCES),
    geometryCheck("unload", "location"),
    positiveCheck("unload", "gross_kg"),
    positiveCheck("unload", "tare_kg"),
    positiveCheck("unload", "net_kg"),
    sessionShape("unload"),
    `CONSTRAINT "unload_weights_shape" CHECK ((${ref("unload", "gross_kg")} is null) = (${ref("unload", "tare_kg")} is null) and (${ref("unload", "gross_kg")} is null or ${ref("unload", "net_kg")} = ${ref("unload", "gross_kg")} - ${ref("unload", "tare_kg")}))`,
  ])

/** What 0010 changed on two of the seven (Issue #112): the outbox's CREATE TABLE as drizzle-kit generates it now onto what it generated as of 0009, and the unload's onto what 0008 says. Applied before `CHANGED_IN_0009`, so today's spelling is mapped back one file at a time. */
const CHANGED_IN_0010 = new Map([
  [outboxEventTable("0010"), outboxEventTable("0009")],
  [unloadTable(true), unloadTable(false)],
])

/** route as drizzle-kit wrote it as of each file: 0008 bare, 0012 with the run that last wrote it (Issue #97 part B), 0013 with the active Plan too (#169). */
const routeTable = (asOf: "0008" | "0012" | "0013"): string =>
  createTable("route", "project", [
    '"route_scheme_id" uuid NOT NULL',
    '"collection_group_id" uuid NOT NULL',
    '"service_date" date NOT NULL',
    '"operating_date" date NOT NULL',
    `"status" text DEFAULT 'planned' NOT NULL`,
    '"cancelled_by_generation" boolean DEFAULT false NOT NULL',
    '"note" text',
    ...(asOf === "0008" ? [] : ['"generation_run_id" uuid']),
    ...(asOf === "0013" ? ['"active_plan_id" uuid'] : []),
    '"number" integer NOT NULL',
    '"planned_start_time" time',
    '"planned_vehicle_id" uuid',
    '"planned_driver_id" uuid',
    '"planned_trailer_id" uuid',
    '"depot_id" uuid',
    '"planned_service_provider_id" uuid',
    '"unloading_station_id" uuid',
    '"actual_vehicle_id" uuid',
    '"actual_driver_id" uuid',
    '"actual_trailer_id" uuid',
    `"dispatched_at" ${INSTANT}`,
    `"started_at" ${INSTANT}`,
    `"completed_at" ${INSTANT}`,
    `"cancelled_at" ${INSTANT}`,
    uniqueKey("route_generation_key", "company_id", "route_scheme_id", "collection_group_id", "service_date"),
    uniqueKey("route_number_key", "company_id", "number"),
    uniqueKey("route_project_key", "company_id", "project_id", "id"),
    oneOfCheck("route", "status", "planned", "ready", "active", "completed", "cancelled"),
    `CONSTRAINT "route_actual_shape" CHECK ((${ref("route", "actual_driver_id")} is not null) = (${ref("route", "started_at")} is not null) and (${ref("route", "actual_vehicle_id")} is not null) = (${ref("route", "started_at")} is not null) and (${ref("route", "actual_trailer_id")} is null or ${ref("route", "started_at")} is not null))`,
    stampsShape,
  ])

/** What 0013 changed on one of the seven (#169): the route's CREATE TABLE as drizzle-kit generates it now onto what it generated as of 0012. Applied before `CHANGED_IN_0012`, one file at a time. */
const CHANGED_IN_0013 = new Map([[routeTable("0013"), routeTable("0012")]])

/** What 0013 added to the route beside the column: its index. The key into `plan` is hand-written (src/sql/active-plan.ts), so drizzle-kit never sees it. */
const ADDED_IN_0013 = [index("route", "route_active_plan_id_idx", "company_id", "active_plan_id")]

/** What 0012 changed on one of the seven (Issue #97 part B): the route's CREATE TABLE as of 0012 onto what 0008 says. */
const CHANGED_IN_0012 = new Map([[routeTable("0012"), routeTable("0008")]])

/** What 0012 added to the route beside the column: its key into the run and its index. 0008 begins with the generated statements less these. */
const ADDED_IN_0012 = [projectFkTo("route", "generation_run_id", "generation_run"), index("route", "route_generation_run_id_idx", "company_id", "generation_run_id")]

const expected = [
  routeTable("0013"),
  createTable("pickup", "project", [
    '"route_id" uuid NOT NULL',
    '"container_id" uuid NOT NULL',
    '"position" integer NOT NULL',
    `"status" text DEFAULT 'planned' NOT NULL`,
    '"note" text',
    '"property_id" uuid',
    '"shared_collection_point_id" uuid',
    '"waste_fraction_id" uuid NOT NULL',
    `"arrived_at" ${INSTANT}`,
    `"outcome_at" ${INSTANT}`,
    '"reason" text',
    uniqueKey("pickup_route_id_container_id_key", "company_id", "route_id", "container_id"),
    uniqueKey("pickup_route_id_project_key", "company_id", "project_id", "route_id", "id"),
    oneOfCheck("pickup", "status", ...STATUSES),
    oneOfCheck("pickup", "reason", ...REASONS),
    positiveCheck("pickup", "position"),
    `CONSTRAINT "pickup_place_exactly_one" CHECK ((${ref("pickup", "property_id")} is not null)::int + (${ref("pickup", "shared_collection_point_id")} is not null)::int = 1)`,
    `CONSTRAINT "pickup_outcome_shape" CHECK ((${ref("pickup", "status")} <> 'planned') = (${ref("pickup", "outcome_at")} is not null))`,
    `CONSTRAINT "pickup_reason_shape" CHECK ((${ref("pickup", "status")} in ('skipped', 'failed')) = (${ref("pickup", "reason")} is not null))`,
  ]),
  createTable("session", "project", [
    '"route_id" uuid NOT NULL',
    '"driver_id" uuid NOT NULL',
    '"vehicle_id" uuid NOT NULL',
    '"trailer_id" uuid',
    '"device_id" text NOT NULL',
    '"app_version" text',
    `"started_at" ${INSTANT} NOT NULL`,
    `"ended_at" ${INSTANT}`,
    `"paused_at" ${INSTANT}`,
    `"last_seen_at" ${INSTANT} NOT NULL`,
    uniqueKey("session_route_id_project_key", "company_id", "project_id", "route_id", "id"),
  ]),
  createLedger("proof_of_service", [
    '"route_id" uuid NOT NULL',
    '"pickup_id" uuid',
    '"session_id" uuid',
    '"kind" text NOT NULL',
    '"source" text NOT NULL',
    `"occurred_at" ${INSTANT} NOT NULL`,
    '"recorded_by" uuid NOT NULL',
    '"device_id" text',
    '"location" geometry(Point, 4326)',
    '"location_accuracy_m" integer',
    '"reason" text',
    '"note" text',
    '"weight_kg" integer',
    '"object_key" text',
    '"outcome" text',
    oneOfCheck("proof_of_service", "kind", ...PROOF_KINDS),
    oneOfCheck("proof_of_service", "source", ...SOURCES),
    oneOfCheck("proof_of_service", "reason", ...REASONS),
    oneOfCheck("proof_of_service", "outcome", ...PICKUP_OUTCOMES),
    geometryCheck("proof_of_service", "location"),
    positiveCheck("proof_of_service", "location_accuracy_m"),
    positiveCheck("proof_of_service", "weight_kg"),
    // A stop's kinds name a pickup, the route's two name none, and three may stand on the route alone.
    `CONSTRAINT "proof_of_service_pickup_shape" CHECK ((${ref("proof_of_service", "kind")} in (${list("arrival", "completion", "skip", "failure", "weight", "signature", "correction")}) and ${ref("proof_of_service", "pickup_id")} is not null) or (${ref("proof_of_service", "kind")} in (${list("route-started", "route-ended")}) and ${ref("proof_of_service", "pickup_id")} is null) or ${ref("proof_of_service", "kind")} in (${list("problem", "photo", "note")}))`,
    sessionShape("proof_of_service"),
    kindShape,
  ]),
  unloadTable(true),
  createLedger("driver_command", [
    // Nullable: a command rejected because no such route is assigned to the driver has no route the key could check, and is still a receipt.
    '"route_id" uuid',
    '"session_id" uuid',
    '"pickup_id" uuid',
    '"driver_id" uuid NOT NULL',
    '"device_id" text NOT NULL',
    '"kind" text NOT NULL',
    `"occurred_at" ${INSTANT} NOT NULL`,
    '"body" jsonb NOT NULL',
    '"outcome" text NOT NULL',
    '"problem" jsonb',
    oneOfCheck("driver_command", "kind", "start-route", "arrive", "complete-pickup", "skip-pickup", "fail-pickup", "report-problem", "add-photo", "add-weight", "add-signature", "add-note", "record-unload", "pause", "resume", "end-route"),
    oneOfCheck("driver_command", "outcome", "applied", "rejected"),
    `CONSTRAINT "driver_command_problem_shape" CHECK ((${ref("driver_command", "outcome")} = 'rejected') = (${ref("driver_command", "problem")} is not null))`,
    `CONSTRAINT "driver_command_route_shape" CHECK (${ref("driver_command", "route_id")} is not null or (${ref("driver_command", "outcome")} = 'rejected' and ${ref("driver_command", "session_id")} is null and ${ref("driver_command", "pickup_id")} is null))`,
  ]),
  outboxEventTable("0010"),
  companyFk("route"),
  projectFk("route"),
  projectFkTo("route", "route_scheme_id", "route_scheme"),
  projectFkTo("route", "collection_group_id", "collection_group"),
  projectFkTo("route", "planned_vehicle_id", "vehicle"),
  projectFkTo("route", "planned_trailer_id", "vehicle"),
  projectFkTo("route", "planned_driver_id", "driver"),
  projectFkTo("route", "depot_id", "depot"),
  tenantFk("route", "planned_service_provider_id", "service_provider"),
  tenantFk("route", "unloading_station_id", "unloading_station"),
  projectFkTo("route", "actual_vehicle_id", "vehicle"),
  projectFkTo("route", "actual_trailer_id", "vehicle"),
  projectFkTo("route", "actual_driver_id", "driver"),
  projectFkTo("route", "generation_run_id", "generation_run"),
  companyFk("pickup"),
  projectFk("pickup"),
  projectFkTo("pickup", "route_id", "route"),
  projectFkTo("pickup", "container_id", "container"),
  projectFkTo("pickup", "property_id", "property"),
  projectFkTo("pickup", "shared_collection_point_id", "shared_collection_point"),
  tenantFk("pickup", "waste_fraction_id", "waste_fraction"),
  companyFk("session"),
  projectFk("session"),
  projectFkTo("session", "route_id", "route"),
  projectFkTo("session", "driver_id", "driver"),
  projectFkTo("session", "vehicle_id", "vehicle"),
  projectFkTo("session", "trailer_id", "vehicle"),
  companyFk("proof_of_service"),
  projectFk("proof_of_service"),
  projectFkTo("proof_of_service", "route_id", "route"),
  // A pickup and a session of the route the proof names: the key carries the route on both sides.
  throughRouteFk("proof_of_service", "pickup_id", "pickup"),
  throughRouteFk("proof_of_service", "session_id", "session"),
  tenantFk("proof_of_service", "recorded_by", "user_account"),
  companyFk("unload"),
  projectFk("unload"),
  projectFkTo("unload", "route_id", "route"),
  throughRouteFk("unload", "session_id", "session"),
  tenantFk("unload", "unloading_station_id", "unloading_station"),
  tenantFk("unload", "waste_fraction_id", "waste_fraction"),
  tenantFk("unload", "recorded_by", "user_account"),
  companyFk("driver_command"),
  projectFk("driver_command"),
  projectFkTo("driver_command", "route_id", "route"),
  throughRouteFk("driver_command", "session_id", "session"),
  throughRouteFk("driver_command", "pickup_id", "pickup"),
  projectFkTo("driver_command", "driver_id", "driver"),
  companyFk("outbox_event"),
  projectFk("outbox_event"),
  index("route", "route_collection_group_id_idx", "company_id", "collection_group_id"),
  index("route", "route_project_id_operating_date_idx", "company_id", "project_id", "operating_date"),
  index("route", "route_planned_driver_id_status_idx", "company_id", "planned_driver_id", "status"),
  index("route", "route_actual_driver_id_idx", "company_id", "actual_driver_id"),
  index("route", "route_planned_vehicle_id_idx", "company_id", "planned_vehicle_id"),
  index("route", "route_planned_trailer_id_idx", "company_id", "planned_trailer_id"),
  index("route", "route_depot_id_idx", "company_id", "depot_id"),
  index("route", "route_planned_service_provider_id_idx", "company_id", "planned_service_provider_id"),
  index("route", "route_unloading_station_id_idx", "company_id", "unloading_station_id"),
  index("route", "route_actual_vehicle_id_idx", "company_id", "actual_vehicle_id"),
  index("route", "route_actual_trailer_id_idx", "company_id", "actual_trailer_id"),
  index("route", "route_generation_run_id_idx", "company_id", "generation_run_id"),
  index("route", "route_active_plan_id_idx", "company_id", "active_plan_id"),
  index("pickup", "pickup_project_id_idx", "company_id", "project_id"),
  index("pickup", "pickup_container_id_idx", "company_id", "container_id"),
  index("pickup", "pickup_property_id_idx", "company_id", "property_id"),
  index("pickup", "pickup_shared_collection_point_id_idx", "company_id", "shared_collection_point_id"),
  index("pickup", "pickup_waste_fraction_id_idx", "company_id", "waste_fraction_id"),
  index("pickup", "pickup_route_id_position_idx", "company_id", "route_id", "position"),
  // One live session per route and one per driver: the open rows alone are in the index.
  partialUniqueIndex("session", "session_route_open_idx", ["company_id", "route_id"], `${ref("session", "ended_at")} is null`),
  partialUniqueIndex("session", "session_driver_open_idx", ["company_id", "driver_id"], `${ref("session", "ended_at")} is null`),
  index("session", "session_project_id_idx", "company_id", "project_id"),
  index("session", "session_route_id_idx", "company_id", "route_id"),
  index("session", "session_driver_id_idx", "company_id", "driver_id"),
  index("session", "session_vehicle_id_idx", "company_id", "vehicle_id"),
  index("session", "session_trailer_id_idx", "company_id", "trailer_id"),
  // The route's timeline in recording order, leading with the route.
  index("proof_of_service", "proof_of_service_route_id_idx", "company_id", "route_id", "id"),
  index("proof_of_service", "proof_of_service_project_id_idx", "company_id", "project_id"),
  index("proof_of_service", "proof_of_service_pickup_id_idx", "company_id", "pickup_id"),
  index("proof_of_service", "proof_of_service_session_id_idx", "company_id", "session_id"),
  index("proof_of_service", "proof_of_service_recorded_by_idx", "company_id", "recorded_by"),
  index("unload", "unload_route_id_idx", "company_id", "route_id"),
  index("unload", "unload_session_id_idx", "company_id", "session_id"),
  index("unload", "unload_unloading_station_id_idx", "company_id", "unloading_station_id"),
  index("unload", "unload_waste_fraction_id_idx", "company_id", "waste_fraction_id"),
  index("unload", "unload_recorded_by_idx", "company_id", "recorded_by"),
  index("unload", "unload_project_id_occurred_at_idx", "company_id", "project_id", "occurred_at"),
  index("driver_command", "driver_command_project_id_idx", "company_id", "project_id"),
  index("driver_command", "driver_command_route_id_idx", "company_id", "route_id"),
  index("driver_command", "driver_command_pickup_id_idx", "company_id", "pickup_id"),
  // The driver's log in order — the sync rules' driver bucket's read — and a session's, each leading with its column.
  index("driver_command", "driver_command_driver_id_idx", "company_id", "driver_id", "id"),
  index("driver_command", "driver_command_session_id_idx", "company_id", "session_id", "id"),
  // The relay's read, across companies: the second index without the tenant after the hook's e-mail index, over id alone since published_at is null on every row in it.
  `CREATE INDEX "outbox_event_id_idx" ON "wms"."outbox_event" USING btree ("id") WHERE ${ref("outbox_event", "published_at")} is null;`,
  index("outbox_event", "outbox_event_project_id_idx", "company_id", "project_id"),
  index("outbox_event", "outbox_event_aggregate_id_idx", "company_id", "aggregate_id"),
]

/** The company table as 0002 left it, so `statementsBetween` can write the ALTER TABLE of 0008: the same columns as src/schema/organisation.ts had before Issue #104, less the counter. */
const companyAsOf0002 = wms.table(
  "company",
  {
    ...id,
    ...tenant,
    ...timestamps,
    name: text().notNull(),
    legalName: text().notNull(),
    registrationNumber: text().notNull(),
    country: text().notNull(),
    status: text().notNull(),
  },
  (t) => [uniqueOn(t.country, t.registrationNumber), check(tableObjectName(t.id.table, "self", "companySelf"), sql`${t.companyId} = ${t.id}`), oneOf(t.status, COMPANY_STATUSES)],
)

/** The company table as 0008 left it — the route-number counter and not yet the ticket-number counter 0009 added (Issue #109) — so the ALTER TABLE of 0008 diffs to its own day and not to today's. */
const companyAsOf0008 = wms.table(
  "company",
  {
    ...id,
    ...tenant,
    ...timestamps,
    name: text().notNull(),
    legalName: text().notNull(),
    registrationNumber: text().notNull(),
    country: text().notNull(),
    status: text().notNull(),
    nextRouteNumber: integer().notNull().default(1000),
  },
  (t) => [uniqueOn(t.country, t.registrationNumber), check(tableObjectName(t.id.table, "self", "companySelf"), sql`${t.companyId} = ${t.id}`), oneOf(t.status, COMPANY_STATUSES)],
)

/** What 0008 does to `company`: the counter, as one ALTER TABLE. */
const companyAltered = [`ALTER TABLE "wms"."company" ADD COLUMN "next_route_number" integer DEFAULT 1000 NOT NULL;`]

/** What the seven tables owe their migration file, in the order migrations/README.md lays out: fence and trigger, or fence and revoke, table by table; then the sync role and the publication. */
const handWritten = [...Object.values(tables).flatMap((table) => handWrittenStatements(table)), ...powersyncStatements()]

/** Everything drizzle-kit wrote at the head of 0008: the seven tables as they were generated as of 0008 — the outbox and the unload in their earlier spelling, the route without the run that last wrote it, what 0012 added left out — and the company altered from 0002's spelling to 0008's. */
const generatedHead = async (): Promise<string[]> => [
  ...(await statementsFor(tables))
    .filter((statement) => !ADDED_IN_0013.includes(statement) && !ADDED_IN_0012.includes(statement))
    .map((statement) => CHANGED_IN_0013.get(statement) ?? statement)
    .map((statement) => CHANGED_IN_0012.get(statement) ?? statement)
    .map((statement) => CHANGED_IN_0010.get(statement) ?? statement)
    .map((statement) => CHANGED_IN_0009.get(statement) ?? statement),
  ...(await statementsBetween({ company: companyAsOf0002 }, { company: companyAsOf0008 })),
]

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

describe("the Execution tables as drizzle-kit writes them", () => {
  test("seven tables, every column, key, unique, check and partial index as the Domain model spells them, every name within 63 bytes", async () => {
    assert.deepEqual(await statementsFor(tables), expected)
  })

  test("the company gains its route-number counter, defaulting to 1000, in one ALTER TABLE statement", async () => {
    assert.deepEqual(await statementsBetween({ company: companyAsOf0002 }, { company: companyAsOf0008 }), companyAltered)
  })

  test("migration 0008 begins with exactly what drizzle-kit generated for the schema as of 0008: 98 statements", async () => {
    const statements = await fileStatements()
    // The same statements, whatever order drizzle-kit's loader gave the tables (it sorts a module's exports), with the outbox spelled as it was then: an applied file is never edited.
    const generated = (await generatedHead()).map(normalised).sort()
    assert.equal(generated.length, 98, "seven CREATE TABLE, one ADD COLUMN, forty-seven foreign keys, forty-three indexes")
    assert.deepEqual([...statements.slice(0, generated.length)].sort(), generated)
    // The statement 0013 changed is one the schema generates today, and the one 0012 changed is what 0013 maps back to — each mapping maps something, one file at a time; the same chain for 0010 and 0009.
    const today = await statementsFor(tables)
    for (const statement of CHANGED_IN_0013.keys()) assert.ok(today.includes(statement), statement.split("\n")[0])
    for (const statement of ADDED_IN_0013) assert.ok(today.includes(statement), statement)
    for (const statement of CHANGED_IN_0012.keys()) assert.ok([...CHANGED_IN_0013.values()].includes(statement), statement.split("\n")[0])
    for (const statement of ADDED_IN_0012) assert.ok(today.includes(statement), statement)
    for (const statement of CHANGED_IN_0010.keys()) assert.ok(today.includes(statement), statement.split("\n")[0])
    for (const statement of CHANGED_IN_0009.keys()) assert.ok([...CHANGED_IN_0010.values()].includes(statement), statement.split("\n")[0])
    assert.equal(CHANGED_IN_0010.size, 2, "the outbox's vocabulary and the unload's key")
    assert.equal(CHANGED_IN_0012.size, 1, "the route's run")
    assert.equal(CHANGED_IN_0013.size, 1, "the route's active Plan")
  })

  test("and carries below them the fence and trigger, or revoke, of each table, then the sync role, its grants and the publication: 7 x 3 + 3 + 17 + 1 = 42 statements", async () => {
    const statements = await fileStatements()
    const generated = await generatedHead()
    const tail = statements.slice(generated.length)
    assert.equal(tail.length, 42)
    assert.deepEqual(tail, handWritten.map(normalised))
    assert.equal(tail.filter((statement) => statement.startsWith("REVOKE UPDATE, DELETE")).length, 3, "the three ledgers")
    assert.equal(tail.filter((statement) => statement.startsWith("CREATE TRIGGER")).length, 4, "every table but the ledgers")
    assert.equal(tail.filter((statement) => statement.startsWith("CREATE POLICY")).length, 7, "every table")
    assert.equal(tail.filter((statement) => statement.startsWith("GRANT SELECT ON")).length, SYNCED_TABLES.length)
    assert.equal(tail.filter((statement) => statement.startsWith("CREATE PUBLICATION")).length, 1)
  })
})

describe("the sync role and the publication", () => {
  test("wms_sync is created REPLICATION and BYPASSRLS and NOLOGIN, tolerating the race, granted to the owner, with USAGE on wms", () => {
    const [role, grant, usage] = syncRoleStatements()
    assert.equal(SYNC_ROLE, "wms_sync")
    assert.match(role, /IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'wms_sync'\)/)
    assert.match(role, /CREATE ROLE wms_sync NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION BYPASSRLS;/)
    assert.match(role, /WHEN duplicate_object OR unique_violation THEN/)
    assert.match(grant, /EXECUTE format\('GRANT wms_sync TO %I', current_user\);/)
    assert.equal(usage, "GRANT USAGE ON SCHEMA wms TO wms_sync;")
    for (const statement of powersyncStatements()) assert.equal(statement.includes(API_ROLE), false, "nothing here is the API role's")
  })

  test("the synced tables are the seventeen the sync rules read, each a table of the schema, each granted SELECT once, and the publication is over exactly them", () => {
    const names = syncedTableNames()
    assert.deepEqual(names, [
      "user_account",
      "waste_fraction",
      "container_type",
      "container",
      "property",
      "shared_collection_point",
      "depot",
      "unloading_station",
      "unloading_station_fraction",
      "vehicle",
      "driver",
      "route",
      "pickup",
      "session",
      "proof_of_service",
      "unload",
      "driver_command",
    ])
    const known = new Set<unknown>(Object.values(schema as Record<string, unknown>).filter((value) => is(value, PgTable)))
    for (const table of SYNCED_TABLES) assert.ok(known.has(table), getTableName(table))
    assert.deepEqual(
      syncGrantStatements(),
      names.map((name) => `GRANT SELECT ON "wms"."${name}" TO wms_sync;`),
    )
    assert.equal(publicationStatement(), `CREATE PUBLICATION ${PUBLICATION} FOR TABLE ${names.map((name) => `"wms"."${name}"`).join(", ")};`)
    assert.equal(PUBLICATION, "powersync")
  })
})

describe("the checks of this context", () => {
  test("the proof's CASE is built from the domain's PROOF_SHAPES, one WHEN per kind, and the pickup shape names the kinds that may stand on the route", () => {
    const checks = checksOf(proofOfService)
    assert.equal(`CONSTRAINT "proof_of_service_kind_shape" CHECK (${checks.get("proof_of_service_kind_shape")})`, kindShape)
    for (const kind of PROOF_KINDS) assert.ok(checks.get("proof_of_service_kind_shape")?.includes(`when '${kind}' then`), kind)
    assert.deepEqual(PROOF_KINDS.filter((kind) => PROOF_SHAPES[kind].pickup === "optional"), ["problem", "photo", "note"])
    assert.deepEqual(PROOF_KINDS.filter((kind) => PROOF_SHAPES[kind].pickup === "none"), ["route-started", "route-ended"])
    const pickupShape = checks.get("proof_of_service_pickup_shape") ?? ""
    assert.match(pickupShape, /in \('arrival', 'completion', 'skip', 'failure', 'weight', 'signature', 'correction'\) and .*"pickup_id" is not null/)
    assert.match(pickupShape, /in \('route-started', 'route-ended'\) and .*"pickup_id" is null/)
    assert.match(pickupShape, /or .*"kind" in \('problem', 'photo', 'note'\)$/)
  })

  test("every shape check of the seven tables renders without parameters, the way every check in a migration must", () => {
    assert.deepEqual([...checksOf(route).keys()], ["route_status_one_of", "route_actual_shape", "route_stamps_shape"])
    assert.deepEqual([...checksOf(pickup).keys()], ["pickup_status_one_of", "pickup_reason_one_of", "pickup_position_positive", "pickup_place_exactly_one", "pickup_outcome_shape", "pickup_reason_shape"])
    assert.deepEqual([...checksOf(unload).keys()].slice(-2), ["unload_session_shape", "unload_weights_shape"])
    assert.deepEqual([...checksOf(driverCommand).keys()], ["driver_command_kind_one_of", "driver_command_outcome_one_of", "driver_command_problem_shape", "driver_command_route_shape"])
    assert.deepEqual([...checksOf(outboxEvent).keys()], ["outbox_event_kind_one_of", "outbox_event_aggregate_kind_one_of"])
    assert.deepEqual([...checksOf(session).keys()], [], "open and ended are readings of ended_at; a session has no status to check")
  })

  test("the instants read and write as Dates, the days as strings, and the two jsonb columns as unknown", () => {
    for (const column of [route.startedAt, session.lastSeenAt, proofOfService.occurredAt, unload.occurredAt, driverCommand.occurredAt, outboxEvent.publishedAt]) {
      assert.deepEqual({ dataType: column.dataType, sqlType: column.getSQLType() }, { dataType: "date", sqlType: "timestamp with time zone" })
    }
    for (const column of [route.serviceDate, route.operatingDate]) assert.deepEqual({ dataType: column.dataType, sqlType: column.getSQLType() }, { dataType: "string", sqlType: "date" })
    for (const column of [driverCommand.body, driverCommand.problem, outboxEvent.payload]) assert.equal(column.getSQLType(), "jsonb")
  })
})
