// `pickup` as 0016 (#111) left it and 0018 still had it: the office's stop
// and its origin, one stop per container on a route under a unique
// constraint, and no service. ad-hoc-rendering.test.ts diffs to it and
// stop-service-rendering.test.ts from it, since an applied file is never
// edited and the schema module spells the table as it is today. And as 0023
// (O3 of #290) left it: the stop's service, generation's key held to its own
// stops, and no ledger booking — stop-service-rendering.test.ts diffs to it
// and stop-ledger-rendering.test.ts from it. And as 0032 (O3b of #290) left
// it: the ledger bookings, and no contaminant code — stop-ledger-rendering
// diffs to it and pickup-exceptions-rendering (M5 of #293) from it. And as
// 0038 left it: the contaminant code, and no bulky booking —
// pickup-exceptions-rendering diffs to it and bulky-rendering (O11 of #290)
// from it. Until 0053 the services were six, frozen here since the
// vocabulary has grown.
import { PICKUP_ORIGINS, PICKUP_REASONS, PICKUP_STATUSES } from "@waste/domain/execution/vocabulary"
import { sql } from "drizzle-orm"
import { check, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { subscription } from "../schema/agreements"
import { wasteFraction } from "../schema/catalogue"
import { exactlyOne, oneOf, positive } from "../schema/checks"
import { id, projectScoped, timestamps } from "../schema/columns"
import { container } from "../schema/containers"
import { property, sharedCollectionPoint } from "../schema/customers"
import { route } from "../schema/execution"
import { company, project } from "../schema/organisation"
import { contaminantCode } from "../schema/pickup-exceptions"
import { warehouse } from "../schema/places"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "../schema/references"
import { wms } from "../schema/wms"

const instant = () => timestamp({ withTimezone: true })

/** The stop's services from 0023 until 0053 added `bulky`. */
const SERVICES_UNTIL_0053 = ["empty", "deliver", "remove", "swap", "repair", "wash"] as const

export const pickupAsOf0016 = wms.table(
  "pickup",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    routeId: uuid().notNull(),
    containerId: uuid(),
    position: integer().notNull(),
    status: text().notNull().default("planned"),
    origin: text().notNull().default("generation"),
    note: text(),
    propertyId: uuid(),
    sharedCollectionPointId: uuid(),
    wasteFractionId: uuid().notNull(),
    arrivedAt: instant(),
    outcomeAt: instant(),
    reason: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.routeId], route),
    projectReference(t, [t.containerId], container),
    projectReference(t, [t.propertyId], property),
    projectReference(t, [t.sharedCollectionPointId], sharedCollectionPoint),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    tenantUnique(t, t.routeId, t.containerId),
    projectKey(t, t.routeId),
    oneOf(t.status, PICKUP_STATUSES),
    oneOf(t.origin, PICKUP_ORIGINS),
    oneOf(t.reason, PICKUP_REASONS),
    positive(t.position),
    exactlyOne(t, "place", [t.propertyId, t.sharedCollectionPointId]),
    check(tableObjectName(t.id.table, "container_shape", "pickup"), sql`${t.containerId} is not null or ${t.origin} = 'office'`),
    check(tableObjectName(t.id.table, "outcome_shape", "pickup"), sql`(${t.status} <> 'planned') = (${t.outcomeAt} is not null)`),
    check(tableObjectName(t.id.table, "reason_shape", "pickup"), sql`(${t.status} in ('skipped', 'failed')) = (${t.reason} is not null)`),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.containerId),
    tenantIndex(t, t.propertyId),
    tenantIndex(t, t.sharedCollectionPointId),
    tenantIndex(t, t.wasteFractionId),
    tenantIndex(t, t.routeId, t.position),
  ],
)

export const pickupAsOf0023 = wms.table(
  "pickup",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    routeId: uuid().notNull(),
    containerId: uuid(),
    position: integer().notNull(),
    status: text().notNull().default("planned"),
    origin: text().notNull().default("generation"),
    service: text().notNull().default("empty"),
    note: text(),
    propertyId: uuid(),
    sharedCollectionPointId: uuid(),
    wasteFractionId: uuid().notNull(),
    arrivedAt: instant(),
    outcomeAt: instant(),
    reason: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.routeId], route),
    projectReference(t, [t.containerId], container),
    projectReference(t, [t.propertyId], property),
    projectReference(t, [t.sharedCollectionPointId], sharedCollectionPoint),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    uniqueIndex(tableObjectName(t.id.table, "route_id_container_id_key", "pickup"))
      .on(t.companyId, t.routeId, t.containerId)
      .where(sql`${t.origin} = 'generation'`),
    projectKey(t, t.routeId),
    oneOf(t.status, PICKUP_STATUSES),
    oneOf(t.origin, PICKUP_ORIGINS),
    oneOf(t.service, SERVICES_UNTIL_0053),
    check(tableObjectName(t.id.table, "service_origin_shape", "pickup"), sql`${t.service} = 'empty' or ${t.origin} = 'office'`),
    check(tableObjectName(t.id.table, "service_container_shape", "pickup"), sql`${t.service} = 'empty' or ${t.containerId} is not null`),
    oneOf(t.reason, PICKUP_REASONS),
    positive(t.position),
    exactlyOne(t, "place", [t.propertyId, t.sharedCollectionPointId]),
    check(tableObjectName(t.id.table, "container_shape", "pickup"), sql`${t.containerId} is not null or ${t.origin} = 'office'`),
    check(tableObjectName(t.id.table, "outcome_shape", "pickup"), sql`(${t.status} <> 'planned') = (${t.outcomeAt} is not null)`),
    check(tableObjectName(t.id.table, "reason_shape", "pickup"), sql`(${t.status} in ('skipped', 'failed')) = (${t.reason} is not null)`),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.containerId),
    tenantIndex(t, t.propertyId),
    tenantIndex(t, t.sharedCollectionPointId),
    tenantIndex(t, t.wasteFractionId),
    tenantIndex(t, t.routeId, t.position),
  ],
)

export const pickupAsOf0032 = wms.table(
  "pickup",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    routeId: uuid().notNull(),
    containerId: uuid(),
    position: integer().notNull(),
    status: text().notNull().default("planned"),
    origin: text().notNull().default("generation"),
    service: text().notNull().default("empty"),
    note: text(),
    propertyId: uuid(),
    sharedCollectionPointId: uuid(),
    wasteFractionId: uuid().notNull(),
    arrivedAt: instant(),
    outcomeAt: instant(),
    reason: text(),
    subscriptionId: uuid(),
    warehouseId: uuid(),
    replacementContainerId: uuid(),
    reservedContainerId: uuid().generatedAlwaysAs(
      sql`case when "status" = 'planned' then case "service" when 'deliver' then "container_id" when 'swap' then "replacement_container_id" end end`,
    ),
    takenContainerId: uuid().generatedAlwaysAs(sql`case when "status" = 'planned' and "service" in ('remove', 'swap') then "container_id" end`),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.routeId], route),
    projectReference(t, [t.containerId], container),
    projectReference(t, [t.subscriptionId], subscription),
    projectReference(t, [t.warehouseId], warehouse),
    projectReference(t, [t.replacementContainerId], container),
    projectReference(t, [t.propertyId], property),
    projectReference(t, [t.sharedCollectionPointId], sharedCollectionPoint),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    // One of generation's stops per container on a route; the office's may repeat a container already there (O3 of #290).
    uniqueIndex(tableObjectName(t.id.table, "route_id_container_id_key", "pickup"))
      .on(t.companyId, t.routeId, t.containerId)
      .where(sql`${t.origin} = 'generation'`),
    // Carries the route: a proof or a receipt names a pickup of the route it names, and no other.
    projectKey(t, t.routeId),
    oneOf(t.status, PICKUP_STATUSES),
    oneOf(t.origin, PICKUP_ORIGINS),
    oneOf(t.service, SERVICES_UNTIL_0053),
    // Generation empties; a work order is the office's.
    check(tableObjectName(t.id.table, "service_origin_shape", "pickup"), sql`${t.service} = 'empty' or ${t.origin} = 'office'`),
    // A work order is of a container; an address-only stop empties.
    check(tableObjectName(t.id.table, "service_container_shape", "pickup"), sql`${t.service} = 'empty' or ${t.containerId} is not null`),
    // What each service books beside its container, and nothing else books it (O3b of #290, `BOOKED_WITH`).
    check(tableObjectName(t.id.table, "subscription_shape", "pickup"), sql`(${t.service} = 'deliver') = (${t.subscriptionId} is not null)`),
    check(tableObjectName(t.id.table, "warehouse_shape", "pickup"), sql`(${t.service} in ('remove', 'swap')) = (${t.warehouseId} is not null)`),
    check(tableObjectName(t.id.table, "replacement_shape", "pickup"), sql`(${t.service} = 'swap') = (${t.replacementContainerId} is not null) and (${t.replacementContainerId} is null or ${t.replacementContainerId} <> ${t.containerId})`),
    // A stock container is held back by one planned delivery or swap at a time, and one in service taken away by one planned removal or swap.
    uniqueIndex(tableObjectName(t.id.table, "reserved_container_id_key", "pickup")).on(t.companyId, t.reservedContainerId).where(sql`${t.reservedContainerId} is not null`),
    uniqueIndex(tableObjectName(t.id.table, "taken_container_id_key", "pickup")).on(t.companyId, t.takenContainerId).where(sql`${t.takenContainerId} is not null`),
    oneOf(t.reason, PICKUP_REASONS),
    positive(t.position),
    // Every pickup names its place, an address-only one included: the address the stop is at.
    exactlyOne(t, "place", [t.propertyId, t.sharedCollectionPointId]),
    // A stop without a container is the office's (#111): generation always plans a container.
    check(tableObjectName(t.id.table, "container_shape", "pickup"), sql`${t.containerId} is not null or ${t.origin} = 'office'`),
    check(tableObjectName(t.id.table, "outcome_shape", "pickup"), sql`(${t.status} <> 'planned') = (${t.outcomeAt} is not null)`),
    check(tableObjectName(t.id.table, "reason_shape", "pickup"), sql`(${t.status} in ('skipped', 'failed')) = (${t.reason} is not null)`),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.containerId),
    tenantIndex(t, t.propertyId),
    tenantIndex(t, t.sharedCollectionPointId),
    tenantIndex(t, t.wasteFractionId),
    tenantIndex(t, t.subscriptionId),
    tenantIndex(t, t.warehouseId),
    tenantIndex(t, t.replacementContainerId),
    // The stop list in order.
    tenantIndex(t, t.routeId, t.position),
  ],
)

export const pickupAsOf0038 = wms.table(
  "pickup",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    routeId: uuid().notNull(),
    containerId: uuid(),
    position: integer().notNull(),
    status: text().notNull().default("planned"),
    origin: text().notNull().default("generation"),
    service: text().notNull().default("empty"),
    note: text(),
    propertyId: uuid(),
    sharedCollectionPointId: uuid(),
    wasteFractionId: uuid().notNull(),
    arrivedAt: instant(),
    outcomeAt: instant(),
    reason: text(),
    subscriptionId: uuid(),
    warehouseId: uuid(),
    replacementContainerId: uuid(),
    reservedContainerId: uuid().generatedAlwaysAs(
      sql`case when "status" = 'planned' then case "service" when 'deliver' then "container_id" when 'swap' then "replacement_container_id" end end`,
    ),
    takenContainerId: uuid().generatedAlwaysAs(sql`case when "status" = 'planned' and "service" in ('remove', 'swap') then "container_id" end`),
    contaminantCodeId: uuid(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.routeId], route),
    tenantReference(t, [t.contaminantCodeId], contaminantCode),
    check(tableObjectName(t.id.table, "contaminant_code_shape", "pickup"), sql`${t.contaminantCodeId} is null or ${t.reason} = 'contamination' or ${t.status} = 'completed'`),
    projectReference(t, [t.containerId], container),
    projectReference(t, [t.subscriptionId], subscription),
    projectReference(t, [t.warehouseId], warehouse),
    projectReference(t, [t.replacementContainerId], container),
    projectReference(t, [t.propertyId], property),
    projectReference(t, [t.sharedCollectionPointId], sharedCollectionPoint),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    // One of generation's stops per container on a route; the office's may repeat a container already there (O3 of #290).
    uniqueIndex(tableObjectName(t.id.table, "route_id_container_id_key", "pickup"))
      .on(t.companyId, t.routeId, t.containerId)
      .where(sql`${t.origin} = 'generation'`),
    // Carries the route: a proof or a receipt names a pickup of the route it names, and no other.
    projectKey(t, t.routeId),
    oneOf(t.status, PICKUP_STATUSES),
    oneOf(t.origin, PICKUP_ORIGINS),
    oneOf(t.service, SERVICES_UNTIL_0053),
    // Generation empties; a work order is the office's.
    check(tableObjectName(t.id.table, "service_origin_shape", "pickup"), sql`${t.service} = 'empty' or ${t.origin} = 'office'`),
    // A work order is of a container; an address-only stop empties.
    check(tableObjectName(t.id.table, "service_container_shape", "pickup"), sql`${t.service} = 'empty' or ${t.containerId} is not null`),
    // What each service books beside its container, and nothing else books it (O3b of #290, `BOOKED_WITH`).
    check(tableObjectName(t.id.table, "subscription_shape", "pickup"), sql`(${t.service} = 'deliver') = (${t.subscriptionId} is not null)`),
    check(tableObjectName(t.id.table, "warehouse_shape", "pickup"), sql`(${t.service} in ('remove', 'swap')) = (${t.warehouseId} is not null)`),
    check(tableObjectName(t.id.table, "replacement_shape", "pickup"), sql`(${t.service} = 'swap') = (${t.replacementContainerId} is not null) and (${t.replacementContainerId} is null or ${t.replacementContainerId} <> ${t.containerId})`),
    // A stock container is held back by one planned delivery or swap at a time, and one in service taken away by one planned removal or swap.
    uniqueIndex(tableObjectName(t.id.table, "reserved_container_id_key", "pickup")).on(t.companyId, t.reservedContainerId).where(sql`${t.reservedContainerId} is not null`),
    uniqueIndex(tableObjectName(t.id.table, "taken_container_id_key", "pickup")).on(t.companyId, t.takenContainerId).where(sql`${t.takenContainerId} is not null`),
    oneOf(t.reason, PICKUP_REASONS),
    positive(t.position),
    // Every pickup names its place, an address-only one included: the address the stop is at.
    exactlyOne(t, "place", [t.propertyId, t.sharedCollectionPointId]),
    // A stop without a container is the office's (#111): generation always plans a container.
    check(tableObjectName(t.id.table, "container_shape", "pickup"), sql`${t.containerId} is not null or ${t.origin} = 'office'`),
    check(tableObjectName(t.id.table, "outcome_shape", "pickup"), sql`(${t.status} <> 'planned') = (${t.outcomeAt} is not null)`),
    check(tableObjectName(t.id.table, "reason_shape", "pickup"), sql`(${t.status} in ('skipped', 'failed')) = (${t.reason} is not null)`),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.containerId),
    tenantIndex(t, t.propertyId),
    tenantIndex(t, t.sharedCollectionPointId),
    tenantIndex(t, t.wasteFractionId),
    tenantIndex(t, t.subscriptionId),
    tenantIndex(t, t.warehouseId),
    tenantIndex(t, t.replacementContainerId),
    // The stop list in order.
    tenantIndex(t, t.routeId, t.position),
    tenantIndex(t, t.contaminantCodeId),
  ],
)
