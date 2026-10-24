// The ad-hoc Route and the extra Pickup (#111) as drizzle-kit writes them:
// the route's scheme and group nullable together under `route_scheme_shape`,
// the pickup's container nullable under `pickup_container_shape` with its
// `origin` backfilled by the default, and the ticket's re-collection stop
// with its key through the route, its index and its check — eleven ALTER
// TABLE and CREATE INDEX statements diffed from 0015's spelling of the three
// tables (route-as-of.ts and the two below) to the pickup as 0016 left it
// (pickup-as-of.ts, since 0023 gave it its service), since an applied file is never
// edited; execution-rendering.test.ts and resolution-rendering.test.ts map
// today's tables back (`CHANGED_IN_0016`). Then migration 0016, which is
// exactly those statements: no table is new, so nothing is hand-written —
// the fences and the triggers are the tables', and stand as 0008 and 0009
// wrote them — and no statement drops or rewrites a value, so the file needs
// no 0007-style guard (its own header says why). No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { PICKUP_ORIGINS, PICKUP_REASONS, PICKUP_STATUSES } from "@waste/domain/execution/vocabulary"
import { TICKET_KINDS, TICKET_PRIORITIES, TICKET_RESOLUTIONS, TICKET_SOURCES, TICKET_STATUSES } from "@waste/domain/resolution/vocabulary"
import { sql } from "drizzle-orm"
import { check, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"

import { MIGRATIONS_FOLDER } from "../migrate"
import { tableObjectName } from "../names"
import { userAccount } from "../schema/access"
import { agreement } from "../schema/agreements"
import { wasteFraction } from "../schema/catalogue"
import { exactlyOne, oneOf, positive } from "../schema/checks"
import { id, projectScoped, timestamps } from "../schema/columns"
import { container } from "../schema/containers"
import { customer, property, sharedCollectionPoint } from "../schema/customers"
import { pickup, route } from "../schema/execution"
import { driver } from "../schema/fleet"
import { company, project } from "../schema/organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique, type ProjectTable } from "../schema/references"
import { ticket } from "../schema/resolution"
import { wms } from "../schema/wms"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, list, ref } from "./rendering"
import { pickupAsOf0016 } from "./pickup-as-of"
import { routeAsOf } from "./route-as-of"
import { statementsBetween } from "./specimen"

const MIGRATION = "0016_ad_hoc_routes.sql"

const instant = () => timestamp({ withTimezone: true })

/** pickup as 0008 left it and 0015 still had it: a container on every stop, and no origin. */
const pickupAsOf0015 = wms.table(
  "pickup",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    routeId: uuid().notNull(),
    containerId: uuid().notNull(),
    position: integer().notNull(),
    status: text().notNull().default("planned"),
    note: text(),
    propertyId: uuid(),
    sharedCollectionPointId: uuid(),
    wasteFractionId: uuid().notNull(),
    arrivedAt: instant(),
    outcomeAt: instant(),
    reason: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.routeId], route),
    projectReference(t, [t.containerId], container),
    projectReference(t, [t.propertyId], property),
    projectReference(t, [t.sharedCollectionPointId], sharedCollectionPoint),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    tenantUnique(t, t.routeId, t.containerId),
    projectKey(t, t.routeId),
    oneOf(t.status, PICKUP_STATUSES),
    oneOf(t.reason, PICKUP_REASONS),
    positive(t.position),
    exactlyOne(t, "place", [t.propertyId, t.sharedCollectionPointId]),
    check(tableObjectName(t.id.table, "outcome_shape", "pickup"), sql`(${t.status} <> 'planned') = (${t.outcomeAt} is not null)`),
    check(tableObjectName(t.id.table, "reason_shape", "pickup"), sql`(${t.status} in ('skipped', 'failed')) = (${t.reason} is not null)`),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.containerId),
    tenantIndex(t, t.propertyId),
    tenantIndex(t, t.sharedCollectionPointId),
    tenantIndex(t, t.wasteFractionId),
    tenantIndex(t, t.routeId, t.position),
  ],
)

/** ticket as 0009 left it and 0015 still had it: the re-collection's route, and no stop of it. */
const ticketAsOf0015 = wms.table(
  "ticket",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    number: integer().notNull(),
    kind: text().notNull(),
    status: text().notNull().default("open"),
    priority: text().notNull().default("none"),
    source: text().notNull(),
    subject: text().notNull(),
    description: text().notNull(),
    occurredAt: instant().notNull(),
    dueAt: instant(),
    assigneeUserAccountId: uuid(),
    createdBy: uuid(),
    sourceEventId: uuid(),
    routeId: uuid(),
    pickupId: uuid(),
    containerId: uuid(),
    propertyId: uuid(),
    sharedCollectionPointId: uuid(),
    agreementId: uuid(),
    driverId: uuid(),
    customerId: uuid(),
    parentTicketId: uuid(),
    resolution: text(),
    recollectionRouteId: uuid(),
    closedAt: instant(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.assigneeUserAccountId], userAccount),
    tenantReference(t, [t.createdBy], userAccount),
    projectReference(t, [t.routeId], route),
    projectReference(t, [t.routeId, t.pickupId], pickup, [pickup.routeId, pickup.id]),
    projectReference(t, [t.containerId], container),
    projectReference(t, [t.propertyId], property),
    projectReference(t, [t.sharedCollectionPointId], sharedCollectionPoint),
    projectReference(t, [t.agreementId], agreement),
    projectReference(t, [t.driverId], driver),
    tenantReference(t, [t.customerId], customer),
    projectReference(t, [t.parentTicketId], t as ProjectTable),
    projectReference(t, [t.recollectionRouteId], route),
    tenantUnique(t, t.number),
    projectKey(t),
    oneOf(t.kind, TICKET_KINDS),
    oneOf(t.status, TICKET_STATUSES),
    oneOf(t.priority, TICKET_PRIORITIES),
    oneOf(t.source, TICKET_SOURCES),
    oneOf(t.resolution, TICKET_RESOLUTIONS),
    check(tableObjectName(t.id.table, "origin_shape", "ticket"), sql`(${t.createdBy} is null) = (${t.sourceEventId} is not null)`),
    check(tableObjectName(t.id.table, "pickup_shape", "ticket"), sql`${t.pickupId} is null or ${t.routeId} is not null`),
    check(tableObjectName(t.id.table, "parent_shape", "ticket"), sql`${t.parentTicketId} <> ${t.id}`),
    check(tableObjectName(t.id.table, "resolution_shape", "ticket"), sql`(${t.status} = 'completed') = (${t.resolution} is not null)`),
    check(tableObjectName(t.id.table, "recollection_shape", "ticket"), sql`${t.recollectionRouteId} is null or ${t.resolution} is not distinct from 'recollected'`),
    check(tableObjectName(t.id.table, "closed_shape", "ticket"), sql`(${t.status} in ('completed', 'rejected')) = (${t.closedAt} is not null)`),
    uniqueIndex(tableObjectName(t.companyId.table, "source_event_id_idx", "ticket")).on(t.companyId, t.sourceEventId).where(sql`${t.sourceEventId} is not null`),
    tenantIndex(t, t.projectId, t.status),
    tenantIndex(t, t.assigneeUserAccountId, t.status),
    tenantIndex(t, t.createdBy),
    tenantIndex(t, t.routeId),
    tenantIndex(t, t.pickupId),
    tenantIndex(t, t.containerId),
    tenantIndex(t, t.propertyId),
    tenantIndex(t, t.sharedCollectionPointId),
    tenantIndex(t, t.agreementId),
    tenantIndex(t, t.driverId),
    tenantIndex(t, t.customerId),
    tenantIndex(t, t.parentTicketId),
    tenantIndex(t, t.recollectionRouteId),
  ],
)

/** The scheme shape as the route's check spells it: the scheme and the group together, or neither and no run's. */
const SCHEME_SHAPE = `(${ref("route", "route_scheme_id")} is null) = (${ref("route", "collection_group_id")} is null) and (${ref("route", "route_scheme_id")} is not null or (${ref("route", "generation_run_id")} is null and not ${ref("route", "cancelled_by_generation")}))`

/** What 0016 does, in drizzle-kit's order — statement kind by kind, table by table: the three NOT NULLs relaxed, the two columns, the ticket's key and index, then the four checks. */
const altered = [
  'ALTER TABLE "wms"."pickup" ALTER COLUMN "container_id" DROP NOT NULL;',
  'ALTER TABLE "wms"."route" ALTER COLUMN "route_scheme_id" DROP NOT NULL;',
  'ALTER TABLE "wms"."route" ALTER COLUMN "collection_group_id" DROP NOT NULL;',
  `ALTER TABLE "wms"."pickup" ADD COLUMN "origin" text DEFAULT 'generation' NOT NULL;`,
  'ALTER TABLE "wms"."ticket" ADD COLUMN "recollection_pickup_id" uuid;',
  'ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_recollection_route_id_recollection_pickup_id_fk" FOREIGN KEY ("company_id","project_id","recollection_route_id","recollection_pickup_id") REFERENCES "wms"."pickup"("company_id","project_id","route_id","id") ON DELETE no action ON UPDATE no action;',
  'CREATE INDEX "ticket_recollection_pickup_id_idx" ON "wms"."ticket" USING btree ("company_id","recollection_pickup_id");',
  `ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_origin_one_of" CHECK (${ref("pickup", "origin")} in (${list(...PICKUP_ORIGINS)}));`,
  `ALTER TABLE "wms"."pickup" ADD CONSTRAINT "pickup_container_shape" CHECK (${ref("pickup", "container_id")} is not null or ${ref("pickup", "origin")} = 'office');`,
  `ALTER TABLE "wms"."route" ADD CONSTRAINT "route_scheme_shape" CHECK (${SCHEME_SHAPE});`,
  `ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_recollection_pickup_shape" CHECK (${ref("ticket", "recollection_pickup_id")} is null or ${ref("ticket", "recollection_route_id")} is not null);`,
]

/** The statements as drizzle-kit writes them: the three tables from 0015's spelling to today's, in the order its loader takes a module's exports, sorted. */
const generatedAlterations = (): Promise<string[]> => statementsBetween({ pickup: pickupAsOf0015, route: routeAsOf("0015"), ticket: ticketAsOf0015 }, { pickup: pickupAsOf0016, route, ticket })

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

describe("the ad-hoc route and the extra pickup as drizzle-kit writes them", () => {
  test("the route's scheme and group and the pickup's container are relaxed, each under the check that says which rows may hold the null; the pickup gains its origin and the ticket its re-collection stop", async () => {
    assert.deepEqual(await generatedAlterations(), altered)
  })

  test("migration 0016 is exactly that, and nothing hand-written: no table is new, and no value is dropped or rewritten for a guard to prove", async () => {
    const statements = await fileStatements()
    assert.deepEqual(statements, altered.map(normalised))
    assert.equal(statements.filter((statement) => statement.startsWith("DO ")).length, 0)
  })

  test("the origin defaults to generation — the backfill of every pickup before 0016 — and its four checks render without parameters", () => {
    assert.deepEqual({ notNull: pickup.origin.notNull, default: pickup.origin.default }, { notNull: true, default: "generation" })
    assert.deepEqual({ scheme: route.routeSchemeId.notNull, group: route.collectionGroupId.notNull, container: pickup.containerId.notNull }, { scheme: false, group: false, container: false })
    assert.equal(checksOf(route).get("route_scheme_shape"), SCHEME_SHAPE)
    assert.equal(checksOf(pickup).get("pickup_container_shape"), `${ref("pickup", "container_id")} is not null or ${ref("pickup", "origin")} = 'office'`)
    assert.equal(checksOf(ticket).get("ticket_recollection_pickup_shape"), `${ref("ticket", "recollection_pickup_id")} is null or ${ref("ticket", "recollection_route_id")} is not null`)
  })
})
