// `pickup` as 0016 (#111) left it and 0018 still had it: the office's stop
// and its origin, one stop per container on a route under a unique
// constraint, and no service. ad-hoc-rendering.test.ts diffs to it and
// stop-service-rendering.test.ts from it, since an applied file is never
// edited and the schema module spells the table as it is today. And as 0023
// (O3 of #290) left it: the stop's service, generation's key held to its own
// stops, and no ledger booking — stop-service-rendering.test.ts diffs to it
// and stop-ledger-rendering.test.ts from it.
import { PICKUP_ORIGINS, PICKUP_REASONS, PICKUP_SERVICES, PICKUP_STATUSES } from "@waste/domain/execution/vocabulary"
import { sql } from "drizzle-orm"
import { check, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { wasteFraction } from "../schema/catalogue"
import { exactlyOne, oneOf, positive } from "../schema/checks"
import { id, projectScoped, timestamps } from "../schema/columns"
import { container } from "../schema/containers"
import { property, sharedCollectionPoint } from "../schema/customers"
import { route } from "../schema/execution"
import { company, project } from "../schema/organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "../schema/references"
import { wms } from "../schema/wms"

const instant = () => timestamp({ withTimezone: true })

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
    oneOf(t.service, PICKUP_SERVICES),
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
