// When a driver or a vehicle is not there (O6 of #290, ADR-0005 over days):
// `driver_absence` and `vehicle_unavailability` are dated periods, each a
// `validity` — `valid_from` the first day away, `valid_to` the first day
// back, null while the return is not known — under its `validPeriod` check
// and an exclusion constraint over the driver or the vehicle (the migration,
// sql/exclude-overlapping.ts), so one period of a driver, or of a vehicle,
// covers a day. A vehicle here is either kind, a powered vehicle or a
// trailer. Each carries why (`reason`, a closed token of
// @waste/domain/resources/vocabulary) and a free note, and nothing else: no
// status, since a period entered wrongly is moved or deleted and the audit
// trail keeps what it was (sql/audit-trail.ts names each a set of its
// driver's or vehicle's, so their history reads the periods beside their
// own). Recording one is never refused for the work already planned on its
// days; the commands naming the driver or the vehicle afresh read these rows
// (@waste/domain/resources/availability).
import { DRIVER_ABSENCE_REASONS, VEHICLE_UNAVAILABILITY_REASONS } from "@waste/domain/resources/vocabulary"
import { text, uuid } from "drizzle-orm/pg-core"

import { oneOf } from "./checks"
import { id, projectScoped, timestamps, validity, validPeriod } from "./columns"
import { driver, vehicle } from "./fleet"
import { company, project } from "./organisation"
import { companyReference, projectReference, tenantIndex, tenantReference } from "./references"
import { wms } from "./wms"

export const driverAbsence = wms.table(
  "driver_absence",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    driverId: uuid().notNull(),
    reason: text().notNull(),
    note: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.driverId], driver),
    validPeriod(t),
    oneOf(t.reason, DRIVER_ABSENCE_REASONS),
    // A project's absences by when they start: the planner's read of who is away.
    tenantIndex(t, t.projectId, t.validFrom),
  ],
)

export const vehicleUnavailability = wms.table(
  "vehicle_unavailability",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    /** A powered vehicle or a trailer. */
    vehicleId: uuid().notNull(),
    reason: text().notNull(),
    note: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.vehicleId], vehicle),
    validPeriod(t),
    oneOf(t.reason, VEHICLE_UNAVAILABILITY_REASONS),
    tenantIndex(t, t.projectId, t.validFrom),
  ],
)
