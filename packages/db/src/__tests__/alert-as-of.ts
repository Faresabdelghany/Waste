// `alert` as 0009 (#109) left it and every migration since still had it: the
// office's alert about a route, a vehicle, a driver or a container, resolved
// by a person, and no rule. alert-rules-rendering.test.ts diffs from it and
// resolution-rendering.test.ts maps today's table back onto it, since an
// applied file is never edited and the schema module spells the table as it
// is today. Beside it, the spellings 0034 (O4 of #290) gave the table, which
// both tests read.
import { ALERT_KINDS, ALERT_SEVERITIES, ALERT_SOURCES, ALERT_STATUSES } from "@waste/domain/resolution/vocabulary"
import { sql } from "drizzle-orm"
import { check, text, timestamp, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "../schema/access"
import { oneOf } from "../schema/checks"
import { id, projectScoped, timestamps } from "../schema/columns"
import { container } from "../schema/containers"
import { route } from "../schema/execution"
import { driver, vehicle } from "../schema/fleet"
import { company, project } from "../schema/organisation"
import { ticket } from "../schema/resolution"
import { companyReference, projectReference, tenantIndex, tenantReference } from "../schema/references"
import { wms } from "../schema/wms"
import { ref } from "./rendering"

const instant = () => timestamp({ withTimezone: true })

export const alertAsOf0009 = wms.table(
  "alert",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    kind: text().notNull(),
    severity: text().notNull(),
    source: text().notNull(),
    status: text().notNull().default("new"),
    title: text().notNull(),
    details: text().notNull(),
    detectedAt: instant().notNull(),
    routeId: uuid(),
    vehicleId: uuid(),
    driverId: uuid(),
    containerId: uuid(),
    ticketId: uuid(),
    raisedBy: uuid(),
    acknowledgedAt: instant(),
    acknowledgedBy: uuid(),
    resolvedAt: instant(),
    resolvedBy: uuid(),
    resolutionNote: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.routeId], route),
    projectReference(t, [t.vehicleId], vehicle),
    projectReference(t, [t.driverId], driver),
    projectReference(t, [t.containerId], container),
    projectReference(t, [t.ticketId], ticket),
    tenantReference(t, [t.raisedBy], userAccount),
    tenantReference(t, [t.acknowledgedBy], userAccount),
    tenantReference(t, [t.resolvedBy], userAccount),
    oneOf(t.kind, ALERT_KINDS),
    oneOf(t.severity, ALERT_SEVERITIES),
    oneOf(t.source, ALERT_SOURCES),
    oneOf(t.status, ALERT_STATUSES),
    check(
      tableObjectName(t.id.table, "subject_shape", "alert"),
      sql`(${t.routeId} is not null)::int + (${t.vehicleId} is not null)::int + (${t.driverId} is not null)::int + (${t.containerId} is not null)::int >= 1`,
    ),
    check(tableObjectName(t.id.table, "acknowledged_shape", "alert"), sql`(${t.acknowledgedAt} is null) = (${t.acknowledgedBy} is null)`),
    check(tableObjectName(t.id.table, "resolved_shape", "alert"), sql`(${t.resolvedAt} is null) = (${t.resolvedBy} is null) and (${t.resolutionNote} is null or ${t.resolvedAt} is not null)`),
    check(
      tableObjectName(t.id.table, "stamps_shape", "alert"),
      sql`case ${t.status} when 'new' then ${t.acknowledgedAt} is null and ${t.resolvedAt} is null when 'acknowledged' then ${t.acknowledgedAt} is not null and ${t.resolvedAt} is null when 'resolved' then ${t.resolvedAt} is not null else false end`,
    ),
    tenantIndex(t, t.projectId, t.status),
    tenantIndex(t, t.routeId),
    tenantIndex(t, t.vehicleId),
    tenantIndex(t, t.driverId),
    tenantIndex(t, t.containerId),
    tenantIndex(t, t.ticketId),
    tenantIndex(t, t.raisedBy),
    tenantIndex(t, t.acknowledgedBy),
    tenantIndex(t, t.resolvedBy),
  ],
)

const column = (name: string) => ref("alert", name)
/** An alert names a route, a vehicle, a driver, a container or a ticket. */
export const SUBJECT_SHAPE = `(${column("route_id")} is not null)::int + (${column("vehicle_id")} is not null)::int + (${column("driver_id")} is not null)::int + (${column("container_id")} is not null)::int + (${column("ticket_id")} is not null)::int >= 1`
/** A resolver only with a resolution, a resolution with a resolver unless a rule raised the alert, a note only with a resolution. */
export const RESOLVED_SHAPE = `(${column("resolved_by")} is null or ${column("resolved_at")} is not null) and (${column("resolved_at")} is null or ${column("resolved_by")} is not null or ${column("rule")} is not null) and (${column("resolution_note")} is null or ${column("resolved_at")} is not null)`
/** A rule and its occurrence together or not at all. */
export const RULE_SHAPE = `(${column("rule")} is null) = (${column("rule_key")} is null)`
/** One alert per occurrence, whatever its status, but for one the worker cleared. */
export const RULE_KEY_INDEX = `CREATE UNIQUE INDEX "alert_rule_key_idx" ON "wms"."alert" USING btree ("company_id","rule_key") WHERE ${column("rule_key")} is not null and (${column("status")} <> 'resolved' or ${column("resolved_by")} is not null);`
