// Vehicle allocations (Issue #101, ADR-0005 over instants): two tables,
// because the database is to hold "one vehicle reserved once per window" and
// a pure ledger cannot say which of its rows is superseded without an UPDATE.
//
// `vehicle_allocation` is the current reservation, one row per allocation,
// its window a `tstzrange` over `planned_from` and `planned_to` — instants,
// not days, since two routes a day on one vehicle is ordinary and a
// reservation without an end is not a plan — under three partial exclusion
// constraints in the migration (sql/exclude-overlapping-window.ts): over the
// vehicle, over the driver and over the trailer, each ignoring released rows,
// and the driver's and the trailer's keeping the nulls out of the index, so an
// allocation without a driver overlaps nothing on the driver's key. Postgres
// refuses with 23P01 naming which. The row is updated by the four commands
// and by nothing else, and every update appends an event in the same
// transaction. It names no work: no route (Execution's) and no collection
// group (Planning's, which references Resources and not the other way); the
// recurring reservation of a vehicle for a group is the group's own
// `vehicle_id`, and this is the dated one.
//
// `vehicle_allocation_event` is the append-only history: `allocate`,
// `change`, `confirm` and `release` each append one row carrying the action,
// the status after it, the snapshot the allocation then had — vehicle,
// driver, trailer, depot and window — a reason and who did it. It spreads
// `recorded` and no trigger, and its migration revokes UPDATE and DELETE from
// the API role (sql/append-only.ts). The snapshot's ids are real keys and not
// soft columns: nothing in this system is deleted (a vehicle is retired), so
// a key never makes history unreadable, and a soft uuid is a key nothing
// checks. Its window columns are a copy of a row that passed the reservation's
// check, so it spreads `window` without `orderedWindow` and the gate asks no
// exclusion constraint of it.
import { ALLOCATION_ACTIONS, ALLOCATION_STATUSES } from "@waste/domain/resources/vocabulary"
import { integer, text, uuid } from "drizzle-orm/pg-core"

import { userAccount } from "./access"
import { wasteFraction } from "./catalogue"
import { oneOf, positive } from "./checks"
import { id, orderedWindow, projectScoped, recorded, timestamps, window } from "./columns"
import { driver, vehicle } from "./fleet"
import { company, project } from "./organisation"
import { depot } from "./places"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference } from "./references"
import { wms } from "./wms"

export const vehicleAllocation = wms.table(
  "vehicle_allocation",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...window,
    vehicleId: uuid().notNull(),
    driverId: uuid(),
    /** A vehicle of kind `trailer`; the API holds the kind. */
    trailerId: uuid(),
    depotId: uuid(),
    /** What it is planned to carry. */
    wasteFractionId: uuid(),
    requiredCapacityKg: integer(),
    status: text().notNull().default("planned"),
    note: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.vehicleId], vehicle),
    projectReference(t, [t.trailerId], vehicle),
    projectReference(t, [t.driverId], driver),
    projectReference(t, [t.depotId], depot),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    projectKey(t),
    orderedWindow(t),
    oneOf(t.status, ALLOCATION_STATUSES),
    positive(t.requiredCapacityKg),
    tenantIndex(t, t.vehicleId),
    tenantIndex(t, t.trailerId),
    tenantIndex(t, t.driverId),
    tenantIndex(t, t.depotId),
    tenantIndex(t, t.wasteFractionId),
    // The planner's read: a project's allocations by when they start.
    tenantIndex(t, t.projectId, t.plannedFrom),
  ],
)

export const vehicleAllocationEvent = wms.table(
  "vehicle_allocation_event",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    vehicleAllocationId: uuid().notNull(),
    action: text().notNull(),
    /** The allocation's status after the action. */
    status: text().notNull(),
    /** The snapshot after the action: what the allocation then reserved, and when. */
    vehicleId: uuid().notNull(),
    driverId: uuid(),
    trailerId: uuid(),
    depotId: uuid(),
    ...window,
    reason: text(),
    /** The caller's account. */
    recordedBy: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.vehicleAllocationId], vehicleAllocation),
    projectReference(t, [t.vehicleId], vehicle),
    projectReference(t, [t.trailerId], vehicle),
    projectReference(t, [t.driverId], driver),
    projectReference(t, [t.depotId], depot),
    tenantReference(t, [t.recordedBy], userAccount),
    oneOf(t.action, ALLOCATION_ACTIONS),
    oneOf(t.status, ALLOCATION_STATUSES),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.vehicleAllocationId),
    tenantIndex(t, t.vehicleId),
    tenantIndex(t, t.trailerId),
    tenantIndex(t, t.driverId),
    tenantIndex(t, t.depotId),
    tenantIndex(t, t.recordedBy),
  ],
)
