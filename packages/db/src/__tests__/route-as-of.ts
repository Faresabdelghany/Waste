// The `route` table as an earlier migration left it, for the rendering tests
// that diff an applied file's ALTER TABLEs from one era's spelling to the
// next: 0008 bare (Issue #104), 0012 with the run that last wrote it (Issue
// #97 part B), today's with the active Plan too (#169, migration 0013 —
// that one is src/schema/execution.ts itself). One spelling here, so
// generation-rendering.test.ts and routing-rendering.test.ts cannot drift on
// what an era said. Another table object of the same name is fine, since
// nothing connects to a database. Not a suite of its own: only ever imported.
import { sql } from "drizzle-orm"
import { boolean, check, date, integer, text, time, timestamp, unique, uuid, type PgTable } from "drizzle-orm/pg-core"

import { ROUTE_STATUSES } from "@waste/domain/execution/vocabulary"

import { tableObjectName } from "../names"
import { oneOf } from "../schema/checks"
import { id, projectScoped, timestamps } from "../schema/columns"
import { driver, vehicle } from "../schema/fleet"
import { generationRun } from "../schema/generation"
import { company, project, serviceProvider } from "../schema/organisation"
import { depot, unloadingStation } from "../schema/places"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "../schema/references"
import { collectionGroup, routeScheme } from "../schema/route-schemes"
import { wms } from "../schema/wms"

const instant = () => timestamp({ withTimezone: true })

// The conditional spread makes `generationRunId` an optional column to TypeScript, which `PgTable`'s
// config cannot carry; the value is a perfectly ordinary table, so the one cast is here.
export const routeAsOf = (asOf: "0008" | "0012"): PgTable =>
  routeTableAsOf(asOf) as unknown as PgTable

const routeTableAsOf = (asOf: "0008" | "0012") =>
  wms.table(
    "route",
    {
      ...id,
      ...projectScoped,
      ...timestamps,
      routeSchemeId: uuid().notNull(),
      collectionGroupId: uuid().notNull(),
      serviceDate: date().notNull(),
      operatingDate: date().notNull(),
      status: text().notNull().default("planned"),
      cancelledByGeneration: boolean().notNull().default(false),
      note: text(),
      ...(asOf === "0012" ? { generationRunId: uuid() } : {}),
      number: integer().notNull(),
      plannedStartTime: time(),
      plannedVehicleId: uuid(),
      plannedDriverId: uuid(),
      plannedTrailerId: uuid(),
      depotId: uuid(),
      plannedServiceProviderId: uuid(),
      unloadingStationId: uuid(),
      actualVehicleId: uuid(),
      actualDriverId: uuid(),
      actualTrailerId: uuid(),
      dispatchedAt: instant(),
      startedAt: instant(),
      completedAt: instant(),
      cancelledAt: instant(),
    },
    (t) => [
      companyReference(t, company),
      tenantReference(t, [t.projectId], project),
      projectReference(t, [t.routeSchemeId], routeScheme),
      projectReference(t, [t.collectionGroupId], collectionGroup),
      projectReference(t, [t.plannedVehicleId], vehicle),
      projectReference(t, [t.plannedTrailerId], vehicle),
      projectReference(t, [t.plannedDriverId], driver),
      projectReference(t, [t.depotId], depot),
      tenantReference(t, [t.plannedServiceProviderId], serviceProvider),
      tenantReference(t, [t.unloadingStationId], unloadingStation),
      projectReference(t, [t.actualVehicleId], vehicle),
      projectReference(t, [t.actualTrailerId], vehicle),
      projectReference(t, [t.actualDriverId], driver),
      unique(tableObjectName(t.companyId.table, "generation_key", "route")).on(t.companyId, t.routeSchemeId, t.collectionGroupId, t.serviceDate),
      tenantUnique(t, t.number),
      projectKey(t),
      oneOf(t.status, ROUTE_STATUSES),
      check(
        tableObjectName(t.id.table, "actual_shape", "route"),
        sql`(${t.actualDriverId} is not null) = (${t.startedAt} is not null) and (${t.actualVehicleId} is not null) = (${t.startedAt} is not null) and (${t.actualTrailerId} is null or ${t.startedAt} is not null)`,
      ),
      check(
        tableObjectName(t.id.table, "stamps_shape", "route"),
        sql`case ${t.status} when 'planned' then ${t.dispatchedAt} is null and ${t.startedAt} is null and ${t.completedAt} is null and ${t.cancelledAt} is null when 'ready' then ${t.dispatchedAt} is not null and ${t.startedAt} is null and ${t.completedAt} is null and ${t.cancelledAt} is null when 'active' then ${t.dispatchedAt} is not null and ${t.startedAt} is not null and ${t.completedAt} is null and ${t.cancelledAt} is null when 'completed' then ${t.dispatchedAt} is not null and ${t.startedAt} is not null and ${t.completedAt} is not null and ${t.cancelledAt} is null when 'cancelled' then ${t.cancelledAt} is not null and ${t.completedAt} is null and (${t.startedAt} is null or ${t.dispatchedAt} is not null) else false end`,
      ),
      ...(asOf === "0012" ? [projectReference(t, [t.generationRunId as (typeof t)["id"]], generationRun)] : []),
      tenantIndex(t, t.collectionGroupId),
      tenantIndex(t, t.projectId, t.operatingDate),
      tenantIndex(t, t.plannedDriverId, t.status),
      tenantIndex(t, t.actualDriverId),
      tenantIndex(t, t.plannedVehicleId),
      tenantIndex(t, t.plannedTrailerId),
      tenantIndex(t, t.depotId),
      tenantIndex(t, t.plannedServiceProviderId),
      tenantIndex(t, t.unloadingStationId),
      tenantIndex(t, t.actualVehicleId),
      tenantIndex(t, t.actualTrailerId),
      ...(asOf === "0012" ? [tenantIndex(t, t.generationRunId as (typeof t)["id"])] : []),
    ],
  )
