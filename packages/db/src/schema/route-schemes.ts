// What recurs (Issue #97, ADR-0002): the Route Scheme, its Collection Groups,
// and each group's Stop Matching Rule or picked containers. These are rules,
// not work: the generation job turns them into dated Routes and Pickups, and
// nothing here is ever a route.
//
// `route_scheme` is effective-dated (ADR-0005): its period is the time it
// plans for, open-ended while `valid_to` is null. Its exclusion constraint is
// over `(project_id, name)` — one scheme of a name in force at a time — so
// "Create new version" is a new row of the same name starting when the old
// ends, and the prototype's Version fact is the row count. `status` stores the
// half of the lifecycle a person decides, `draft` or `validated`; scheduled,
// effective, expired and Attention are readings of runs, of the period and of
// the drift stamps, never columns. The recurrence is columns: the frequency,
// the service days as a `text[]` held to the seven and to at least one
// (`subsetOf`, `nonEmpty`), and the week rotation, which
// `route_scheme_week_rotation_shape` ties to `every-2-weeks` and to nothing
// else, spelled inline like `service_frequency_shape` because no other table
// has the rule. The planning area is optional while the scheme is a draft;
// the API refuses a validated scheme whose rule groups have none.
//
// `collection_group` is one group of a scheme: its position (group order —
// "first rule group wins" on a shared day; not unique, since a reorder would
// swap two values under a unique, and ties order by id), its days (a subset of
// the scheme's, held by the API; empty for a group that no longer runs), how
// it finds its stops (`stop_source`), and, for a rule, the vehicle type it
// asks for — `collection_group_rule_shape` keeps a manual group from carrying
// one. The Service Provider is here because Organisation & Access has the
// table, and since migration 0007 (Issue #101) so are the glossary's "a
// vehicle, a default driver": `vehicle_id` and `driver_id`, each a
// `projectReference` into Resources' fleet, nullable, and held by the API to
// a powered vehicle of the project, to a driver who may take it, and to no
// vehicle or driver on two groups that run on a shared day. The implicit
// group of a scheme without explicit groups is a row too: the server
// materialises it, so every generated Route carries a group and the route key
// has no nullable column.
//
// The rule is three things on the group and never JSON: the fractions it
// matches (`collection_group_fraction`, one or more), the container types it
// is restricted to (`collection_group_container_type`, zero or more), and the
// vehicle type — `rule_vehicle_type_id`, a `tenantReference` to Resources'
// `vehicle_type`, which replaced the `rule_vehicle_type` token of 0006 in
// 0007, the first `DROP COLUMN` of this schema: one spelling of a vehicle
// type, a company's row, and generation applies it through
// `container_type_vehicle_type` and never by name. The manual alternative is
// `collection_group_container` in stop order. Rows rather than arrays because
// a fraction that is a row can be joined by generation and refused by a key
// when it names another company's, which the Registry made a database rule.
// The two membership uniques are spelled inline and named for what they hold,
// because listing their columns passes 63 bytes
// (`collection_group_fraction_collection_group_id_waste_fraction_id_key` is
// 67); the picked container's two keys come to 63 and 59 and keep the derived
// names.
//
// The scheme itself gained the glossary's "depot, and unloading station" in
// 0007 too: `depot_id`, a `projectReference` to the project's depot, and
// `unloading_station_id`, a `tenantReference` to the company's station, both
// nullable while a draft says nothing about them.
import { HOLIDAY_POLICIES, RECURRENCE_FREQUENCIES, ROUTE_SCHEME_STATUSES, SCHEME_EDIT_POLICIES, SERVICE_DAYS, SERVICE_TYPES, STOP_SOURCES, WEEK_ROTATIONS } from "@waste/domain/planning/vocabulary"
import { sql } from "drizzle-orm"
import { boolean, check, integer, text, time, unique, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { containerType, wasteFraction } from "./catalogue"
import { nonEmpty, oneOf, positive, subsetOf } from "./checks"
import { id, projectScoped, timestamps, validity, validPeriod } from "./columns"
import { container } from "./containers"
import { driver, vehicle } from "./fleet"
import { vehicleType } from "./fleet-types"
import { company, project, serviceProvider } from "./organisation"
import { depot, unloadingStation } from "./places"
import { planningArea } from "./planning-areas"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

export const routeScheme = wms.table(
  "route_scheme",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    /** Unique among the schemes of the project in force at one time, which the exclusion constraint holds. */
    name: text().notNull(),
    /** Optional while a draft; a validated scheme with a rule group needs one (the API's rule). */
    planningAreaId: uuid(),
    serviceType: text().notNull(),
    frequency: text().notNull(),
    /** The weekdays the scheme serves, one or more of the seven. */
    serviceDays: text().array().notNull(),
    /** Which ISO-week parity an `every-2-weeks` scheme serves; given with that frequency and with nothing else. */
    weekRotation: text(),
    /** A time on the project's clock (`06:30`); carried, not used in the date math. */
    plannedStartTime: time(),
    holidayPolicy: text().notNull().default("skip"),
    /** Stored so the choice survives; nothing consumes it yet (#38). */
    editPolicy: text().notNull().default("ask"),
    /** Whether the nightly job keeps the coming week planned. */
    planAhead: boolean().notNull().default(true),
    status: text().notNull().default("draft"),
    /** Where the routes depart from; one of the project's depots, null while unsaid (Issue #101). */
    depotId: uuid(),
    /** Where the routes empty; one of the company's stations, null while unsaid (Issue #101). */
    unloadingStationId: uuid(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.planningAreaId], planningArea),
    projectReference(t, [t.depotId], depot),
    tenantReference(t, [t.unloadingStationId], unloadingStation),
    projectKey(t),
    validPeriod(t),
    oneOf(t.serviceType, SERVICE_TYPES),
    oneOf(t.frequency, RECURRENCE_FREQUENCIES),
    subsetOf(t.serviceDays, SERVICE_DAYS),
    nonEmpty(t.serviceDays),
    oneOf(t.weekRotation, WEEK_ROTATIONS),
    oneOf(t.holidayPolicy, HOLIDAY_POLICIES),
    oneOf(t.editPolicy, SCHEME_EDIT_POLICIES),
    oneOf(t.status, ROUTE_SCHEME_STATUSES),
    // The rotation belongs to the fortnightly cadence and to no other: given
    // exactly when the frequency is every-2-weeks. No helper spells it because
    // no other table has it; the label names the check itself.
    check(tableObjectName(t.id.table, "week_rotation_shape", "routeScheme"), sql`(${t.frequency} = 'every-2-weeks') = (${t.weekRotation} is not null)`),
    tenantIndex(t, t.planningAreaId),
    tenantIndex(t, t.depotId),
    tenantIndex(t, t.unloadingStationId),
  ],
)

export const collectionGroup = wms.table(
  "collection_group",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    routeSchemeId: uuid().notNull(),
    /** Unique within the scheme. */
    name: text().notNull(),
    /** Group order: the first rule group wins a container on a shared day. Not unique; ties order by id. */
    position: integer().notNull(),
    /** The scheme's service days this group runs on; empty for a group that no longer runs. */
    days: text().array().notNull(),
    stopSource: text().notNull(),
    /** The vehicle type a rule asks for, a row of the company's; null for a manual group, and optional for a rule. */
    ruleVehicleTypeId: uuid(),
    serviceProviderId: uuid(),
    /** The vehicle the group runs with; a powered vehicle of the project, held by the API. Null while unsaid. */
    vehicleId: uuid(),
    /** The default driver; one who may take the vehicle, held by the API. Null while unsaid. */
    driverId: uuid(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.routeSchemeId], routeScheme),
    tenantReference(t, [t.serviceProviderId], serviceProvider),
    tenantReference(t, [t.ruleVehicleTypeId], vehicleType),
    projectReference(t, [t.vehicleId], vehicle),
    projectReference(t, [t.driverId], driver),
    tenantUnique(t, t.routeSchemeId, t.name),
    projectKey(t),
    subsetOf(t.days, SERVICE_DAYS),
    oneOf(t.stopSource, STOP_SOURCES),
    positive(t.position),
    // A vehicle type is part of a rule; a manual group has no rule to carry one in.
    check(tableObjectName(t.id.table, "rule_shape", "collectionGroup"), sql`${t.stopSource} = 'rule' or ${t.ruleVehicleTypeId} is null`),
    tenantIndex(t, t.serviceProviderId),
    tenantIndex(t, t.ruleVehicleTypeId),
    tenantIndex(t, t.vehicleId),
    tenantIndex(t, t.driverId),
  ],
)

export const collectionGroupFraction = wms.table(
  "collection_group_fraction",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    collectionGroupId: uuid().notNull(),
    wasteFractionId: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.collectionGroupId], collectionGroup),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    // One row per fraction of a group. The derived name would be 67 bytes, so the key is named for what it holds.
    unique(tableObjectName(t.companyId.table, "membership_key", "collectionGroupFraction")).on(t.companyId, t.collectionGroupId, t.wasteFractionId),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.wasteFractionId),
  ],
)

export const collectionGroupContainerType = wms.table(
  "collection_group_container_type",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    collectionGroupId: uuid().notNull(),
    containerTypeId: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.collectionGroupId], collectionGroup),
    tenantReference(t, [t.containerTypeId], containerType),
    // One row per container type of a group; the derived name would pass 63 bytes.
    unique(tableObjectName(t.companyId.table, "membership_key", "collectionGroupContainerType")).on(t.companyId, t.collectionGroupId, t.containerTypeId),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.containerTypeId),
  ],
)

export const collectionGroupContainer = wms.table(
  "collection_group_container",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    collectionGroupId: uuid().notNull(),
    containerId: uuid().notNull(),
    /** Stop order, 1..n in the body's order; the list is replaced whole, so the unique on it is safe. */
    position: integer().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.collectionGroupId], collectionGroup),
    // A group cannot pick another project's container: both tables are project-scoped, so the key carries the project.
    projectReference(t, [t.containerId], container),
    tenantUnique(t, t.collectionGroupId, t.containerId),
    tenantUnique(t, t.collectionGroupId, t.position),
    positive(t.position),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.containerId),
  ],
)
