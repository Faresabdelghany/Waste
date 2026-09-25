// The Resolution tables (Issue #109, slice 1) as drizzle-kit writes them: the
// three CREATE TABLE statements with their columns, keys, uniques, checks and
// partial indexes — the case with its six shape checks and the two keys that
// carry a route and the table's own project key, the history ledger with its
// CASE built from the domain's TICKET_EVENT_SHAPES and the two idempotency
// indexes, the alert with its subject and stamps checks — the ALTER TABLE
// that gives `company` its ticket-number counter, and the two ALTER TABLEs
// that replace the outbox's checks in their grown spelling; then migration
// 0009, which has to begin with exactly those statements, so the file and
// `pnpm db:generate` cannot drift apart, and to carry below them what the
// helpers write for each table — the fence and the trigger, or for the ledger
// the fence and the revoke. No database.
//
// This is also what makes a change to the vocabulary or to
// TICKET_EVENT_SHAPES a migration: the values and the CASE are spelled here
// as the file spells them, so adding a kind or moving a column in the domain
// fails this test until a migration replaces the check.
//
// Migration 0010 (Issue #112) changed the two altered tables once more: the
// outbox's checks grew by Finance's two kinds and its two aggregates, and
// `company` gained `next_invoice_number`. An applied file is never edited, so
// 0009's ALTER TABLEs are diffed from 0008's spelling to 0009's, both spelled
// here, and finance-rendering.test.ts pins 0010's own.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { TICKET_EVENT_SHAPES } from "@waste/domain/resolution/event-shapes"
import { TICKET_EVENT_KINDS } from "@waste/domain/resolution/vocabulary"
import { sql } from "drizzle-orm"
import { check, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core"

import { MIGRATIONS_FOLDER } from "../migrate"
import { tableObjectName } from "../names"
import { oneOf } from "../schema/checks"
import { id, projectScoped, tenant, timestamps } from "../schema/columns"
import { company, COMPANY_STATUSES, project } from "../schema/organisation"
import { companyReference, indexOn, tenantIndex, tenantReference, uniqueOn } from "../schema/references"
import { alert, ticket, ticketEvent } from "../schema/resolution"
import { wms } from "../schema/wms"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, companyFk, createTable, foreignKey, ID, index, list, oneOfCheck, partialUniqueIndex, projectFk, projectFkTo, ref, tenantFk, uniqueKey } from "./rendering"
import { statementsBetween, statementsFor } from "./specimen"

/** The three tables in the order src/schema/resolution.ts defines them; drizzle-kit's own loader sorts a module's exports, which the migration test allows for. */
const tables = { ticket, ticketEvent, alert }

const MIGRATION = "0009_resolution.sql"
const COMPANY = '"company_id" uuid NOT NULL'
const PROJECT = '"project_id" uuid NOT NULL'
const RECORDED = '"recorded_at" timestamp with time zone DEFAULT now() NOT NULL'
const INSTANT = "timestamp with time zone"

/** A ledger's CREATE TABLE: id, tenant, project, the one stamp, then its own lines. */
const createLedger = (name: string, lines: string[]): string => [`CREATE TABLE "wms"."${name}" (`, [ID, COMPANY, PROJECT, RECORDED, ...lines].map((line) => `\t${line}`).join(",\n"), ");", ""].join("\n")

const STATUSES = ["open", "in-progress", "pending", "on-hold", "completed", "rejected"]
const RESOLUTIONS = ["recollected", "serviced", "answered", "no-action", "duplicate"]

/** The history's kind CASE, spelled as the file spells it, kind by kind. */
const kindShape = (() => {
  const column = (name: string) => ref("ticket_event", name)
  const none = (name: string) => `${column(name)} is null`
  const internal = `${column("visibility")} = 'internal'`
  const clauses = [
    `when 'created' then ${none("body")} and ${none("object_key")} and ${internal} and ${none("resolution")}`,
    `when 'assigned' then ${none("object_key")} and ${internal} and ${none("resolution")}`,
    `when 'status-changed' then ${none("object_key")} and ${internal} and (${column("status")} = 'completed') = (${column("resolution")} is not null)`,
    `when 'comment' then ${column("body")} is not null and ${none("resolution")}`,
  ]
  return `CONSTRAINT "ticket_event_kind_shape" CHECK (case ${column("kind")} ${clauses.join(" ")} else false end)`
})()

const stampsShape = (() => {
  const column = (name: string) => ref("alert", name)
  return `CONSTRAINT "alert_stamps_shape" CHECK (case ${column("status")} when 'new' then ${column("acknowledged_at")} is null and ${column("resolved_at")} is null when 'acknowledged' then ${column("acknowledged_at")} is not null and ${column("resolved_at")} is null when 'resolved' then ${column("resolved_at")} is not null else false end)`
})()

const expected = [
  createTable("ticket", "project", [
    '"number" integer NOT NULL',
    '"kind" text NOT NULL',
    `"status" text DEFAULT 'open' NOT NULL`,
    `"priority" text DEFAULT 'none' NOT NULL`,
    '"source" text NOT NULL',
    '"subject" text NOT NULL',
    '"description" text NOT NULL',
    `"occurred_at" ${INSTANT} NOT NULL`,
    `"due_at" ${INSTANT}`,
    '"assignee_user_account_id" uuid',
    '"created_by" uuid',
    '"source_event_id" uuid',
    '"route_id" uuid',
    '"pickup_id" uuid',
    '"container_id" uuid',
    '"property_id" uuid',
    '"shared_collection_point_id" uuid',
    '"agreement_id" uuid',
    '"driver_id" uuid',
    '"customer_id" uuid',
    '"parent_ticket_id" uuid',
    '"resolution" text',
    '"recollection_route_id" uuid',
    `"closed_at" ${INSTANT}`,
    uniqueKey("ticket_number_key", "company_id", "number"),
    uniqueKey("ticket_project_key", "company_id", "project_id", "id"),
    oneOfCheck("ticket", "kind", "missed-collection", "overflow", "access-issue", "container-request", "container-defect", "proof-follow-up", "complaint", "reported-problem", "rejected-command", "internal-task", "other"),
    oneOfCheck("ticket", "status", ...STATUSES),
    oneOfCheck("ticket", "priority", "critical", "high", "medium", "low", "none"),
    oneOfCheck("ticket", "source", "office", "phone", "email", "portal", "driver-app", "dispatch", "import", "integration"),
    oneOfCheck("ticket", "resolution", ...RESOLUTIONS),
    `CONSTRAINT "ticket_origin_shape" CHECK ((${ref("ticket", "created_by")} is null) = (${ref("ticket", "source_event_id")} is not null))`,
    `CONSTRAINT "ticket_pickup_shape" CHECK (${ref("ticket", "pickup_id")} is null or ${ref("ticket", "route_id")} is not null)`,
    `CONSTRAINT "ticket_parent_shape" CHECK (${ref("ticket", "parent_ticket_id")} <> ${ref("ticket", "id")})`,
    `CONSTRAINT "ticket_resolution_shape" CHECK ((${ref("ticket", "status")} = 'completed') = (${ref("ticket", "resolution")} is not null))`,
    // `is not distinct from`: `null = 'recollected'` is null, and a null check passes.
    `CONSTRAINT "ticket_recollection_shape" CHECK (${ref("ticket", "recollection_route_id")} is null or ${ref("ticket", "resolution")} is not distinct from 'recollected')`,
    `CONSTRAINT "ticket_closed_shape" CHECK ((${ref("ticket", "status")} in ('completed', 'rejected')) = (${ref("ticket", "closed_at")} is not null))`,
  ]),
  createLedger("ticket_event", [
    '"ticket_id" uuid NOT NULL',
    '"kind" text NOT NULL',
    '"status" text NOT NULL',
    '"assignee_user_account_id" uuid',
    '"resolution" text',
    '"body" text',
    `"visibility" text DEFAULT 'internal' NOT NULL`,
    '"object_key" text',
    '"source_event_id" uuid',
    '"recorded_by" uuid',
    oneOfCheck("ticket_event", "kind", "created", "assigned", "status-changed", "comment"),
    oneOfCheck("ticket_event", "status", ...STATUSES),
    oneOfCheck("ticket_event", "resolution", ...RESOLUTIONS),
    oneOfCheck("ticket_event", "visibility", "internal", "customer"),
    kindShape,
  ]),
  createTable("alert", "project", [
    '"kind" text NOT NULL',
    '"severity" text NOT NULL',
    '"source" text NOT NULL',
    `"status" text DEFAULT 'new' NOT NULL`,
    '"title" text NOT NULL',
    '"details" text NOT NULL',
    `"detected_at" ${INSTANT} NOT NULL`,
    '"route_id" uuid',
    '"vehicle_id" uuid',
    '"driver_id" uuid',
    '"container_id" uuid',
    '"ticket_id" uuid',
    '"raised_by" uuid',
    `"acknowledged_at" ${INSTANT}`,
    '"acknowledged_by" uuid',
    `"resolved_at" ${INSTANT}`,
    '"resolved_by" uuid',
    '"resolution_note" text',
    oneOfCheck("alert", "kind", "route-exception", "resource", "service-risk", "asset", "weight", "other"),
    oneOfCheck("alert", "severity", "critical", "high", "medium", "low"),
    oneOfCheck("alert", "source", "manual", "execution", "telemetry", "rule"),
    oneOfCheck("alert", "status", "new", "acknowledged", "resolved"),
    `CONSTRAINT "alert_subject_shape" CHECK ((${ref("alert", "route_id")} is not null)::int + (${ref("alert", "vehicle_id")} is not null)::int + (${ref("alert", "driver_id")} is not null)::int + (${ref("alert", "container_id")} is not null)::int >= 1)`,
    `CONSTRAINT "alert_acknowledged_shape" CHECK ((${ref("alert", "acknowledged_at")} is null) = (${ref("alert", "acknowledged_by")} is null))`,
    `CONSTRAINT "alert_resolved_shape" CHECK ((${ref("alert", "resolved_at")} is null) = (${ref("alert", "resolved_by")} is null) and (${ref("alert", "resolution_note")} is null or ${ref("alert", "resolved_at")} is not null))`,
    stampsShape,
  ]),
  companyFk("ticket"),
  projectFk("ticket"),
  tenantFk("ticket", "assignee_user_account_id", "user_account"),
  tenantFk("ticket", "created_by", "user_account"),
  projectFkTo("ticket", "route_id", "route"),
  // A pickup of the route the ticket names: the key carries the route on both sides.
  foreignKey("ticket", "ticket_route_id_pickup_id_fk", ["company_id", "project_id", "route_id", "pickup_id"], "pickup", ["company_id", "project_id", "route_id", "id"]),
  projectFkTo("ticket", "container_id", "container"),
  projectFkTo("ticket", "property_id", "property"),
  projectFkTo("ticket", "shared_collection_point_id", "shared_collection_point"),
  projectFkTo("ticket", "agreement_id", "agreement"),
  projectFkTo("ticket", "driver_id", "driver"),
  tenantFk("ticket", "customer_id", "customer"),
  // The parent: a ticket of the same project, through the table's own project key.
  projectFkTo("ticket", "parent_ticket_id", "ticket"),
  projectFkTo("ticket", "recollection_route_id", "route"),
  companyFk("ticket_event"),
  projectFk("ticket_event"),
  projectFkTo("ticket_event", "ticket_id", "ticket"),
  tenantFk("ticket_event", "assignee_user_account_id", "user_account"),
  tenantFk("ticket_event", "recorded_by", "user_account"),
  companyFk("alert"),
  projectFk("alert"),
  projectFkTo("alert", "route_id", "route"),
  projectFkTo("alert", "vehicle_id", "vehicle"),
  projectFkTo("alert", "driver_id", "driver"),
  projectFkTo("alert", "container_id", "container"),
  projectFkTo("alert", "ticket_id", "ticket"),
  tenantFk("alert", "raised_by", "user_account"),
  tenantFk("alert", "acknowledged_by", "user_account"),
  tenantFk("alert", "resolved_by", "user_account"),
  // The consumer's first idempotency key: one ticket per outbox event, the rows with one alone in the index.
  partialUniqueIndex("ticket", "ticket_source_event_id_idx", ["company_id", "source_event_id"], `${ref("ticket", "source_event_id")} is not null`),
  // The queue and my tickets, each leading with its reference column.
  index("ticket", "ticket_project_id_status_idx", "company_id", "project_id", "status"),
  index("ticket", "ticket_assignee_user_account_id_status_idx", "company_id", "assignee_user_account_id", "status"),
  index("ticket", "ticket_created_by_idx", "company_id", "created_by"),
  index("ticket", "ticket_route_id_idx", "company_id", "route_id"),
  index("ticket", "ticket_pickup_id_idx", "company_id", "pickup_id"),
  index("ticket", "ticket_container_id_idx", "company_id", "container_id"),
  index("ticket", "ticket_property_id_idx", "company_id", "property_id"),
  index("ticket", "ticket_shared_collection_point_id_idx", "company_id", "shared_collection_point_id"),
  index("ticket", "ticket_agreement_id_idx", "company_id", "agreement_id"),
  index("ticket", "ticket_driver_id_idx", "company_id", "driver_id"),
  index("ticket", "ticket_customer_id_idx", "company_id", "customer_id"),
  index("ticket", "ticket_parent_ticket_id_idx", "company_id", "parent_ticket_id"),
  index("ticket", "ticket_recollection_route_id_idx", "company_id", "recollection_route_id"),
  // The second idempotency key: one comment per outbox event.
  partialUniqueIndex("ticket_event", "ticket_event_source_event_id_idx", ["company_id", "source_event_id"], `${ref("ticket_event", "source_event_id")} is not null`),
  // A ticket's history in recording order, leading with the ticket.
  index("ticket_event", "ticket_event_ticket_id_idx", "company_id", "ticket_id", "id"),
  index("ticket_event", "ticket_event_project_id_idx", "company_id", "project_id"),
  index("ticket_event", "ticket_event_assignee_user_account_id_idx", "company_id", "assignee_user_account_id"),
  index("ticket_event", "ticket_event_recorded_by_idx", "company_id", "recorded_by"),
  index("alert", "alert_project_id_status_idx", "company_id", "project_id", "status"),
  index("alert", "alert_route_id_idx", "company_id", "route_id"),
  index("alert", "alert_vehicle_id_idx", "company_id", "vehicle_id"),
  index("alert", "alert_driver_id_idx", "company_id", "driver_id"),
  index("alert", "alert_container_id_idx", "company_id", "container_id"),
  index("alert", "alert_ticket_id_idx", "company_id", "ticket_id"),
  index("alert", "alert_raised_by_idx", "company_id", "raised_by"),
  index("alert", "alert_acknowledged_by_idx", "company_id", "acknowledged_by"),
  index("alert", "alert_resolved_by_idx", "company_id", "resolved_by"),
]

/** The company table's columns as every file has left them but for the counters, and its keys, so `statementsBetween` can write the ALTER TABLE of 0009 from 0008's spelling to 0009's. Another table object of the same name is fine here, since nothing connects to a database. */
const companyColumns = {
  ...id,
  ...tenant,
  ...timestamps,
  name: text().notNull(),
  legalName: text().notNull(),
  registrationNumber: text().notNull(),
  country: text().notNull(),
  status: text().notNull(),
  nextRouteNumber: integer().notNull().default(1000),
}
const companyKeys = (t: typeof company._.columns) => [uniqueOn(t.country, t.registrationNumber), check(tableObjectName(t.id.table, "self", "companySelf"), sql`${t.companyId} = ${t.id}`), oneOf(t.status, COMPANY_STATUSES)]
/** The company as 0008 left it: the route-number counter and not yet the ticket-number counter. */
const companyAsOf0008 = wms.table("company", companyColumns, (t) => companyKeys(t as unknown as typeof company._.columns))
/** The company as 0009 left it: both counters, and not yet 0010's invoice-number counter (Issue #112), so the ALTER TABLE of 0009 diffs to its own day and not to today's. */
const companyAsOf0009 = wms.table("company", { ...companyColumns, nextTicketNumber: integer().notNull().default(1000) }, (t) => companyKeys(t as unknown as typeof company._.columns))

/** The outbox's vocabulary as of 0008: Execution's twelve kinds about four aggregates, before Resolution's three and its ticket. */
const EXECUTION_KINDS = ["route-dispatched", "route-started", "route-completed", "route-cancelled", "route-reassigned", "pickup-completed", "pickup-failed", "pickup-skipped", "pickup-problem-reported", "pickup-corrected", "unload-recorded", "command-rejected"]
const EXECUTION_AGGREGATES = ["route", "pickup", "unload", "command"]
/** What 0009 added: Resolution's three kinds and its ticket. */
const RESOLUTION_KINDS = ["ticket-opened", "ticket-completed", "ticket-rejected"]
const RESOLUTION_AGGREGATES = ["ticket"]

/** The outbox table as a file left it: the same columns, keys and indexes as src/schema/execution.ts, the two checks over the lists as they stood then. */
const outboxEventAsOf = (kinds: string[], aggregates: string[]) =>
  wms.table(
    "outbox_event",
    {
      ...id,
      ...projectScoped,
      ...timestamps,
      kind: text().notNull(),
      aggregateKind: text().notNull(),
      aggregateId: uuid().notNull(),
      occurredAt: timestamp({ withTimezone: true }).notNull(),
      payload: jsonb().notNull(),
      publishedAt: timestamp({ withTimezone: true }),
    },
    (t) => [
      companyReference(t, company),
      tenantReference(t, [t.projectId], project),
      oneOf(t.kind, kinds),
      oneOf(t.aggregateKind, aggregates),
      indexOn(t.id).where(sql`${t.publishedAt} is null`),
      tenantIndex(t, t.projectId),
      tenantIndex(t, t.aggregateId),
    ],
  )
/** The outbox as 0008 left it, and as 0009 left it — before 0010 grew the lists again by Finance's two kinds and its invoice and settlement (Issue #112), which finance-rendering.test.ts pins. */
const outboxEventAsOf0008 = outboxEventAsOf(EXECUTION_KINDS, EXECUTION_AGGREGATES)
const outboxEventAsOf0009 = outboxEventAsOf([...EXECUTION_KINDS, ...RESOLUTION_KINDS], [...EXECUTION_AGGREGATES, ...RESOLUTION_AGGREGATES])

/** What 0009 does beside the three tables: the counter, and the outbox's two checks dropped and added in their grown spelling. */
const altered = [
  'ALTER TABLE "wms"."outbox_event" DROP CONSTRAINT "outbox_event_kind_one_of";',
  'ALTER TABLE "wms"."outbox_event" DROP CONSTRAINT "outbox_event_aggregate_kind_one_of";',
  'ALTER TABLE "wms"."company" ADD COLUMN "next_ticket_number" integer DEFAULT 1000 NOT NULL;',
  `ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_kind_one_of" CHECK (${ref("outbox_event", "kind")} in (${list(...EXECUTION_KINDS, ...RESOLUTION_KINDS)}));`,
  `ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_aggregate_kind_one_of" CHECK (${ref("outbox_event", "aggregate_kind")} in (${list(...EXECUTION_AGGREGATES, ...RESOLUTION_AGGREGATES)}));`,
]

/** What the three tables owe their migration file, in the order migrations/README.md lays out: fence and trigger, or fence and revoke, table by table. */
const handWritten = Object.values(tables).flatMap((table) => handWrittenStatements(table))

/** The ALTER TABLEs as drizzle-kit wrote them: the company and the outbox from 0008's spelling to 0009's — not to today's, since 0010 changed both again (Issue #112) and an applied file is never edited. */
const generatedAlterations = (): Promise<string[]> => statementsBetween({ company: companyAsOf0008, outboxEvent: outboxEventAsOf0008 }, { company: companyAsOf0009, outboxEvent: outboxEventAsOf0009 })

/** Everything drizzle-kit wrote at the head of 0009: the three tables and the two altered ones. */
const generatedHead = async (): Promise<string[]> => [...(await statementsFor(tables)), ...(await generatedAlterations())]

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

describe("the Resolution tables as drizzle-kit writes them", () => {
  test("three tables, every column, key, unique, check and partial index as the Domain model spells them, every name within 63 bytes", async () => {
    assert.deepEqual(await statementsFor(tables), expected)
  })

  test("the company gains its ticket-number counter, defaulting to 1000, and the outbox's two checks are replaced in their grown spelling, in ALTER TABLE statements", async () => {
    assert.deepEqual(await generatedAlterations(), altered)
  })

  test("migration 0009 begins with exactly what drizzle-kit generates for the schema: 65 statements", async () => {
    const statements = await fileStatements()
    // The same statements, whatever order drizzle-kit's loader gave the tables (it sorts a module's exports).
    const generated = (await generatedHead()).map(normalised).sort()
    assert.equal(generated.length, 65, "three CREATE TABLE, one ADD COLUMN, two DROP CONSTRAINT, two ADD CONSTRAINT, twenty-nine foreign keys, twenty-eight indexes")
    assert.deepEqual([...statements.slice(0, generated.length)].sort(), generated)
  })

  test("and carries below them the fence and trigger, or revoke, of each table: 3 x 3 = 9 statements", async () => {
    const statements = await fileStatements()
    const generated = await generatedHead()
    const tail = statements.slice(generated.length)
    assert.equal(tail.length, 9)
    assert.deepEqual(tail, handWritten.map(normalised))
    assert.equal(tail.filter((statement) => statement.startsWith("REVOKE UPDATE, DELETE")).length, 1, "the history ledger")
    assert.equal(tail.filter((statement) => statement.startsWith("CREATE TRIGGER")).length, 2, "the case and the alert")
    assert.equal(tail.filter((statement) => statement.startsWith("CREATE POLICY")).length, 3, "every table")
  })
})

describe("the checks of this context", () => {
  test("the history's CASE is built from the domain's TICKET_EVENT_SHAPES, one WHEN per kind", () => {
    const checks = checksOf(ticketEvent)
    assert.equal(`CONSTRAINT "ticket_event_kind_shape" CHECK (${checks.get("ticket_event_kind_shape")})`, kindShape)
    for (const kind of TICKET_EVENT_KINDS) assert.ok(checks.get("ticket_event_kind_shape")?.includes(`when '${kind}' then`), kind)
    assert.deepEqual(TICKET_EVENT_KINDS.filter((kind) => TICKET_EVENT_SHAPES[kind].visibility === "any"), ["comment"])
    assert.deepEqual(TICKET_EVENT_KINDS.filter((kind) => TICKET_EVENT_SHAPES[kind].resolution === "with-completed"), ["status-changed"])
  })

  test("every shape check of the three tables renders without parameters, the way every check in a migration must", () => {
    assert.deepEqual([...checksOf(ticket).keys()], [
      "ticket_kind_one_of",
      "ticket_status_one_of",
      "ticket_priority_one_of",
      "ticket_source_one_of",
      "ticket_resolution_one_of",
      "ticket_origin_shape",
      "ticket_pickup_shape",
      "ticket_parent_shape",
      "ticket_resolution_shape",
      "ticket_recollection_shape",
      "ticket_closed_shape",
    ])
    assert.deepEqual([...checksOf(ticketEvent).keys()], ["ticket_event_kind_one_of", "ticket_event_status_one_of", "ticket_event_resolution_one_of", "ticket_event_visibility_one_of", "ticket_event_kind_shape"])
    assert.deepEqual([...checksOf(alert).keys()], ["alert_kind_one_of", "alert_severity_one_of", "alert_source_one_of", "alert_status_one_of", "alert_subject_shape", "alert_acknowledged_shape", "alert_resolved_shape", "alert_stamps_shape"])
  })

  test("the instants read and write as Dates, and the history is a ledger with the one stamp", () => {
    for (const column of [ticket.occurredAt, ticket.dueAt, ticket.closedAt, ticketEvent.recordedAt, alert.detectedAt, alert.acknowledgedAt, alert.resolvedAt]) {
      assert.deepEqual({ dataType: column.dataType, sqlType: column.getSQLType() }, { dataType: "date", sqlType: "timestamp with time zone" })
    }
    assert.equal("updatedAt" in ticketEvent, false, "a ledger row is never updated")
    assert.equal("recordedAt" in ticket, false)
    assert.equal(company.nextTicketNumber.getSQLType(), "integer")
  })
})
