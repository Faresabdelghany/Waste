// Vehicle maintenance (O20 of #290): a vehicle's maintenance plans and the
// Maintenance Orders the office opens to do them.
//
// `vehicle_maintenance_plan` is one service a vehicle has at intervals —
// every so many days, kilometres or engine hours — counted from the last
// service, whose day and readings are its baseline (`last_done_*`).
// `vehicle_maintenance_plan_shape` holds it to the domain's rule: at least one
// interval, and a distance or hours interval with the reading it counts from
// (@waste/domain/resources/maintenance, `planIssue`). It carries a status and
// no period: a retired plan stays for the orders that name it, and raises
// nothing. Its key through the vehicle (`projectKey(t, t.vehicleId)`) is what
// an order's plan reference reaches, so an order cannot name another
// vehicle's plan whatever the API does.
//
// `maintenance_order` is one piece of work on a vehicle: of a plan, or a
// one-off with its own title. It is open until completed — on a day, with the
// readings then — or cancelled; `maintenance_order_closing_shape` says which
// columns each status carries. Completing a plan's order moves the plan's
// baseline, which the API writes in the same request.
import { MAINTENANCE_INTERVAL_MAX } from "@waste/domain/resources/maintenance"
import { MAINTENANCE_ORDER_STATUSES, MAINTENANCE_PLAN_STATUSES } from "@waste/domain/resources/vocabulary"
import { sql } from "drizzle-orm"
import { check, date, integer, text, timestamp, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "./access"
import { oneOf } from "./checks"
import { id, projectScoped, timestamps } from "./columns"
import { vehicle } from "./fleet"
import { company, project } from "./organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference } from "./references"
import { wms } from "./wms"

const instant = () => timestamp({ withTimezone: true })

export const vehicleMaintenancePlan = wms.table(
  "vehicle_maintenance_plan",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    vehicleId: uuid().notNull(),
    /** What the service is: `Annual service`. */
    name: text().notNull(),
    intervalDays: integer(),
    intervalKm: integer(),
    intervalHours: integer(),
    /** The last service: its day, and the odometer and the engine hours then. */
    lastDoneOn: date().notNull(),
    lastDoneKm: integer(),
    lastDoneHours: integer(),
    status: text().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.vehicleId], vehicle),
    projectKey(t, t.vehicleId),
    oneOf(t.status, MAINTENANCE_PLAN_STATUSES),
    check(
      tableObjectName(t.id.table, "intervals_range", "vehicleMaintenancePlan"),
      sql`(${t.intervalDays} is null or ${t.intervalDays} between 1 and ${sql.raw(String(MAINTENANCE_INTERVAL_MAX.days))}) and (${t.intervalKm} is null or ${t.intervalKm} between 1 and ${sql.raw(String(MAINTENANCE_INTERVAL_MAX.km))}) and (${t.intervalHours} is null or ${t.intervalHours} between 1 and ${sql.raw(String(MAINTENANCE_INTERVAL_MAX.hours))}) and (${t.lastDoneKm} is null or ${t.lastDoneKm} >= 0) and (${t.lastDoneHours} is null or ${t.lastDoneHours} >= 0)`,
    ),
    // At least one interval, and a distance or hours interval with the reading it counts from.
    check(
      tableObjectName(t.id.table, "shape", "vehicleMaintenancePlan"),
      sql`(${t.intervalDays} is not null or ${t.intervalKm} is not null or ${t.intervalHours} is not null) and (${t.intervalKm} is null or ${t.lastDoneKm} is not null) and (${t.intervalHours} is null or ${t.lastDoneHours} is not null)`,
    ),
    tenantIndex(t, t.projectId),
  ],
)

export const maintenanceOrder = wms.table(
  "maintenance_order",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    vehicleId: uuid().notNull(),
    /** The plan it serves, of the same vehicle; null for a one-off. */
    planId: uuid(),
    title: text().notNull(),
    status: text().notNull(),
    dueOn: date(),
    note: text(),
    completedOn: date(),
    odometerKm: integer(),
    engineHours: integer(),
    /** What was done, or why it was called off. */
    closingNote: text(),
    closedAt: instant(),
    closedBy: uuid(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.vehicleId], vehicle),
    // A plan of the vehicle the order is on: the key carries the vehicle on both sides.
    projectReference(t, [t.vehicleId, t.planId], vehicleMaintenancePlan, [vehicleMaintenancePlan.vehicleId, vehicleMaintenancePlan.id]),
    tenantReference(t, [t.closedBy], userAccount),
    oneOf(t.status, MAINTENANCE_ORDER_STATUSES),
    check(tableObjectName(t.id.table, "readings_range", "maintenanceOrder"), sql`(${t.odometerKm} is null or ${t.odometerKm} >= 0) and (${t.engineHours} is null or ${t.engineHours} >= 0)`),
    // An open order is not closed; a completed one has its day; only a completed one carries readings.
    check(
      tableObjectName(t.id.table, "closing_shape", "maintenanceOrder"),
      sql`(${t.status} = 'open') = (${t.closedAt} is null) and (${t.status} = 'completed') = (${t.completedOn} is not null) and (${t.status} = 'completed' or (${t.odometerKm} is null and ${t.engineHours} is null))`,
    ),
    tenantIndex(t, t.vehicleId),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.planId),
    tenantIndex(t, t.closedBy),
  ],
)
