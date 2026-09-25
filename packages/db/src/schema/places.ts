// The places work starts, ends and stocks (Issue #101): the Depot, the
// Warehouse and the Unloading Station. The glossary keeps the three apart with
// three Avoid lists — a Warehouse is not a Depot, a Depot is neither a
// Warehouse nor an Unloading Station — and the prototype's mixed "Depots &
// Unloading" tab is split here into three tables. Colocation (Nordhavn's
// depot and its warehouse in one yard) is one pointer, `warehouse.depot_id`,
// and not two that can disagree.
//
// `depot` is where a route departs from and returns to, so it is always
// located (`location` NOT NULL): a route leaves from a point. It is the
// project's, like the vehicles, drivers and schemes that point at it
// (`projectKey`). Its ownership and its hours are two shape checks the table
// alone has, spelled inline and named for the rule: a depot owned by a
// service provider names one and no other does (`depot_provider_shape`), and
// the opening hours are two times or none (`depot_hours_shape`; an overnight
// window, 22:00 to 05:00, is two times and allowed).
//
// `warehouse` is where containers are stocked and repaired: what the Stock
// Movement ledger's `from_warehouse_id` and `to_warehouse_id` point at, so it
// carries `projectKey`. It is registered before it is geocoded, so its
// location is nullable, like a property's. The prototype's zones, fungible
// stock flags and scan rule are inventory's and wait for stock items.
//
// `unloading_station` is where a route empties, and it is the company's and
// not a project's, because ARC Amager is where every Copenhagen project
// unloads — the reasoning that made a Customer the company's. So it carries
// `tenantKey` for the schemes that point at it, its code and name are unique
// per company, and it has the same two shape checks as a depot beside a
// `weighbridge` flag. `unloading_station_fraction` is what it accepts, one
// row per fraction, replaced whole through its own route; its unique is
// spelled inline and named for what it holds, the derived name passing 63
// bytes.
//
// A status, not a period, on all three (ADR-0005: a place carries a status
// where validity does not say it); the prototype's `effectiveFrom` and
// `effectiveTo` on a place are readings of the status's history in the audit
// log.
import { DEPOT_OWNERSHIPS, DEPOT_STATUSES, UNLOADING_STATION_OWNERSHIPS, UNLOADING_STATION_STATUSES, WAREHOUSE_STATUSES } from "@waste/domain/resources/vocabulary"
import { sql } from "drizzle-orm"
import { boolean, check, integer, text, time, unique, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { wasteFraction } from "./catalogue"
import { oneOf, positive } from "./checks"
import { id, projectScoped, tenant, timestamps } from "./columns"
import { geometry, validGeometry } from "./geometry"
import { company, project, serviceProvider } from "./organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantKey, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

export const depot = wms.table(
  "depot",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    /** The stable reference a person quotes: `DEP-NORD`. Set once; unique per project. */
    code: text().notNull(),
    name: text().notNull(),
    /** The address as one text; a structured address arrives with the address lookup (#77). */
    address: text().notNull(),
    /** A route departs from a point, so a depot is always located. */
    location: geometry.point().notNull(),
    ownership: text().notNull(),
    /** The owning provider, given exactly when the ownership says so. */
    serviceProviderId: uuid(),
    /** Opening hours as two times on the project's clock, both or neither; an overnight window is allowed. */
    opensAt: time(),
    closesAt: time(),
    /** How many vehicles the yard holds. */
    vehicleCapacity: integer(),
    status: text().notNull(),
    notes: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.serviceProviderId], serviceProvider),
    tenantUnique(t, t.projectId, t.code),
    tenantUnique(t, t.projectId, t.name),
    projectKey(t),
    oneOf(t.ownership, DEPOT_OWNERSHIPS),
    oneOf(t.status, DEPOT_STATUSES),
    validGeometry(t.location),
    positive(t.vehicleCapacity),
    // Two rules the table alone has, each named for itself: a provider's depot names its provider and no other does; the hours are both given or neither.
    check(tableObjectName(t.id.table, "provider_shape", "depot"), sql`(${t.ownership} = 'service-provider') = (${t.serviceProviderId} is not null)`),
    check(tableObjectName(t.id.table, "hours_shape", "depot"), sql`(${t.opensAt} is null) = (${t.closesAt} is null)`),
    tenantIndex(t, t.serviceProviderId),
  ],
)

export const warehouse = wms.table(
  "warehouse",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    /** The stable reference a person quotes: `WH-WEST`. Set once; unique per project. */
    code: text().notNull(),
    name: text().notNull(),
    address: text().notNull(),
    /** Geocoded, null until it is. */
    location: geometry.point(),
    /** The depot this warehouse shares a yard with, if any: colocation is one pointer. */
    depotId: uuid(),
    status: text().notNull(),
    notes: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.depotId], depot),
    tenantUnique(t, t.projectId, t.code),
    tenantUnique(t, t.projectId, t.name),
    projectKey(t),
    oneOf(t.status, WAREHOUSE_STATUSES),
    validGeometry(t.location),
    tenantIndex(t, t.depotId),
  ],
)

export const unloadingStation = wms.table(
  "unloading_station",
  {
    ...id,
    ...tenant,
    ...timestamps,
    /** The stable reference a person quotes: `ARC-AMAGER`. Set once; unique per company. */
    code: text().notNull(),
    name: text().notNull(),
    address: text().notNull(),
    /** A route empties at a point, so a station is always located. */
    location: geometry.point().notNull(),
    ownership: text().notNull(),
    serviceProviderId: uuid(),
    opensAt: time(),
    closesAt: time(),
    /** Whether the station weighs what is delivered; the tickets themselves are Execution's. */
    weighbridge: boolean().notNull().default(false),
    status: text().notNull(),
    notes: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.serviceProviderId], serviceProvider),
    tenantUnique(t, t.code),
    tenantUnique(t, t.name),
    tenantKey(t),
    oneOf(t.ownership, UNLOADING_STATION_OWNERSHIPS),
    oneOf(t.status, UNLOADING_STATION_STATUSES),
    validGeometry(t.location),
    check(tableObjectName(t.id.table, "provider_shape", "unloadingStation"), sql`(${t.ownership} = 'service-provider') = (${t.serviceProviderId} is not null)`),
    check(tableObjectName(t.id.table, "hours_shape", "unloadingStation"), sql`(${t.opensAt} is null) = (${t.closesAt} is null)`),
    tenantIndex(t, t.serviceProviderId),
  ],
)

export const unloadingStationFraction = wms.table(
  "unloading_station_fraction",
  {
    ...id,
    ...tenant,
    ...timestamps,
    unloadingStationId: uuid().notNull(),
    wasteFractionId: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.unloadingStationId], unloadingStation),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    // One row per fraction a station accepts; the derived name would pass 63 bytes, so the key is named for what it holds.
    unique(tableObjectName(t.companyId.table, "membership_key", "unloadingStationFraction")).on(t.companyId, t.unloadingStationId, t.wasteFractionId),
    tenantIndex(t, t.wasteFractionId),
  ],
)
