// `ticket` and `ticket_event` as the migrations before 0031 left them, by
// era: the ticket as 0009 wrote it and 0015 still had it (the
// re-collection's route, and no stop of it), and as 0016 (#111) left it and
// 0024 still had it (the re-collection's stop, with its key through the
// route, its index and its check); the history as 0009 wrote it and 0024
// still had it. They spell 0009's eight sources and two visibilities: 0031
// (#291 slice 23b) grew both lists by `service-provider`, and an applied file
// is never edited, so the tests that diff to and from those files read the
// tables from here — ad-hoc-rendering.test.ts from 0015 to 0016, and
// provider-tickets-rendering.test.ts from 0016 to 0031. The ticket as 0031
// left it — 0016's columns with the grown sources — is the one 0033 (#291 C3)
// gave the product its completion charges, so ticket-charges-rendering.test.ts
// diffs from it to today.
import { TICKET_EVENT_KINDS, TICKET_KINDS, TICKET_PRIORITIES, TICKET_RESOLUTIONS, TICKET_STATUSES } from "@waste/domain/resolution/vocabulary"
import { sql } from "drizzle-orm"
import { check, getTableConfig, index, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "../schema/access"
import { agreement } from "../schema/agreements"
import { oneOf } from "../schema/checks"
import { id, projectScoped, recorded, timestamps } from "../schema/columns"
import { container } from "../schema/containers"
import { customer, property, sharedCollectionPoint } from "../schema/customers"
import { pickup, route } from "../schema/execution"
import { driver } from "../schema/fleet"
import { company, project } from "../schema/organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique, type ProjectTable } from "../schema/references"
import { ticketEvent } from "../schema/resolution"
import { wms } from "../schema/wms"

/** The sources 0009 spelled, and every file until 0031 kept. */
export const TICKET_SOURCES_AS_OF_0009 = ["office", "phone", "email", "portal", "driver-app", "dispatch", "import", "integration"] as const

/** The sources 0031 (#291 slice 23b) spelled: 0009's and the service provider's. */
export const TICKET_SOURCES_AS_OF_0031 = [...TICKET_SOURCES_AS_OF_0009, "service-provider"] as const

/** The visibilities 0009 spelled, and every file until 0031 kept. */
export const TICKET_VISIBILITIES_AS_OF_0009 = ["internal", "customer"] as const

const instant = () => timestamp({ withTimezone: true })

/** The columns every era before 0031 shares, in the schema's order up to the re-collection's route. */
const shared = () => ({
  ...id,
  ...projectScoped,
  ...timestamps,
  number: integer().notNull(),
  kind: text().notNull(),
  status: text().notNull().default("open"),
  priority: text().notNull().default("none"),
  source: text().notNull(),
  subject: text().notNull(),
  description: text().notNull(),
  occurredAt: instant().notNull(),
  dueAt: instant(),
  assigneeUserAccountId: uuid(),
  createdBy: uuid(),
  sourceEventId: uuid(),
  routeId: uuid(),
  pickupId: uuid(),
  containerId: uuid(),
  propertyId: uuid(),
  sharedCollectionPointId: uuid(),
  agreementId: uuid(),
  driverId: uuid(),
  customerId: uuid(),
  parentTicketId: uuid(),
  resolution: text(),
  recollectionRouteId: uuid(),
})

/** ticket as 0009 left it and 0015 still had it: the re-collection's route, and no stop of it. */
const ticketAsOf0015 = wms.table("ticket", { ...shared(), closedAt: instant() }, (t) => [
  companyReference(t, company),
  tenantReference(t, [t.projectId], project),
  tenantReference(t, [t.assigneeUserAccountId], userAccount),
  tenantReference(t, [t.createdBy], userAccount),
  projectReference(t, [t.routeId], route),
  projectReference(t, [t.routeId, t.pickupId], pickup, [pickup.routeId, pickup.id]),
  projectReference(t, [t.containerId], container),
  projectReference(t, [t.propertyId], property),
  projectReference(t, [t.sharedCollectionPointId], sharedCollectionPoint),
  projectReference(t, [t.agreementId], agreement),
  projectReference(t, [t.driverId], driver),
  tenantReference(t, [t.customerId], customer),
  projectReference(t, [t.parentTicketId], t as ProjectTable),
  projectReference(t, [t.recollectionRouteId], route),
  tenantUnique(t, t.number),
  projectKey(t),
  oneOf(t.kind, TICKET_KINDS),
  oneOf(t.status, TICKET_STATUSES),
  oneOf(t.priority, TICKET_PRIORITIES),
  oneOf(t.source, TICKET_SOURCES_AS_OF_0009),
  oneOf(t.resolution, TICKET_RESOLUTIONS),
  check(tableObjectName(t.id.table, "origin_shape", "ticket"), sql`(${t.createdBy} is null) = (${t.sourceEventId} is not null)`),
  check(tableObjectName(t.id.table, "pickup_shape", "ticket"), sql`${t.pickupId} is null or ${t.routeId} is not null`),
  check(tableObjectName(t.id.table, "parent_shape", "ticket"), sql`${t.parentTicketId} <> ${t.id}`),
  check(tableObjectName(t.id.table, "resolution_shape", "ticket"), sql`(${t.status} = 'completed') = (${t.resolution} is not null)`),
  check(tableObjectName(t.id.table, "recollection_shape", "ticket"), sql`${t.recollectionRouteId} is null or ${t.resolution} is not distinct from 'recollected'`),
  check(tableObjectName(t.id.table, "closed_shape", "ticket"), sql`(${t.status} in ('completed', 'rejected')) = (${t.closedAt} is not null)`),
  uniqueIndex(tableObjectName(t.companyId.table, "source_event_id_idx", "ticket")).on(t.companyId, t.sourceEventId).where(sql`${t.sourceEventId} is not null`),
  tenantIndex(t, t.projectId, t.status),
  tenantIndex(t, t.assigneeUserAccountId, t.status),
  tenantIndex(t, t.createdBy),
  tenantIndex(t, t.routeId),
  tenantIndex(t, t.pickupId),
  tenantIndex(t, t.containerId),
  tenantIndex(t, t.propertyId),
  tenantIndex(t, t.sharedCollectionPointId),
  tenantIndex(t, t.agreementId),
  tenantIndex(t, t.driverId),
  tenantIndex(t, t.customerId),
  tenantIndex(t, t.parentTicketId),
  tenantIndex(t, t.recollectionRouteId),
])

/** ticket as 0016 (#111) left it, the re-collection's stop with its key through the route, its check and its index — with 0009's sources until 0031, and 0031's after. */
const ticketWithStop = (sources: readonly string[]) =>
  wms.table("ticket", { ...shared(), recollectionPickupId: uuid(), closedAt: instant() }, (t) => [
  companyReference(t, company),
  tenantReference(t, [t.projectId], project),
  tenantReference(t, [t.assigneeUserAccountId], userAccount),
  tenantReference(t, [t.createdBy], userAccount),
  projectReference(t, [t.routeId], route),
  projectReference(t, [t.routeId, t.pickupId], pickup, [pickup.routeId, pickup.id]),
  projectReference(t, [t.containerId], container),
  projectReference(t, [t.propertyId], property),
  projectReference(t, [t.sharedCollectionPointId], sharedCollectionPoint),
  projectReference(t, [t.agreementId], agreement),
  projectReference(t, [t.driverId], driver),
  tenantReference(t, [t.customerId], customer),
  projectReference(t, [t.parentTicketId], t as ProjectTable),
  projectReference(t, [t.recollectionRouteId], route),
  projectReference(t, [t.recollectionRouteId, t.recollectionPickupId], pickup, [pickup.routeId, pickup.id]),
  tenantUnique(t, t.number),
  projectKey(t),
  oneOf(t.kind, TICKET_KINDS),
  oneOf(t.status, TICKET_STATUSES),
  oneOf(t.priority, TICKET_PRIORITIES),
  oneOf(t.source, sources),
  oneOf(t.resolution, TICKET_RESOLUTIONS),
  check(tableObjectName(t.id.table, "origin_shape", "ticket"), sql`(${t.createdBy} is null) = (${t.sourceEventId} is not null)`),
  check(tableObjectName(t.id.table, "pickup_shape", "ticket"), sql`${t.pickupId} is null or ${t.routeId} is not null`),
  check(tableObjectName(t.id.table, "parent_shape", "ticket"), sql`${t.parentTicketId} <> ${t.id}`),
  check(tableObjectName(t.id.table, "resolution_shape", "ticket"), sql`(${t.status} = 'completed') = (${t.resolution} is not null)`),
  check(tableObjectName(t.id.table, "recollection_shape", "ticket"), sql`${t.recollectionRouteId} is null or ${t.resolution} is not distinct from 'recollected'`),
  check(tableObjectName(t.id.table, "recollection_pickup_shape", "ticket"), sql`${t.recollectionPickupId} is null or ${t.recollectionRouteId} is not null`),
  check(tableObjectName(t.id.table, "closed_shape", "ticket"), sql`(${t.status} in ('completed', 'rejected')) = (${t.closedAt} is not null)`),
  uniqueIndex(tableObjectName(t.companyId.table, "source_event_id_idx", "ticket")).on(t.companyId, t.sourceEventId).where(sql`${t.sourceEventId} is not null`),
  tenantIndex(t, t.projectId, t.status),
  tenantIndex(t, t.assigneeUserAccountId, t.status),
  tenantIndex(t, t.createdBy),
  tenantIndex(t, t.routeId),
  tenantIndex(t, t.pickupId),
  tenantIndex(t, t.containerId),
  tenantIndex(t, t.propertyId),
  tenantIndex(t, t.sharedCollectionPointId),
  tenantIndex(t, t.agreementId),
  tenantIndex(t, t.driverId),
  tenantIndex(t, t.customerId),
  tenantIndex(t, t.parentTicketId),
  tenantIndex(t, t.recollectionRouteId),
  tenantIndex(t, t.recollectionPickupId),
])

const ticketAsOf0016 = ticketWithStop(TICKET_SOURCES_AS_OF_0009)
const ticketAsOf0031 = ticketWithStop(TICKET_SOURCES_AS_OF_0031)

/** The ticket as of an era before today's: `0015` without the re-collection's stop, `0016` with it, `0031` with the service provider's source too. */
export function ticketAsOf(era: "0015" | "0016" | "0031") {
  return era === "0015" ? ticketAsOf0015 : era === "0016" ? ticketAsOf0016 : ticketAsOf0031
}

/** The history's kind CASE as the schema builds it from TICKET_EVENT_SHAPES: one SQL, which renders the same text over any table named `ticket_event`. */
const KIND_SHAPE = (() => {
  const found = getTableConfig(ticketEvent).checks.find((candidate) => candidate.name === "ticket_event_kind_shape")
  if (found === undefined) throw new Error("ticket_event_kind_shape is not on the schema's ticket_event")
  return found.value
})()

/** ticket_event as 0009 wrote it and 0024 still had it: a comment for the office or for the customer. */
export const ticketEventAsOf0009 = wms.table(
  "ticket_event",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    ticketId: uuid().notNull(),
    kind: text().notNull(),
    status: text().notNull(),
    assigneeUserAccountId: uuid(),
    resolution: text(),
    body: text(),
    visibility: text().notNull().default("internal"),
    objectKey: text(),
    sourceEventId: uuid(),
    recordedBy: uuid(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.ticketId], ticketAsOf0016),
    tenantReference(t, [t.assigneeUserAccountId], userAccount),
    tenantReference(t, [t.recordedBy], userAccount),
    oneOf(t.kind, TICKET_EVENT_KINDS),
    oneOf(t.status, TICKET_STATUSES),
    oneOf(t.resolution, TICKET_RESOLUTIONS),
    oneOf(t.visibility, TICKET_VISIBILITIES_AS_OF_0009),
    check(tableObjectName(t.id.table, "kind_shape", "ticketEvent"), KIND_SHAPE),
    uniqueIndex(tableObjectName(t.companyId.table, "source_event_id_idx", "ticketEvent")).on(t.companyId, t.sourceEventId).where(sql`${t.sourceEventId} is not null`),
    index(tableObjectName(t.companyId.table, "ticket_id_idx", "ticketEvent")).on(t.companyId, t.ticketId, t.id),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.assigneeUserAccountId),
    tenantIndex(t, t.recordedBy),
  ],
)

