// Service Provider Activities (#474, @waste/domain/service-providers/
// activities): one item of coordination between the office and one Service
// Provider, about the work it holds under an award.
//
// `service_provider_activity` is current state, moved by command
// (ACTIVITY_MOVES) and audited by the trigger, which is its history: who
// opened it, every correction while it was open, and who closed it and why.
// Its `number` is the company's running count, `ACT-<n>` in a sentence, taken
// as the highest plus one under the company's row lock, as an Application's
// is. A proposal names the scheme and the Collection Group it is about, the
// days a route-day change asks the group to run on, or the vehicle and
// driver a vehicle change asks it to run with, and the first day they apply;
// an approved one names the scheme version its approval wrote. A compliance follow-up
// names its due day, and a note nothing more. `activity_kind_shape` holds
// each kind to its columns and `activity_status_shape` each kind to its
// statuses; `activity_closed_shape` holds a closed row to who closed it and
// when, a rejection to its reason, and an approval to the version it made.
import { SERVICE_DAYS } from "@waste/domain/planning/vocabulary"
import { PROPOSAL_KINDS } from "@waste/domain/service-providers/activities"
import { SERVICE_PROVIDER_ACTIVITY_KINDS, SERVICE_PROVIDER_ACTIVITY_STATUSES } from "@waste/domain/service-providers/vocabulary"
import { sql } from "drizzle-orm"
import { check, date, integer, text, timestamp, unique, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "./access"
import { oneOf, positive, subsetOf } from "./checks"
import { id, projectScoped, timestamps } from "./columns"
import { serviceArea } from "./finance"
import { company, project, serviceProvider } from "./organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "./references"
import { container } from "./containers"
import { driver, vehicle } from "./fleet"
import { collectionGroup, routeScheme } from "./route-schemes"
import { wms } from "./wms"

export const serviceProviderActivity = wms.table(
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
    oneOf(t.kind, SERVICE_PROVIDER_ACTIVITY_KINDS),
    oneOf(t.status, SERVICE_PROVIDER_ACTIVITY_STATUSES),
    subsetOf(t.serviceDays, SERVICE_DAYS),
    check(tableObjectName(t.id.table, "subject_given", "serviceProviderActivity"), sql`length(btrim(${t.subject})) > 0`),
    // Each kind carries its own columns and none of another's: a proposal its scheme, group and first day, a route-day change its days, a vehicle change its vehicle and maybe a driver, a follow-up its due day. A stop-set change's containers are its set's rows (`service_provider_activity_container`), which the API holds to one at least.
    check(
      tableObjectName(t.id.table, "kind_shape", "serviceProviderActivity"),
      sql`case ${t.kind} when 'route-day-change' then ${t.routeSchemeId} is not null and ${t.collectionGroupId} is not null and cardinality(${t.serviceDays}) > 0 and ${t.effectiveFrom} is not null and ${t.dueOn} is null and ${t.vehicleId} is null and ${t.driverId} is null when 'vehicle-change' then ${t.routeSchemeId} is not null and ${t.collectionGroupId} is not null and ${t.vehicleId} is not null and ${t.effectiveFrom} is not null and ${t.serviceDays} is null and ${t.dueOn} is null when 'stop-set-change' then ${t.routeSchemeId} is not null and ${t.collectionGroupId} is not null and ${t.effectiveFrom} is not null and ${t.serviceDays} is null and ${t.dueOn} is null and ${t.vehicleId} is null and ${t.driverId} is null when 'compliance-follow-up' then ${t.dueOn} is not null and ${t.routeSchemeId} is null and ${t.collectionGroupId} is null and ${t.serviceDays} is null and ${t.effectiveFrom} is null and ${t.vehicleId} is null and ${t.driverId} is null else ${t.dueOn} is null and ${t.routeSchemeId} is null and ${t.collectionGroupId} is null and ${t.serviceDays} is null and ${t.effectiveFrom} is null and ${t.vehicleId} is null and ${t.driverId} is null end`,
    ),
    // A proposal moves through its Approval's statuses, every other kind through open and closed.
    check(
      tableObjectName(t.id.table, "status_shape", "serviceProviderActivity"),
      sql`case when ${t.kind} in (${sql.raw(PROPOSAL_KINDS.map((kind) => `'${kind}'`).join(", "))}) then ${t.status} in ('pending-approval', 'approved', 'rejected', 'withdrawn') else ${t.status} in ('open', 'completed', 'cancelled') end`,
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

/**
 * A stop-set change's containers (#474, part 3), in stop order: the list it
 * asks a group that picks its stops to run on, replaced whole by a
 * correction, as a group's own list is (`collection_group_container`). Each
 * container is the activity's project's, once, at its own position.
 */
export const serviceProviderActivityContainer = wms.table(
  "service_provider_activity_container",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    activityId: uuid().notNull(),
    containerId: uuid().notNull(),
    /** Stop order, 1..n in the body's order. */
    position: integer().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.activityId], serviceProviderActivity),
    projectReference(t, [t.containerId], container),
    // Named for what it holds: the columns' own name passes 63 bytes.
    unique(tableObjectName(t.companyId.table, "membership_key", "serviceProviderActivityContainer")).on(t.companyId, t.activityId, t.containerId),
    tenantUnique(t, t.activityId, t.position),
    positive(t.position),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.containerId),
  ],
)
