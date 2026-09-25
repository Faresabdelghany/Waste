// Resolution (Issue #109, ADR-0001, ADR-0004, ADR-0005): what has to be dealt
// with. The Ticket — "a case that owns the resolution of a request, deviation,
// complaint, task, or operational issue" — its appended history, and the
// Alert — "a condition that requires attention, notification, or
// acknowledgement and may create or link to a ticket". All three are a
// Project's (a Company resolves nothing outside one), all fenced; `ticket` and
// `alert` spread `timestamps` and carry the trigger, `ticket_event` spreads
// `recorded` and its file revokes UPDATE and DELETE from the API role
// (sql/append-only.ts), the fourth ledger keyed by the server after Resources'
// two and Execution's three. Every enum column is text under `oneOf` over a
// tuple of @waste/domain/resolution/vocabulary.
//
// `ticket` is the case. Its display `number` comes from the company's counter
// (`organisation.ts`, `next_ticket_number`; `T-8831` is presentation, the
// contracts' prefix), one number per create under the company's row lock,
// never renumbered. A ticket is a person's or an event's: `created_by` is the
// caller's account, or null for the ticket the outbox's consumer opens, whose
// `source_event_id` is then the `outbox_event.id` it was made from — a soft
// uuid on purpose (#109 §7.8: the outbox row outlives nothing and joins
// nothing, and a key from here would make it join something) and the
// consumer's idempotency key, a partial unique index the shape of
// `session_route_open_idx`; `ticket_origin_shape` ties the two together. What
// the ticket is about is nine links the database checks — a route, a pickup
// *of that route* through `pickup_route_id_project_key` (the shape a proof's
// reference has, with `ticket_pickup_shape` saying a pickup names its route,
// since Postgres leaves a composite key with a null member unchecked), a
// container, a property, a shared collection point, an agreement, a driver, a
// customer (the company's, since a Customer is), and a parent ticket through
// the table's own project key, `ticket_parent_shape` refusing a ticket its own
// parent — any, several or none, since an internal task is a ticket about
// nothing but itself. Three shape checks hold the closing columns to the
// status: `ticket_resolution_shape` (a completed ticket has a resolution and
// no other does), `ticket_recollection_shape` (the route a re-collection rides
// on goes with `recollected`) and `ticket_closed_shape` (a closed ticket has
// its instant); `reopen` clears all three, and the history keeps the closing.
// Nothing here is effective-dated: a ticket carries a status, which is what a
// record with no period does.
//
// `ticket_event` is the history: every write to `ticket`'s row is followed by
// one row here in the same transaction (the allocation's `appendEvent` rule,
// #101), and a comment is a row here that touches the ticket's row not at all.
// Each row is a snapshot — the status and the assignee after the event — so
// the history reads without the row. `ticket_event_kind_shape` is one CASE
// built from the domain's `TICKET_EVENT_SHAPES`
// (@waste/domain/resolution/event-shapes), the `proof_of_service_kind_shape`
// precedent, so the table and the check are one spelling and the database
// test holds the rendered CASE to `ticketEventShape` over every kind and
// column: a `created` row says nothing but the status and the assignee, an
// `assigned` or `status-changed` row may carry the command's note, a
// `status-changed` row carries a resolution exactly when its status is
// `completed`, and a `comment` carries a body, may carry an attachment's
// Storage key (`<company_id>/<ticket_id>/<event_id>.<ext>` in
// `ticket-attachments`, held to the row's own ids by the API) and may be the
// customer's to read (`visibility`); every other kind is `internal`. A
// consumer's comment — a `command-rejected` folded into the driver's open
// case — carries the event's id as its own `source_event_id`, the second
// idempotency key. The history's index leads with the ticket, so it is the
// reference's index too, as `proof_of_service_route_id_idx` is.
//
// `alert` is current state and no ledger: acknowledged once and resolved
// once, with the instants and the accounts as columns held to the status by
// `alert_stamps_shape`, a CASE the way `route_stamps_shape` is — `new`
// carries neither instant, `acknowledged` the first and not the second,
// `resolved` the second, the first either way, since a resolved alert may
// never have been acknowledged — and each pair together or not at all
// (`alert_acknowledged_shape`, `alert_resolved_shape`, the resolution note
// going with a resolution). `alert_subject_shape` is the prototype's own
// validation: an alert names a route, a vehicle, a driver or a container, or
// it is about nothing and is nothing. `ticket_id` is the one ticket it
// created or was linked to; "linked to ticket" is this column not null.
// Nothing points at an alert, so it carries no project key; and it has no
// display number, being named by its title.
import { TICKET_EVENT_SHAPES } from "@waste/domain/resolution/event-shapes"
import { ALERT_KINDS, ALERT_SEVERITIES, ALERT_SOURCES, ALERT_STATUSES, TICKET_EVENT_KINDS, TICKET_KINDS, TICKET_PRIORITIES, TICKET_RESOLUTIONS, TICKET_SOURCES, TICKET_STATUSES, TICKET_VISIBILITIES } from "@waste/domain/resolution/vocabulary"
import { sql, type SQL } from "drizzle-orm"
import { check, index, integer, text, timestamp, uniqueIndex, uuid, type PgColumn } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "./access"
import { agreement } from "./agreements"
import { literal, oneOf } from "./checks"
import { id, projectScoped, recorded, timestamps } from "./columns"
import { container } from "./containers"
import { customer, property, sharedCollectionPoint } from "./customers"
import { pickup, route } from "./execution"
import { driver, vehicle } from "./fleet"
import { company, project } from "./organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique, type ProjectTable } from "./references"
import { wms } from "./wms"

const instant = () => timestamp({ withTimezone: true })

export const ticket = wms.table(
  "ticket",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    /** The display number, `T-8831` on the wire; from the company's counter, never renumbered. */
    number: integer().notNull(),
    kind: text().notNull(),
    status: text().notNull().default("open"),
    priority: text().notNull().default("none"),
    /** Provenance; never patched. */
    source: text().notNull(),
    /** The case's headline and its description: the office's or the citizen's own words. */
    subject: text().notNull(),
    description: text().notNull(),
    /** When the issue or request happened: the caller's word, or the event's; not when the row was made. */
    occurredAt: instant().notNull(),
    /** The response target; the caller's until a ticket type supplies an SLA. */
    dueAt: instant(),
    /** Who works it; null is unassigned. Moved by `assign` and by nothing else. */
    assigneeUserAccountId: uuid(),
    /** The caller's account, or null for the consumer's ticket. */
    createdBy: uuid(),
    /** The outbox event the consumer made it from: a soft uuid, and the idempotency key. */
    sourceEventId: uuid(),
    /** What the ticket is about, as keys the database checks; any, several or none. */
    routeId: uuid(),
    /** A pickup of the route the ticket names, and no other. */
    pickupId: uuid(),
    containerId: uuid(),
    propertyId: uuid(),
    sharedCollectionPointId: uuid(),
    agreementId: uuid(),
    driverId: uuid(),
    customerId: uuid(),
    /** A sub-case's parent; never itself. */
    parentTicketId: uuid(),
    /** What a completed ticket ended in; null otherwise. */
    resolution: text(),
    /** The route the re-collection rides on, with `recollected`. */
    recollectionRouteId: uuid(),
    /** When the ticket was completed or rejected; cleared by reopen. */
    closedAt: instant(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.assigneeUserAccountId], userAccount),
    tenantReference(t, [t.createdBy], userAccount),
    projectReference(t, [t.routeId], route),
    // The pickup of the route the ticket names: the key carries the route on both sides.
    projectReference(t, [t.routeId, t.pickupId], pickup, [pickup.routeId, pickup.id]),
    projectReference(t, [t.containerId], container),
    projectReference(t, [t.propertyId], property),
    projectReference(t, [t.sharedCollectionPointId], sharedCollectionPoint),
    projectReference(t, [t.agreementId], agreement),
    projectReference(t, [t.driverId], driver),
    tenantReference(t, [t.customerId], customer),
    // The parent is a ticket of the same project, through this table's own project key.
    projectReference(t, [t.parentTicketId], t as ProjectTable),
    projectReference(t, [t.recollectionRouteId], route),
    tenantUnique(t, t.number),
    projectKey(t),
    oneOf(t.kind, TICKET_KINDS),
    oneOf(t.status, TICKET_STATUSES),
    oneOf(t.priority, TICKET_PRIORITIES),
    oneOf(t.source, TICKET_SOURCES),
    oneOf(t.resolution, TICKET_RESOLUTIONS),
    // A ticket is a person's or an event's.
    check(tableObjectName(t.id.table, "origin_shape", "ticket"), sql`(${t.createdBy} is null) = (${t.sourceEventId} is not null)`),
    // A pickup names its route: Postgres leaves a composite key with a null member unchecked.
    check(tableObjectName(t.id.table, "pickup_shape", "ticket"), sql`${t.pickupId} is null or ${t.routeId} is not null`),
    // A ticket is not its own parent; a null passes.
    check(tableObjectName(t.id.table, "parent_shape", "ticket"), sql`${t.parentTicketId} <> ${t.id}`),
    // A completed ticket ended in something, and no other ticket did.
    check(tableObjectName(t.id.table, "resolution_shape", "ticket"), sql`(${t.status} = 'completed') = (${t.resolution} is not null)`),
    // The route a re-collection rides on goes with the resolution that says one was arranged. `is not distinct from`, because `null = 'recollected'` is null and a null check passes: an open ticket has no resolution and may still not carry the route.
    check(tableObjectName(t.id.table, "recollection_shape", "ticket"), sql`${t.recollectionRouteId} is null or ${t.resolution} is not distinct from 'recollected'`),
    // A closed ticket has the instant it closed, and an open one none.
    check(tableObjectName(t.id.table, "closed_shape", "ticket"), sql`(${t.status} in ('completed', 'rejected')) = (${t.closedAt} is not null)`),
    // The consumer's idempotency key: one ticket per outbox event, the rows with one in the index and only those.
    uniqueIndex(tableObjectName(t.companyId.table, "source_event_id_idx", "ticket")).on(t.companyId, t.sourceEventId).where(sql`${t.sourceEventId} is not null`),
    // The queue and my tickets: each leads with its reference column, so it is that reference's index too.
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
  ],
)

/** One `WHEN` of the kind CASE: what the kind carries and forbids, as SQL over the row's columns. */
function kindClause(kind: (typeof TICKET_EVENT_KINDS)[number], columns: { status: PgColumn; body: PgColumn; objectKey: PgColumn; visibility: PgColumn; resolution: PgColumn }): SQL {
  const shape = TICKET_EVENT_SHAPES[kind]
  const terms: SQL[] = []
  for (const column of ["body", "objectKey"] as const) {
    const presence = shape[column]
    if (presence === "required") terms.push(sql`${columns[column]} is not null`)
    else if (presence === "none") terms.push(sql`${columns[column]} is null`)
  }
  if (shape.visibility === "internal") terms.push(sql`${columns.visibility} = 'internal'`)
  terms.push(shape.resolution === "none" ? sql`${columns.resolution} is null` : sql`(${columns.status} = 'completed') = (${columns.resolution} is not null)`)
  return sql`when ${sql.raw(literal(kind))} then ${sql.join(terms, sql` and `)}`
}

export const ticketEvent = wms.table(
  "ticket_event",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    ticketId: uuid().notNull(),
    kind: text().notNull(),
    /** The ticket's status after the event: a snapshot, so the history reads without the row. */
    status: text().notNull(),
    /** The assignee after the event, likewise. */
    assigneeUserAccountId: uuid(),
    /** On a status change to completed: what the ticket ended in. */
    resolution: text(),
    /** The comment, the note a command carried, the reason a rejection gave. */
    body: text(),
    /** Who may read it: `customer` on a comment the customer may read. */
    visibility: text().notNull().default("internal"),
    /** The Storage object of an attachment on a comment, under the row's own ids. */
    objectKey: text(),
    /** The outbox event a consumer's comment came from: the second idempotency key. */
    sourceEventId: uuid(),
    /** The caller, or null for the consumer's rows. */
    recordedBy: uuid(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.ticketId], ticket),
    tenantReference(t, [t.assigneeUserAccountId], userAccount),
    tenantReference(t, [t.recordedBy], userAccount),
    oneOf(t.kind, TICKET_EVENT_KINDS),
    oneOf(t.status, TICKET_STATUSES),
    oneOf(t.resolution, TICKET_RESOLUTIONS),
    oneOf(t.visibility, TICKET_VISIBILITIES),
    // What each kind carries and forbids: one CASE built from TICKET_EVENT_SHAPES, the one spelling of the table.
    check(tableObjectName(t.id.table, "kind_shape", "ticketEvent"), sql`case ${t.kind} ${sql.join(TICKET_EVENT_KINDS.map((kind) => kindClause(kind, t)), sql` `)} else false end`),
    // One comment per outbox event: the consumer's second idempotency key.
    uniqueIndex(tableObjectName(t.companyId.table, "source_event_id_idx", "ticketEvent")).on(t.companyId, t.sourceEventId).where(sql`${t.sourceEventId} is not null`),
    // A ticket's history in recording order: leads with the ticket, so it is the index the reference needs too.
    index(tableObjectName(t.companyId.table, "ticket_id_idx", "ticketEvent")).on(t.companyId, t.ticketId, t.id),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.assigneeUserAccountId),
    tenantIndex(t, t.recordedBy),
  ],
)

export const alert = wms.table(
  "alert",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    kind: text().notNull(),
    severity: text().notNull(),
    /** Who raised it: `manual` for every row the office writes. */
    source: text().notNull(),
    status: text().notNull().default("new"),
    title: text().notNull(),
    details: text().notNull(),
    /** When the condition was seen: the caller's, defaulting to the clock. */
    detectedAt: instant().notNull(),
    /** What the alert is about: at least one of the four. */
    routeId: uuid(),
    vehicleId: uuid(),
    driverId: uuid(),
    containerId: uuid(),
    /** The ticket the alert created or was linked to; "linked to ticket" is this not null. */
    ticketId: uuid(),
    /** The caller; null for a source that is not a person. */
    raisedBy: uuid(),
    /** Together or not at all. */
    acknowledgedAt: instant(),
    acknowledgedBy: uuid(),
    /** Together or not at all, the note only with them. */
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
    // An alert about nothing is nothing: the prototype's own validation.
    check(
      tableObjectName(t.id.table, "subject_shape", "alert"),
      sql`(${t.routeId} is not null)::int + (${t.vehicleId} is not null)::int + (${t.driverId} is not null)::int + (${t.containerId} is not null)::int >= 1`,
    ),
    // The acknowledgement's instant and account come together or not at all; so do the resolution's, and its note only with them.
    check(tableObjectName(t.id.table, "acknowledged_shape", "alert"), sql`(${t.acknowledgedAt} is null) = (${t.acknowledgedBy} is null)`),
    check(tableObjectName(t.id.table, "resolved_shape", "alert"), sql`(${t.resolvedAt} is null) = (${t.resolvedBy} is null) and (${t.resolutionNote} is null or ${t.resolvedAt} is not null)`),
    // Which stamps each status carries: a resolved alert may never have been acknowledged.
    check(
      tableObjectName(t.id.table, "stamps_shape", "alert"),
      sql`case ${t.status} when 'new' then ${t.acknowledgedAt} is null and ${t.resolvedAt} is null when 'acknowledged' then ${t.acknowledgedAt} is not null and ${t.resolvedAt} is null when 'resolved' then ${t.resolvedAt} is not null else false end`,
    ),
    // The board: leads with the project, so it is the project reference's index too.
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
