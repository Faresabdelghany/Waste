// The `service_provider_activity` table as an earlier migration left it:
// 0063 (#474, part 1) with three kinds, the route-day change the one
// proposal, and no vehicle or driver; 0067 (part 2) with the vehicle change
// and its vehicle and driver. Today's, with the stop-set change (part 3), is
// src/schema/service-provider-activities.ts itself. One spelling here, so
// the rendering tests of 0063, 0067 and the stop-set change cannot drift on
// what an era said. Another
// table object of the same name is fine, since nothing connects to a
// database. Not a suite of its own: only ever imported.
import { SERVICE_DAYS } from "@waste/domain/planning/vocabulary"
import { SERVICE_PROVIDER_ACTIVITY_STATUSES } from "@waste/domain/service-providers/vocabulary"
import { sql } from "drizzle-orm"
import { check, date, integer, text, timestamp, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "../schema/access"
import { driver, vehicle } from "../schema/fleet"
import { oneOf, subsetOf } from "../schema/checks"
import { id, projectScoped, timestamps } from "../schema/columns"
import { serviceArea } from "../schema/finance"
import { company, project, serviceProvider } from "../schema/organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "../schema/references"
import { collectionGroup, routeScheme } from "../schema/route-schemes"
import { wms } from "../schema/wms"

/** The kinds 0063 held an Activity to. */
export const KINDS_AS_OF_0063 = ["route-day-change", "compliance-follow-up", "coordination-note"] as const
/** The kinds 0067 held an Activity to. */
export const KINDS_AS_OF_0067 = [...KINDS_AS_OF_0063, "vehicle-change"] as const

export const serviceProviderActivityAsOf0063 = wms.table(
  "service_provider_activity",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    /** The company's running count, `ACT-<n>` in a sentence. */
    number: integer().notNull(),
    kind: text().notNull(),
    status: text().notNull(),
    serviceProviderId: uuid().notNull(),
    /** The award it is about, where it is about one. */
    serviceAreaId: uuid(),
    subject: text().notNull(),
    body: text(),
    /** A compliance follow-up's last day in time. */
    dueOn: date(),
    /** A proposal's scheme and group. */
    routeSchemeId: uuid(),
    collectionGroupId: uuid(),
    /** A route-day change's days for the group. */
    serviceDays: text().array(),
    /** The first day a proposal applies from. */
    effectiveFrom: date(),
    /** The scheme version an approval wrote. */
    successorSchemeId: uuid(),
    openedBy: uuid().notNull(),
    closedBy: uuid(),
    closedAt: timestamp({ withTimezone: true }),
    closeReason: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.serviceProviderId], serviceProvider),
    projectReference(t, [t.serviceAreaId], serviceArea),
    projectReference(t, [t.routeSchemeId], routeScheme),
    projectReference(t, [t.collectionGroupId], collectionGroup),
    projectReference(t, [t.successorSchemeId], routeScheme),
    tenantReference(t, [t.openedBy], userAccount),
    tenantReference(t, [t.closedBy], userAccount),
    tenantUnique(t, t.number),
    oneOf(t.kind, KINDS_AS_OF_0063),
    oneOf(t.status, SERVICE_PROVIDER_ACTIVITY_STATUSES),
    subsetOf(t.serviceDays, SERVICE_DAYS),
    check(tableObjectName(t.id.table, "subject_given", "serviceProviderActivity"), sql`length(btrim(${t.subject})) > 0`),
    // Each kind carries its own columns and none of another's.
    check(
      tableObjectName(t.id.table, "kind_shape", "serviceProviderActivity"),
      sql`case ${t.kind} when 'route-day-change' then ${t.routeSchemeId} is not null and ${t.collectionGroupId} is not null and cardinality(${t.serviceDays}) > 0 and ${t.effectiveFrom} is not null and ${t.dueOn} is null when 'compliance-follow-up' then ${t.dueOn} is not null and ${t.routeSchemeId} is null and ${t.collectionGroupId} is null and ${t.serviceDays} is null and ${t.effectiveFrom} is null else ${t.dueOn} is null and ${t.routeSchemeId} is null and ${t.collectionGroupId} is null and ${t.serviceDays} is null and ${t.effectiveFrom} is null end`,
    ),
    // A proposal moves through its Approval's statuses, every other kind through open and closed.
    check(
      tableObjectName(t.id.table, "status_shape", "serviceProviderActivity"),
      sql`case when ${t.kind} in ('route-day-change') then ${t.status} in ('pending-approval', 'approved', 'rejected', 'withdrawn') else ${t.status} in ('open', 'completed', 'cancelled') end`,
    ),
    // A closed Activity says who closed it and when, a rejection why, and only an approval names the version it made.
    check(
      tableObjectName(t.id.table, "closed_shape", "serviceProviderActivity"),
      sql`(${t.status} in ('pending-approval', 'open')) = (${t.closedBy} is null and ${t.closedAt} is null) and (${t.status} <> 'rejected' or ${t.closeReason} is not null) and (${t.status} = 'approved') = (${t.successorSchemeId} is not null)`,
    ),
    projectKey(t),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.serviceProviderId),
    tenantIndex(t, t.serviceAreaId),
    tenantIndex(t, t.routeSchemeId),
    tenantIndex(t, t.collectionGroupId),
    tenantIndex(t, t.successorSchemeId),
    tenantIndex(t, t.openedBy),
    tenantIndex(t, t.closedBy),
  ],
)

export const serviceProviderActivityAsOf0067 = wms.table(
  "service_provider_activity",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    /** The company's running count, `ACT-<n>` in a sentence. */
    number: integer().notNull(),
    kind: text().notNull(),
    status: text().notNull(),
    serviceProviderId: uuid().notNull(),
    /** The award it is about, where it is about one. */
    serviceAreaId: uuid(),
    subject: text().notNull(),
    body: text(),
    /** A compliance follow-up's last day in time. */
    dueOn: date(),
    /** A proposal's scheme and group. */
    routeSchemeId: uuid(),
    collectionGroupId: uuid(),
    /** A route-day change's days for the group. */
    serviceDays: text().array(),
    /** The first day a proposal applies from. */
    effectiveFrom: date(),
    /** A vehicle change's vehicle for the group, and its driver where the proposal names one (#474, part 2). */
    vehicleId: uuid(),
    driverId: uuid(),
    /** The scheme version an approval wrote. */
    successorSchemeId: uuid(),
    openedBy: uuid().notNull(),
    closedBy: uuid(),
    closedAt: timestamp({ withTimezone: true }),
    closeReason: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.serviceProviderId], serviceProvider),
    projectReference(t, [t.serviceAreaId], serviceArea),
    projectReference(t, [t.routeSchemeId], routeScheme),
    projectReference(t, [t.collectionGroupId], collectionGroup),
    projectReference(t, [t.successorSchemeId], routeScheme),
    projectReference(t, [t.vehicleId], vehicle),
    projectReference(t, [t.driverId], driver),
    tenantReference(t, [t.openedBy], userAccount),
    tenantReference(t, [t.closedBy], userAccount),
    tenantUnique(t, t.number),
    oneOf(t.kind, KINDS_AS_OF_0067),
    oneOf(t.status, SERVICE_PROVIDER_ACTIVITY_STATUSES),
    subsetOf(t.serviceDays, SERVICE_DAYS),
    check(tableObjectName(t.id.table, "subject_given", "serviceProviderActivity"), sql`length(btrim(${t.subject})) > 0`),
    // Each kind carries its own columns and none of another's: a proposal its scheme, group and first day, a route-day change its days, a vehicle change its vehicle and maybe a driver, a follow-up its due day.
    check(
      tableObjectName(t.id.table, "kind_shape", "serviceProviderActivity"),
      sql`case ${t.kind} when 'route-day-change' then ${t.routeSchemeId} is not null and ${t.collectionGroupId} is not null and cardinality(${t.serviceDays}) > 0 and ${t.effectiveFrom} is not null and ${t.dueOn} is null and ${t.vehicleId} is null and ${t.driverId} is null when 'vehicle-change' then ${t.routeSchemeId} is not null and ${t.collectionGroupId} is not null and ${t.vehicleId} is not null and ${t.effectiveFrom} is not null and ${t.serviceDays} is null and ${t.dueOn} is null when 'compliance-follow-up' then ${t.dueOn} is not null and ${t.routeSchemeId} is null and ${t.collectionGroupId} is null and ${t.serviceDays} is null and ${t.effectiveFrom} is null and ${t.vehicleId} is null and ${t.driverId} is null else ${t.dueOn} is null and ${t.routeSchemeId} is null and ${t.collectionGroupId} is null and ${t.serviceDays} is null and ${t.effectiveFrom} is null and ${t.vehicleId} is null and ${t.driverId} is null end`,
    ),
    // A proposal moves through its Approval's statuses, every other kind through open and closed.
    check(
      tableObjectName(t.id.table, "status_shape", "serviceProviderActivity"),
      sql`case when ${t.kind} in ('route-day-change', 'vehicle-change') then ${t.status} in ('pending-approval', 'approved', 'rejected', 'withdrawn') else ${t.status} in ('open', 'completed', 'cancelled') end`,
    ),
    // A closed Activity says who closed it and when, a rejection why, and only an approval names the version it made.
    check(
      tableObjectName(t.id.table, "closed_shape", "serviceProviderActivity"),
      sql`(${t.status} in ('pending-approval', 'open')) = (${t.closedBy} is null and ${t.closedAt} is null) and (${t.status} <> 'rejected' or ${t.closeReason} is not null) and (${t.status} = 'approved') = (${t.successorSchemeId} is not null)`,
    ),
    projectKey(t),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.serviceProviderId),
    tenantIndex(t, t.serviceAreaId),
    tenantIndex(t, t.routeSchemeId),
    tenantIndex(t, t.collectionGroupId),
    tenantIndex(t, t.successorSchemeId),
    tenantIndex(t, t.vehicleId),
    tenantIndex(t, t.driverId),
    tenantIndex(t, t.openedBy),
    tenantIndex(t, t.closedBy),
  ],
)
