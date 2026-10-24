// The `route` table as an earlier migration left it, for the rendering tests
// that diff an applied file's ALTER TABLEs from one era's spelling to the
// next: 0008 bare (Issue #104), 0012 with the run that last wrote it (Issue
// #97 part B), 0013 with the active Plan too (#169), 0015 with the hold too
// (#209), and 0016 with the scheme and the group nullable together (#111);
// today's, with the cancel's reason code too (O5 of #290, migration 0024), is
// src/schema/execution.ts itself. One spelling here, so
// generation-rendering.test.ts, routing-rendering.test.ts,
// route-hold-rendering.test.ts, ad-hoc-rendering.test.ts and
// route-cancel-reason-rendering.test.ts cannot drift on what an era said. Another table object of the same name is fine, since
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

/** The eras an applied file left the route in. */
type Era = "0008" | "0012" | "0013" | "0015" | "0016"

/** Whether the era is the given file's or a later one's: the eras are four-digit file numbers, so their text orders as they do. */
const since = (asOf: Era, file: Era): boolean => asOf >= file

// The conditional spreads make `generationRunId`, `activePlanId` and `heldAt` optional columns to TypeScript, which `PgTable`'s
// config cannot carry; the value is a perfectly ordinary table, so the one cast is here.
export const routeAsOf = (asOf: Era): PgTable =>
  routeTableAsOf(asOf) as unknown as PgTable

const routeTableAsOf = (asOf: Era) =>
  wms.table(
    "route",
    {
      ...id,
      ...projectScoped,
      ...timestamps,
      routeSchemeId: since(asOf, "0016") ? uuid() : uuid().notNull(),
      collectionGroupId: since(asOf, "0016") ? uuid() : uuid().notNull(),
      serviceDate: date().notNull(),
      operatingDate: date().notNull(),
      status: text().notNull().default("planned"),
      cancelledByGeneration: boolean().notNull().default(false),
      note: text(),
      ...(since(asOf, "0012") ? { generationRunId: uuid() } : {}),
      ...(since(asOf, "0013") ? { activePlanId: uuid() } : {}),
      number: integer().notNull(),
      plannedStartTime: time(),
      plannedVehicleId: uuid(),
      plannedDriverId: uuid(),
      plannedTrailerId: uuid(),
      depotId: uuid(),
      plannedServiceProviderId: uuid(),
      unloadingStationId: uuid(),
      ...(since(asOf, "0015") ? { heldAt: instant() } : {}),
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
      ...(since(asOf, "0015") ? [check(tableObjectName(t.id.table, "hold_shape", "route"), sql`${t.heldAt as (typeof t)["startedAt"]} is null or ${t.status} = 'planned'`)] : []),
      ...(since(asOf, "0016")
        ? [
            check(
              tableObjectName(t.id.table, "scheme_shape", "route"),
              sql`(${t.routeSchemeId} is null) = (${t.collectionGroupId} is null) and (${t.routeSchemeId} is not null or (${t.generationRunId as (typeof t)["id"]} is null and not ${t.cancelledByGeneration}))`,
            ),
          ]
        : []),
      ...(since(asOf, "0012") ? [projectReference(t, [t.generationRunId as (typeof t)["id"]], generationRun)] : []),
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
      ...(since(asOf, "0012") ? [tenantIndex(t, t.generationRunId as (typeof t)["id"])] : []),
      ...(since(asOf, "0013") ? [tenantIndex(t, t.activePlanId as (typeof t)["id"])] : []),
    ],
  )
