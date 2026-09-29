// Execution (Issue #104, ADR-0002, ADR-0003, ADR-0004): work as it happens.
// The dated Route and its Pickups — one record each from planning through
// execution — the Session a driver's device runs a Route in, the two ledgers
// appended to them, Proof of Service and Unload, the receipt of every command
// a device ever sent, and the outbox the other contexts hear from. All seven
// are a Project's (work happens in one), all fenced; `route`, `pickup`,
// `session` and `outbox_event` spread `timestamps` and carry the trigger,
// the three ledgers spread `recorded` and their file revokes UPDATE and
// DELETE from the API role (sql/append-only.ts). Every enum column is text
// under `oneOf` over a tuple of @waste/domain/execution/vocabulary.
//
// `route` and `pickup` are created here in full because #97 part B, which
// planned the minimal pair, waits for a host and this does not (#104 §1): the
// columns generation writes — the scheme, the group, the service date that is
// the identity (`route_generation_key`, ADR-0002), the operating date the
// route runs on, the status, the holiday note — and this context's: the
// display `number` from the company's counter (`organisation.ts`,
// `next_route_number`; `RC-1042` is presentation, the contracts' prefix), the
// Planned Assignment as columns and not a ledger (#104 §7.2: the glossary's
// two terms are two singular states of one route, the history the audit
// log's), the Actual Assignment written once when a session starts the route
// and never by a form, and the four instants the status moved. Two shape
// checks hold the columns to the status: `route_stamps_shape` says which
// stamps a status carries — a cancelled route keeps the stamps of what it
// had done, since cancelling an active route is evidence and not erasure —
// and `route_actual_shape` says a route that started has the driver, the
// vehicle and, where one went out, the trailer that started it, and one that
// did not has none. `generation_run_id` arrived with `generation_run` in #97
// B's file, migration 0012, with its key: the run that last wrote the route,
// null on a route no run has written.
//
// `pickup` carries the place and the fraction on the service date as keys
// (#104 §7.11): a placement that moves next month must not move a pickup
// generated for this week, so generation resolves the subscription's place
// and the placement's fraction once and the pickup names them; the address
// stays the property's. Its `projectKey` carries the route
// (`pickup_route_id_project_key`), so a proof or a receipt names a pickup of
// the route it names and no other, the way the Stock Movement ledger names a
// placement of the container it moves. `pickup_outcome_shape` and
// `pickup_reason_shape` hold `outcome_at` to a status that has left
// `planned` and a reason to a skip or a failure.
//
// `session` is per Route, from `start-route` to `end-route` (#104 §7.3), its
// id the start command's; open or ended is a reading of `ended_at`, paused of
// `paused_at`, and there is no status column (§7.4). Two partial unique
// indexes are the rules the API answers with a sentence: one live session per
// route (`session_route_open_idx`) and one per driver (`session_driver_open_idx`).
// Its `projectKey` carries the route too, for the same reason as the pickup's.
//
// `proof_of_service` is one ledger for twelve kinds (§7.13), each with a
// shape: `proof_of_service_kind_shape` is one CASE built from the domain's
// `PROOF_SHAPES` (execution/proof-shapes.ts), so the table and the check are
// one spelling and the database test holds the rendered CASE to `proofShape`
// over every kind; `proof_of_service_pickup_shape` says which kinds are a
// stop's, which are the route's own (`route-started`, `route-ended`) and
// which may stand on the route alone, from the same table; and
// `_session_shape`, which `unload` shares, says a driver-recorded row names
// its session and an office row names none. `object_key` is the Storage
// object of a photo or a signature, which the API holds to the row's own ids.
//
// `unload` is the glossary's event at an Unloading Station — any station of
// the company, the route's planned one being a default the device offers —
// with its weights in whole kilograms (§7.15): `net_kg` is given, gross and
// tare come together or not at all, and where both are given net is gross
// less tare (`unload_weights_shape`, the prototype's own sentence). Weight
// control is Finance's review over these rows (Issue #112, `weight_review`):
// a wrong unload is corrected there by a new row naming the old and nothing
// here is updated, and the row carries `unload_project_key` since 0010 for
// the review to point at.
//
// `driver_command` is the receipt: one row per command a device ever sent,
// applied or rejected, keyed by the client's id (§7.5) — the idempotency
// table, the place a rejected command is kept, and what syncs back down so
// the device shows the outcome. Where a command made a row (a session, a
// proof, an unload) that row carries the same id in its own table. `body` and
// `problem` are the two `jsonb` columns of this context beside the outbox's
// `payload` (§7.6): kept verbatim for another reader, never queried by
// column, and `driver_command_problem_shape` gives a rejected command its
// problem and an applied one none. A receipt is writable for any rejection,
// or "never silently dropped" (ADR-0004) would be false: `route_id` is
// nullable, since a command refused because no such route is assigned to the
// driver has no route the key could check — the device's claimed id stays in
// `body`, the column is null, and `driver_command_route_shape` holds such a
// row to a rejection naming no session and no pickup; the composite key
// stands and Postgres leaves a row with a null member unchecked. The project
// stays NOT NULL and is the driver's own where no route says otherwise, so
// the row is the project's like every Execution row and the driver key stays
// checked; the driver's log, `(company_id, driver_id, id)`, is what the sync
// rules' driver bucket reads, a receipt without a route included.
//
// `outbox_event` is written in the request's transaction after the rows it
// describes and stamped `published_at` by the relay (part C), so it spreads
// `timestamps` and is not a ledger (§7.22). `aggregate_id` is a soft uuid on
// purpose — the one in the schema — since an outbox row outlives nothing and
// joins nothing; its index is the second without the tenant after the hook's
// e-mail index, for the same reason: the relay's read is one statement in the
// system that crosses companies.
import { PROOF_SHAPES } from "@waste/domain/execution/proof-shapes"
import { COMMAND_OUTCOMES, DRIVER_COMMAND_KINDS, EXECUTION_SOURCES, OUTBOX_AGGREGATES, OUTBOX_KINDS, PICKUP_OUTCOMES, PICKUP_REASONS, PICKUP_STATUSES, PROOF_KINDS, ROUTE_STATUSES } from "@waste/domain/execution/vocabulary"
import { sql, type SQL } from "drizzle-orm"
import { boolean, check, date, index, integer, jsonb, text, time, timestamp, unique, uniqueIndex, uuid, type PgColumn } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "./access"
import { wasteFraction } from "./catalogue"
import { exactlyOne, literal, oneOf, positive } from "./checks"
import { id, projectScoped, recorded, timestamps } from "./columns"
import { container } from "./containers"
import { property, sharedCollectionPoint } from "./customers"
import { driver, vehicle } from "./fleet"
import { generationRun } from "./generation"
import { geometry, validGeometry } from "./geometry"
import { company, project, serviceProvider } from "./organisation"
import { depot, unloadingStation } from "./places"
import { companyReference, indexOn, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "./references"
import { collectionGroup, routeScheme } from "./route-schemes"
import { wms } from "./wms"

const instant = () => timestamp({ withTimezone: true })

export const route = wms.table(
  "route",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    routeSchemeId: uuid().notNull(),
    collectionGroupId: uuid().notNull(),
    /** The day the recurrence named: the identity, with the scheme and the group (ADR-0002). Never moves. */
    serviceDate: date().notNull(),
    /** The day the route runs: the service date, or the day a holiday policy or a reschedule moved it to. */
    operatingDate: date().notNull(),
    status: text().notNull().default("planned"),
    /** Whether a regeneration cancelled it, as against a dispatcher. */
    cancelledByGeneration: boolean().notNull().default(false),
    /** The deviation note: the holiday note, the regeneration sentence, or the dispatcher's cancel reason. */
    note: text(),
    /** The generation run that last wrote the route (#97 part B, migration 0012); null on a route no run has written. */
    generationRunId: uuid(),
    /** The active Plan (#39 S1, migration 0013): the execution sequence when set; null means the generated baseline stands unmeasured, drawn dashed (#124). */
    activePlanId: uuid(),
    /** The display number, `RC-1042` on the wire; from the company's counter, never renumbered. */
    number: integer().notNull(),
    /** Copied from the scheme at creation; a time on the project's clock. */
    plannedStartTime: time(),
    /** The Planned Assignment: what is expected to run the route, copied from the group and the scheme while planned, moved by the dispatcher. */
    plannedVehicleId: uuid(),
    plannedDriverId: uuid(),
    /** A vehicle of kind `trailer`; the API holds the kind. */
    plannedTrailerId: uuid(),
    depotId: uuid(),
    plannedServiceProviderId: uuid(),
    unloadingStationId: uuid(),
    /** The Actual Assignment: what the session that started the route went out with, written once and never by a form. */
    actualVehicleId: uuid(),
    actualDriverId: uuid(),
    actualTrailerId: uuid(),
    /** The instants the status moved, evidence beside the status. */
    dispatchedAt: instant(),
    startedAt: instant(),
    completedAt: instant(),
    cancelledAt: instant(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.routeSchemeId], routeScheme),
    projectReference(t, [t.collectionGroupId], collectionGroup),
    projectReference(t, [t.plannedVehicleId], vehicle),
    projectReference(t, [t.plannedTrailerId], vehicle),
    projectReference(t, [t.plannedDriverId], driver),
    projectReference(t, [t.depotId], depot),
    tenantReference(t, [t.plannedServiceProviderId], serviceProvider),
    tenantReference(t, [t.unloadingStationId], unloadingStation),
    projectReference(t, [t.actualVehicleId], vehicle),
    projectReference(t, [t.actualTrailerId], vehicle),
    projectReference(t, [t.actualDriverId], driver),
    projectReference(t, [t.generationRunId], generationRun),
    // The key on active_plan_id is hand-written (src/sql/active-plan.ts): a plan of this route, and no other's,
    // ON DELETE SET NULL (active_plan_id) — the column subset Drizzle cannot express, without which a multi-column
    // SET NULL would null company_id and the route's own id. Out of Drizzle's sight, it is also out of sweepOrder's,
    // which is right: a self-clearing edge forces no order (reset-to-seed.ts).
    // ADR-0002's identity: one route per scheme, group and service date. Named for what it is, the way #97 spelled it.
    unique(tableObjectName(t.companyId.table, "generation_key", "route")).on(t.companyId, t.routeSchemeId, t.collectionGroupId, t.serviceDate),
    tenantUnique(t, t.number),
    projectKey(t),
    oneOf(t.status, ROUTE_STATUSES),
    // A route that started has the driver and the vehicle that started it, and a trailer only then; one that did not has none. Read off `started_at`, which the stamps check ties to the status.
    check(
      tableObjectName(t.id.table, "actual_shape", "route"),
      sql`(${t.actualDriverId} is not null) = (${t.startedAt} is not null) and (${t.actualVehicleId} is not null) = (${t.startedAt} is not null) and (${t.actualTrailerId} is null or ${t.startedAt} is not null)`,
    ),
    // Which stamps each status carries. A cancelled route keeps what it had done — dispatched, started — since cancelling is evidence, not erasure; a completed one never carries a cancellation.
    check(
      tableObjectName(t.id.table, "stamps_shape", "route"),
      sql`case ${t.status} when 'planned' then ${t.dispatchedAt} is null and ${t.startedAt} is null and ${t.completedAt} is null and ${t.cancelledAt} is null when 'ready' then ${t.dispatchedAt} is not null and ${t.startedAt} is null and ${t.completedAt} is null and ${t.cancelledAt} is null when 'active' then ${t.dispatchedAt} is not null and ${t.startedAt} is not null and ${t.completedAt} is null and ${t.cancelledAt} is null when 'completed' then ${t.dispatchedAt} is not null and ${t.startedAt} is not null and ${t.completedAt} is not null and ${t.cancelledAt} is null when 'cancelled' then ${t.cancelledAt} is not null and ${t.completedAt} is null and (${t.startedAt} is null or ${t.dispatchedAt} is not null) else false end`,
    ),
    tenantIndex(t, t.collectionGroupId),
    // The dispatcher's day, and the driver door's two reads.
    tenantIndex(t, t.projectId, t.operatingDate),
    tenantIndex(t, t.plannedDriverId, t.status),
    tenantIndex(t, t.actualDriverId),
    tenantIndex(t, t.plannedVehicleId),
    tenantIndex(t, t.plannedTrailerId),
    tenantIndex(t, t.depotId),
    tenantIndex(t, t.plannedServiceProviderId),
    tenantIndex(t, t.unloadingStationId),
    tenantIndex(t, t.actualVehicleId),
    tenantIndex(t, t.actualTrailerId),
    tenantIndex(t, t.generationRunId),
    tenantIndex(t, t.activePlanId),
  ],
)

export const pickup = wms.table(
  "pickup",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    routeId: uuid().notNull(),
    containerId: uuid().notNull(),
    /** Stop order, 1..n; not unique, since a refresh reorders in place and a dispatcher's reorder rewrites the run. */
    position: integer().notNull(),
    status: text().notNull().default("planned"),
    note: text(),
    /** The place on the service date, from the subscription the placement valid that day named: exactly one of the two. */
    propertyId: uuid(),
    sharedCollectionPointId: uuid(),
    /** The placement's fraction on the service date. */
    wasteFractionId: uuid().notNull(),
    /** The first arrival's instant; a second arrival appends its proof and moves nothing. */
    arrivedAt: instant(),
    /** When the status left planned: the outcome's instant, or the route's end or cancellation. */
    outcomeAt: instant(),
    /** Why a skipped or failed pickup was not collected; none otherwise. */
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
    // Carries the route: a proof or a receipt names a pickup of the route it names, and no other.
    projectKey(t, t.routeId),
    oneOf(t.status, PICKUP_STATUSES),
    oneOf(t.reason, PICKUP_REASONS),
    positive(t.position),
    exactlyOne(t, "place", [t.propertyId, t.sharedCollectionPointId]),
    check(tableObjectName(t.id.table, "outcome_shape", "pickup"), sql`(${t.status} <> 'planned') = (${t.outcomeAt} is not null)`),
    check(tableObjectName(t.id.table, "reason_shape", "pickup"), sql`(${t.status} in ('skipped', 'failed')) = (${t.reason} is not null)`),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.containerId),
    tenantIndex(t, t.propertyId),
    tenantIndex(t, t.sharedCollectionPointId),
    tenantIndex(t, t.wasteFractionId),
    // The stop list in order.
    tenantIndex(t, t.routeId, t.position),
  ],
)

export const session = wms.table(
  "session",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    routeId: uuid().notNull(),
    driverId: uuid().notNull(),
    vehicleId: uuid().notNull(),
    trailerId: uuid(),
    /** The installation's stable id the app mints once; what a rejected command is traced to. */
    deviceId: text().notNull(),
    appVersion: text(),
    /** The start command's instant. */
    startedAt: instant().notNull(),
    /** The end command's instant; null while the session runs. */
    endedAt: instant(),
    /** Set by pause, cleared by resume: Live's "Paused". */
    pausedAt: instant(),
    /** Moved by every batch the device uploads; freshness is a reading of it. */
    lastSeenAt: instant().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.routeId], route),
    projectReference(t, [t.driverId], driver),
    projectReference(t, [t.vehicleId], vehicle),
    projectReference(t, [t.trailerId], vehicle),
    // Carries the route: a proof, an unload or a receipt names a session of the route it names.
    projectKey(t, t.routeId),
    // One live session per route and one per driver: the rows with `ended_at` null, and only those, are in the index.
    uniqueIndex(tableObjectName(t.companyId.table, "route_open_idx", "session")).on(t.companyId, t.routeId).where(sql`${t.endedAt} is null`),
    uniqueIndex(tableObjectName(t.companyId.table, "driver_open_idx", "session")).on(t.companyId, t.driverId).where(sql`${t.endedAt} is null`),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.routeId),
    tenantIndex(t, t.driverId),
    tenantIndex(t, t.vehicleId),
    tenantIndex(t, t.trailerId),
  ],
)

/** The kinds by what they say of the pickup, from the domain's table: a stop's kinds name one, the route's own name none, the rest may stand on the route alone. */
const kindsNaming = (pickup: "required" | "optional" | "none") => sql.raw(PROOF_KINDS.filter((kind) => PROOF_SHAPES[kind].pickup === pickup).map(literal).join(", "))

/** One `WHEN` of the kind CASE: what the kind carries and forbids, as SQL over the row's columns. */
function kindClause(kind: (typeof PROOF_KINDS)[number], columns: { reason: PgColumn; objectKey: PgColumn; weightKg: PgColumn; outcome: PgColumn; note: PgColumn; source: PgColumn }): SQL {
  const shape = PROOF_SHAPES[kind]
  const terms: SQL[] = []
  for (const column of ["reason", "objectKey", "weightKg", "outcome", "note"] as const) {
    const presence = shape[column]
    if (presence === "required") terms.push(sql`${columns[column]} is not null`)
    else if (presence === "none") terms.push(sql`${columns[column]} is null`)
  }
  if (shape.source === "dispatch") terms.push(sql`${columns.source} = 'dispatch'`)
  return sql`when ${sql.raw(literal(kind))} then ${sql.join(terms, sql` and `)}`
}

export const proofOfService = wms.table(
  "proof_of_service",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    routeId: uuid().notNull(),
    /** The stop, for a stop's kind; null for a problem, a photo or a note on the route alone. */
    pickupId: uuid(),
    /** The session, on every driver-recorded row and on no office row. */
    sessionId: uuid(),
    kind: text().notNull(),
    source: text().notNull(),
    /** The device's clock, or the office's word. */
    occurredAt: instant().notNull(),
    /** The driver's login or the dispatcher's. */
    recordedBy: uuid().notNull(),
    deviceId: text(),
    /** Where the device stood. */
    location: geometry.point(),
    locationAccuracyM: integer(),
    reason: text(),
    note: text(),
    /** A lifter's or a hand scale's reading, whole kilograms. */
    weightKg: integer(),
    /** The Storage object of a photo or a signature, under the row's own ids. */
    objectKey: text(),
    /** On a correction: the status the pickup was moved to. */
    outcome: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.routeId], route),
    // A pickup and a session of the route the proof names: the keys carry the route on both sides.
    projectReference(t, [t.routeId, t.pickupId], pickup, [pickup.routeId, pickup.id]),
    projectReference(t, [t.routeId, t.sessionId], session, [session.routeId, session.id]),
    tenantReference(t, [t.recordedBy], userAccount),
    oneOf(t.kind, PROOF_KINDS),
    oneOf(t.source, EXECUTION_SOURCES),
    oneOf(t.reason, PICKUP_REASONS),
    oneOf(t.outcome, PICKUP_OUTCOMES),
    validGeometry(t.location),
    positive(t.locationAccuracyM),
    positive(t.weightKg),
    // A stop's kind names a pickup, the route's two name none, and a problem, a photo and a note may stand on the route alone. From the domain's table.
    check(
      tableObjectName(t.id.table, "pickup_shape", "proofOfService"),
      sql`(${t.kind} in (${kindsNaming("required")}) and ${t.pickupId} is not null) or (${t.kind} in (${kindsNaming("none")}) and ${t.pickupId} is null) or ${t.kind} in (${kindsNaming("optional")})`,
    ),
    // A driver-recorded row names its session and an office row names none.
    check(tableObjectName(t.id.table, "session_shape", "proofOfService"), sql`(${t.source} = 'driver-app') = (${t.sessionId} is not null)`),
    // What each kind carries and forbids: one CASE built from PROOF_SHAPES, the one spelling of the table.
    check(tableObjectName(t.id.table, "kind_shape", "proofOfService"), sql`case ${t.kind} ${sql.join(PROOF_KINDS.map((kind) => kindClause(kind, t)), sql` `)} else false end`),
    // The route's timeline in recording order: leads with the route, so it is the index the reference needs too.
    index(tableObjectName(t.companyId.table, "route_id_idx", "proofOfService")).on(t.companyId, t.routeId, t.id),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.pickupId),
    tenantIndex(t, t.sessionId),
    tenantIndex(t, t.recordedBy),
  ],
)

export const unload = wms.table(
  "unload",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    routeId: uuid().notNull(),
    /** The session, on every driver-recorded row and on no office row. */
    sessionId: uuid(),
    /** Any station of the company; the route's planned one is a default the device offers, not a rule. */
    unloadingStationId: uuid().notNull(),
    /** What was tipped; a multi-compartment vehicle records one row per fraction. */
    wasteFractionId: uuid().notNull(),
    source: text().notNull(),
    occurredAt: instant().notNull(),
    recordedBy: uuid().notNull(),
    deviceId: text(),
    location: geometry.point(),
    /** The weighbridge's two readings, together or not at all, whole kilograms. */
    grossKg: integer(),
    tareKg: integer(),
    /** What was tipped, whole kilograms: given always, and gross less tare where both are. */
    netKg: integer().notNull(),
    /** The station's reference, `WB-2026-3901`; unique nowhere, since two stations may number alike. */
    weighbridgeTicket: text(),
    /** A photo of the ticket, under the row's own ids. */
    objectKey: text(),
    note: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.routeId], route),
    projectReference(t, [t.routeId, t.sessionId], session, [session.routeId, session.id]),
    tenantReference(t, [t.unloadingStationId], unloadingStation),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    tenantReference(t, [t.recordedBy], userAccount),
    // What the weight review points at (Issue #112, migration 0010): the day something pointed at it, the way the placement got its key in 0007.
    projectKey(t),
    oneOf(t.source, EXECUTION_SOURCES),
    validGeometry(t.location),
    positive(t.grossKg),
    positive(t.tareKg),
    positive(t.netKg),
    check(tableObjectName(t.id.table, "session_shape", "unload"), sql`(${t.source} = 'driver-app') = (${t.sessionId} is not null)`),
    // The prototype's own sentence: gross and tare come together, and net is gross less tare.
    check(tableObjectName(t.id.table, "weights_shape", "unload"), sql`(${t.grossKg} is null) = (${t.tareKg} is null) and (${t.grossKg} is null or ${t.netKg} = ${t.grossKg} - ${t.tareKg})`),
    tenantIndex(t, t.routeId),
    tenantIndex(t, t.sessionId),
    tenantIndex(t, t.unloadingStationId),
    tenantIndex(t, t.wasteFractionId),
    tenantIndex(t, t.recordedBy),
    // The weights list: a project's unloads by when they happened.
    tenantIndex(t, t.projectId, t.occurredAt),
  ],
)

export const driverCommand = wms.table(
  "driver_command",
  {
    /** The client's id: the idempotency key, and the id of the row the command made, if it made one. */
    ...id,
    ...projectScoped,
    ...recorded,
    /** The route the command named, where it is one the driver reaches; null on a command rejected because no such route is assigned to the driver, whose claimed id is then in `body` alone. */
    routeId: uuid(),
    /** What the command named or made; null on a rejected `start-route` and on any receipt without a route. */
    sessionId: uuid(),
    pickupId: uuid(),
    driverId: uuid().notNull(),
    deviceId: text().notNull(),
    kind: text().notNull(),
    /** The device's clock, as sent, even when refused. */
    occurredAt: instant().notNull(),
    /** The command as received, verbatim; a rejected command has no other row to live in. Never joined or filtered on. */
    body: jsonb().notNull(),
    outcome: text().notNull(),
    /** The problem the applier answered, exactly when rejected. */
    problem: jsonb(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.routeId], route),
    projectReference(t, [t.routeId, t.sessionId], session, [session.routeId, session.id]),
    projectReference(t, [t.routeId, t.pickupId], pickup, [pickup.routeId, pickup.id]),
    projectReference(t, [t.driverId], driver),
    oneOf(t.kind, DRIVER_COMMAND_KINDS),
    oneOf(t.outcome, COMMAND_OUTCOMES),
    check(tableObjectName(t.id.table, "problem_shape", "driverCommand"), sql`(${t.outcome} = 'rejected') = (${t.problem} is not null)`),
    // A receipt without a route is a rejection that named nothing the driver reaches: no session, no pickup, and never an applied command.
    check(tableObjectName(t.id.table, "route_shape", "driverCommand"), sql`${t.routeId} is not null or (${t.outcome} = 'rejected' and ${t.sessionId} is null and ${t.pickupId} is null)`),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.routeId),
    tenantIndex(t, t.pickupId),
    // The driver's log in order — what the sync rules' driver bucket reads, a receipt without a route included — leading with the driver, so it is the index the reference needs too.
    index(tableObjectName(t.companyId.table, "driver_id_idx", "driverCommand")).on(t.companyId, t.driverId, t.id),
    // A session's log in order, likewise.
    index(tableObjectName(t.companyId.table, "session_id_idx", "driverCommand")).on(t.companyId, t.sessionId, t.id),
  ],
)

export const outboxEvent = wms.table(
  "outbox_event",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    kind: text().notNull(),
    aggregateKind: text().notNull(),
    /** A soft id on purpose: an outbox row outlives nothing and joins nothing. */
    aggregateId: uuid().notNull(),
    /** The command's instant, not the request's. */
    occurredAt: instant().notNull(),
    /** The wire resource as the write left it, so a consumer reads what the API would have answered at that instant. */
    payload: jsonb().notNull(),
    /** Stamped by the relay; null until it is. */
    publishedAt: instant(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    oneOf(t.kind, OUTBOX_KINDS),
    oneOf(t.aggregateKind, OUTBOX_AGGREGATES),
    // The relay's read, across companies: the unpublished rows in id order. A partial index over `id` alone, since `published_at` is null on every row in it and a constant-null leading column would say nothing.
    indexOn(t.id).where(sql`${t.publishedAt} is null`),
    tenantIndex(t, t.projectId),
    // A route's own event log.
    tenantIndex(t, t.aggregateId),
  ],
)
