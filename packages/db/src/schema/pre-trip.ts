// Pre-trip inspection (O13 of #290): a vehicle type's checklist, the checks
// drivers make against it, and the defects a check finds.
//
// `pre_trip_checklist_item` is one item of a vehicle type's checklist, the
// company's master data beside the type's consumption: a label, whether a
// defect of it takes the vehicle out of service, and its place in the list,
// unique and safe because the set is replaced whole (`PUT
// /vehicle-types/:id/checklist`), each replacement minting new ids. Nothing
// references an item: a check copies what it answered.
//
// `pre_trip_check` is a ledger, appended by the driver door under the
// command's id (ADR-0004) and never rewritten: the route it was made for, the
// vehicle or the trailer, the driver, the device's instant, the readings, and
// the answers as one `jsonb` array — each item's label and weight copied
// beside what the driver said, since the list is the office's to change —
// kept for a reader and never queried by member, like the receipt's body.
// `defect_count` is the failed answers, the one figure a list reads of it.
// The vehicle is the route's project's, as the start rule takes it; its
// index leads with the vehicle and the instant, the order a vehicle's checks
// and its latest reading are read in.
//
// `vehicle_defect` is one failed item, current state with the trigger: open
// until the office marks it resolved — `resolved_at` given exactly then
// (`vehicle_defect_resolution_shape`) — naming the check that found it and
// the ticket the check opened for its defects.
import { VEHICLE_DEFECT_STATUSES } from "@waste/domain/resources/vocabulary"
import { sql } from "drizzle-orm"
import { boolean, check, index, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "./access"
import { oneOf, positive } from "./checks"
import { id, projectScoped, recorded, tenant, timestamps } from "./columns"
import { route } from "./execution"
import { driver, vehicle } from "./fleet"
import { vehicleType } from "./fleet-types"
import { geometry, validGeometry } from "./geometry"
import { company, project } from "./organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "./references"
import { ticket } from "./resolution"
import { wms } from "./wms"

const instant = () => timestamp({ withTimezone: true })

export const preTripChecklistItem = wms.table(
  "pre_trip_checklist_item",
  {
    ...id,
    ...tenant,
    ...timestamps,
    vehicleTypeId: uuid().notNull(),
    /** Its place in the list, 1..n; the set is replaced whole, so the unique on it is safe. */
    position: integer().notNull(),
    /** What the driver looks at: `Brakes`, `Lights and indicators`. */
    label: text().notNull(),
    /** Whether a defect of it sets the vehicle to maintenance. */
    critical: boolean().notNull(),
  },
  (t) => [companyReference(t, company), tenantReference(t, [t.vehicleTypeId], vehicleType), tenantUnique(t, t.vehicleTypeId, t.position), positive(t.position)],
)

export const preTripCheck = wms.table(
  "pre_trip_check",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    routeId: uuid().notNull(),
    vehicleId: uuid().notNull(),
    driverId: uuid().notNull(),
    /** The device's instant for the check. */
    occurredAt: instant().notNull(),
    /** The driver's account, whose command appended it. */
    recordedBy: uuid().notNull(),
    deviceId: text().notNull(),
    /** Each item answered: `{ itemId, label, critical, passed, note }`, in the checklist's order. */
    items: jsonb().notNull(),
    /** The answers that failed: the defects the check found. */
    defectCount: integer().notNull(),
    /** Whole kilometres, where the driver read the odometer. */
    odometerKm: integer(),
    /** Whole hours, where the vehicle counts them. */
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
    // A vehicle's checks in the order they were made, and its latest reading: leads with the vehicle, so it is the index the reference needs too.
    index(tableObjectName(t.companyId.table, "vehicle_id_idx", "preTripCheck")).on(t.companyId, t.vehicleId, t.occurredAt),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.routeId),
    tenantIndex(t, t.driverId),
    tenantIndex(t, t.recordedBy),
  ],
)

export const vehicleDefect = wms.table(
  "vehicle_defect",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    vehicleId: uuid().notNull(),
    preTripCheckId: uuid().notNull(),
    /** The item as the check answered it. */
    label: text().notNull(),
    critical: boolean().notNull(),
    /** What the driver saw. */
    note: text(),
    /** The check's instant. */
    foundAt: instant().notNull(),
    status: text().notNull(),
    /** The ticket the check opened for its defects. */
    ticketId: uuid(),
    resolvedAt: instant(),
    resolvedBy: uuid(),
    resolutionNote: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.vehicleId], vehicle),
    projectReference(t, [t.preTripCheckId], preTripCheck),
    projectReference(t, [t.ticketId], ticket),
    tenantReference(t, [t.resolvedBy], userAccount),
    oneOf(t.status, VEHICLE_DEFECT_STATUSES),
    check(tableObjectName(t.id.table, "resolution_shape", "vehicleDefect"), sql`(${t.status} = 'resolved') = (${t.resolvedAt} is not null)`),
    tenantIndex(t, t.vehicleId),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.preTripCheckId),
    tenantIndex(t, t.ticketId),
    tenantIndex(t, t.resolvedBy),
  ],
)
