// Pre-trip inspection's three tables (O13 of #290) as 0075 created them and
// every migration until the one that dropped them still had them: a vehicle
// type's checklist items, the checks a driver appended (a ledger), and the
// defects a check found, with their audit trails as 0075 wrote them. The
// feature was removed with its tables, and an applied file is never edited, so
// the tests that read those files take the tables from here —
// pre-trip-rendering.test.ts holds 0075 to them, and
// pre-trip-removal-rendering.test.ts diffs from them to nothing.
import { sql } from "drizzle-orm"
import { boolean, check, index, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "../schema/access"
import { oneOf, positive } from "../schema/checks"
import { id, projectScoped, recorded, tenant, timestamps } from "../schema/columns"
import { route } from "../schema/execution"
import { driver, vehicle } from "../schema/fleet"
import { vehicleType } from "../schema/fleet-types"
import { geometry, validGeometry } from "../schema/geometry"
import { company, project } from "../schema/organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "../schema/references"
import { ticket } from "../schema/resolution"
import { wms } from "../schema/wms"
import type { Audited } from "../sql/audit-trail"

const instant = () => timestamp({ withTimezone: true })

/** Where a defect stood, as 0075 spelled it. */
export const VEHICLE_DEFECT_STATUSES_AS_OF_0075 = ["open", "resolved"] as const

export const preTripChecklistItemAsOf0075 = wms.table(
  "pre_trip_checklist_item",
  {
    ...id,
    ...tenant,
    ...timestamps,
    vehicleTypeId: uuid().notNull(),
    position: integer().notNull(),
    label: text().notNull(),
    critical: boolean().notNull(),
  },
  (t) => [companyReference(t, company), tenantReference(t, [t.vehicleTypeId], vehicleType), tenantUnique(t, t.vehicleTypeId, t.position), positive(t.position)],
)

export const preTripCheckAsOf0075 = wms.table(
  "pre_trip_check",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    routeId: uuid().notNull(),
    vehicleId: uuid().notNull(),
    driverId: uuid().notNull(),
    occurredAt: instant().notNull(),
    recordedBy: uuid().notNull(),
    deviceId: text().notNull(),
    items: jsonb().notNull(),
    defectCount: integer().notNull(),
    odometerKm: integer(),
    engineHours: integer(),
    location: geometry.point(),
    locationAccuracyM: integer(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.routeId], route),
    projectReference(t, [t.vehicleId], vehicle),
    projectReference(t, [t.driverId], driver),
    tenantReference(t, [t.recordedBy], userAccount),
    projectKey(t),
    validGeometry(t.location),
    positive(t.locationAccuracyM),
    check(tableObjectName(t.id.table, "readings_range", "preTripCheck"), sql`${t.defectCount} >= 0 and (${t.odometerKm} is null or ${t.odometerKm} >= 0) and (${t.engineHours} is null or ${t.engineHours} >= 0)`),
    index(tableObjectName(t.companyId.table, "vehicle_id_idx", "preTripCheck")).on(t.companyId, t.vehicleId, t.occurredAt),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.routeId),
    tenantIndex(t, t.driverId),
    tenantIndex(t, t.recordedBy),
  ],
)

export const vehicleDefectAsOf0075 = wms.table(
  "vehicle_defect",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    vehicleId: uuid().notNull(),
    preTripCheckId: uuid().notNull(),
    label: text().notNull(),
    critical: boolean().notNull(),
    note: text(),
    foundAt: instant().notNull(),
    status: text().notNull(),
    ticketId: uuid(),
    resolvedAt: instant(),
    resolvedBy: uuid(),
    resolutionNote: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.vehicleId], vehicle),
    projectReference(t, [t.preTripCheckId], preTripCheckAsOf0075),
    projectReference(t, [t.ticketId], ticket),
    tenantReference(t, [t.resolvedBy], userAccount),
    oneOf(t.status, VEHICLE_DEFECT_STATUSES_AS_OF_0075),
    check(tableObjectName(t.id.table, "resolution_shape", "vehicleDefect"), sql`(${t.status} = 'resolved') = (${t.resolvedAt} is not null)`),
    tenantIndex(t, t.vehicleId),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.preTripCheckId),
    tenantIndex(t, t.ticketId),
    tenantIndex(t, t.resolvedBy),
  ],
)

/** The audit trails 0075 wrote: the checklist a set under its type, master data; a vehicle's defects under the vehicle. The checks were a ledger, exempt. */
export const PRE_TRIP_AUDITED_AS_OF_0075: readonly Audited[] = [
  { table: preTripChecklistItemAsOf0075, module: "configure.master", parent: { table: vehicleType, column: preTripChecklistItemAsOf0075.vehicleTypeId } },
  { table: vehicleDefectAsOf0075, module: "fleet.vehicles", parent: { table: vehicle, column: vehicleDefectAsOf0075.vehicleId } },
]

/** A list of the receipt's kinds with `pre-trip-check` where 0075 put it, after `record-positions`: what 0075, 0092 and 0094 spelled, each from today's list less the kinds added after it. */
export const withPreTripCheck = <Kind extends string>(kinds: readonly Kind[]): (Kind | "pre-trip-check")[] => {
  const at = kinds.indexOf("record-positions" as Kind) + 1
  if (at === 0) throw new Error("record-positions is the kind pre-trip-check followed")
  return [...kinds.slice(0, at), "pre-trip-check", ...kinds.slice(at)]
}

/** A list of a ticket's kinds with `vehicle-defect` where 0075 put it, before `other`: what 0075 spelled into the four checks that read the list. */
export const withVehicleDefect = <Kind extends string>(kinds: readonly Kind[]): (Kind | "vehicle-defect")[] => {
  if (kinds.at(-1) !== "other") throw new Error("other is the kind vehicle-defect preceded")
  return [...kinds.slice(0, -1), "vehicle-defect", "other" as Kind]
}

/** The three, as `statementsFor` takes them. */
export const PRE_TRIP_TABLES_AS_OF_0075 = { preTripCheck: preTripCheckAsOf0075, preTripChecklistItem: preTripChecklistItemAsOf0075, vehicleDefect: vehicleDefectAsOf0075 }
