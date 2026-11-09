// The driver door (Issue #104 §3 and §5, ADR-0004): the routes a driver's
// device reads, and the one door its commands come through. Connectivity can
// disappear at any point in a shift, so every driver action is an
// idempotent, client-identified command applied server-authoritatively later
// — the device mints the id, judges the command against its own rows with the
// same `decide` this module runs (@waste/domain/execution/commands), applies it
// optimistically, and uploads its queue when it can; the server judges it
// again against the rows as they stand, applies what holds, records what does
// not, and the server's rows win on the way back down.
//
// Five routes under `operate.driver-app`, `view` to read and `edit` to
// command. Every statement carries the tenant and the **assignment**
// (auth/driver.ts: `planned_driver_id` or `actual_driver_id` is this driver),
// never `inProjects` — a Service Provider's driver, whose account works in no
// project, reaches its assigned routes here and nothing anywhere else. The
// start screen's pick lists name no route, so they carry the driver
// profile's project, or the company alone, in its place (`pickLists`). The
// driver is resolved on every request from the principal's account
// (`resolveDriver`, 403 for the whole request when no active profile is bound
// to the login), so a driver set inactive stops the next batch.
//
// `POST /driver/commands` is the applier. The batch is one to two hundred
// envelopes, applied in body order, each in its own savepoint, answering 200
// with one outcome per command in order whenever the envelopes parse; a 400
// is for an envelope that does not, and then nothing is applied and nothing
// recorded, since the queue will retry. For each command, in this order:
//
//   the receipt   — read first, by the command's id among this driver's own.
//                   Found: the stored outcome is answered again as
//                   `replayed`, with the row it made read back or the problem
//                   it was refused with, and nothing is written, not even
//                   `last_seen_at`. A replay that differs from the stored
//                   command — its kind, route, instant, device or body — is
//                   still the first answer — a replayed command is a no-op
//                   answering the first result — and the difference is
//                   logged, since it is the client's bug and not the server's
//                   decision to make. Bounded by the driver and not the
//                   company, because a replay hands back the rows the first
//                   upload made, and only the device that sent a command is
//                   owed them;
//   the lock      — the route's row (`lockRow`), so commands on one route take
//                   turns with each other and with the office's cancel, and
//                   two uploads of one batch serialise on it: the second reads
//                   the first's receipt and replays. The route is then read by
//                   id inside the company and not under the assignment, since
//                   `decide` judges the assignment itself and the receipt of a
//                   refused command needs the route's project — and nothing
//                   else of a route that is not this driver's is read
//                   (`readLookups`), so the receipt of that rejection names no
//                   session and no pickup, and a device learns nothing of a
//                   route it was not given;
//   the body      — parsed against its kind's schema (`COMMAND_BODIES`). A
//                   body that fails is a rejection recorded like any other,
//                   with the schema's issues as its problem, so a device never
//                   blocks its queue on a shape mistake;
//   the decision  — `decide` over what was read: the route under the
//                   assignment, the open session on it, the route the driver
//                   has an open session on, the pickup the body names, the
//                   vehicle and the trailer of the route's project, whether
//                   the station and the fraction are the company's, and the
//                   clock (`OCCURRED_AT_SKEW_MS` ahead, `COMMAND_BACKDATE_MS`
//                   behind, routes/shared.ts). Every rule of §3 is the
//                   domain's and every sentence is spelled there;
//   the effects   — as statements, in the order decided: `start-route` opens
//                   the session with the command's id and copies the actual
//                   assignment onto the route, `append-proof` writes the row
//                   with the command's id, `arrive` and `pickup-outcome` move
//                   the pickup, `append-unload` writes the row — and, for a
//                   load the station took of a fraction it does not take,
//                   opens the office an internal task in the station's
//                   sentence, since the load is tipped and a rejection would
//                   lose the reading (O9 of #290, routes/unload-writes.ts) —
//                   `pause`, `resume` and `end-route` move the session and
//                   the route,
//                   `end-route` closing the open pickups as `skipped ·
//                   route-ended` from its own `returning`, and
//                   `record-positions` appends one `session_position` row
//                   per fix (O8 of #290), and `record-fill` sets the stop's fill estimate (M23 of
//                   #293), the latest standing.
//                   Every applied command then moves
//                   `session.last_seen_at` to the request's clock;
//   the receipt   — written after the effects (`driver_command`: the outcome,
//                   the problem on a rejection, the body verbatim but a
//                   `record-positions`'s, whose points it never keeps —
//                   `bodyKept`), and the
//                   outbox events last (@waste/db/commands/outbox), each with the resource the
//                   route would answer at that instant as its payload — a
//                   pickup's event the pickup with the proofs this command
//                   made, a route-level `report-problem`'s
//                   `route-problem-reported` the route with its problem
//                   proof the same way, so the reason and the note
//                   travel with it, the route's other events the bare route
//                   — a rejection's being the receipt itself.
//
// All of it inside the command's savepoint, so a command that fails midway
// leaves nothing of itself behind and the batch goes on. Two races the lock
// does not see are each one command's answer and never the batch's. Two
// uploads of one batch meeting on a primary key — the receipt's, or that of
// the row the command makes with the same id — is the replay door, `replayed`
// in @waste/db/commands/shared: the savepoint rolls the loser's rows back and the first
// receipt is read and answered as `replayed`, a 200 and never a 409, because
// here the key is the command and the command has already happened; the same
// key held by a command that is not this driver's — another device minted the
// id — is a rejection (`ANOTHER_DEVICES_COMMAND`, 409 in the outcome), never a
// replay, and the one rejection no receipt can hold, since the receipt's key
// is that id, so it goes to the log. And two of one driver's routes started at
// once, each batch under its own route's lock, meet on the one-live-session-
// per-driver index once the winner commits (`DRIVER_OPEN_INDEX`): the loser's
// savepoint rolls back, the winner is read, and the command is recorded as the
// rejection `decide` would have made a statement later, "Mads Jensen is
// already on route RC-1039; end it first"; the one-per-route index is the same
// news of a start the lock somehow did not serialise, "Route RC-1042 is
// already active".
//
// Every rejection is recorded, the one for a route the driver does not reach
// included: the receipt's `route_id` and `driver_id` both carry a project by
// their keys, so a command naming a route that is not there, or one of
// another project than the driver's, is written with `route_id` null, the
// driver's own project, no session and no pickup — the shape
// `driver_command_route_shape` allows exactly for a rejection — and the id
// the device claimed folded into `body` beside the body it sent
// (`{ routeId, body }`), since the column that would have held it is null.
// `receiptScope` is the one place that decides which of the two a receipt
// gets. A decision that applies nothing and says why (`note`: a device
// ending a route the office cancelled meanwhile) is recorded as applied and
// the note goes to the log, so the driver is not locked out of a route that
// no longer exists for them.
//
// The wire shapes are `@waste/db/shapes/`', shared with the office's four
// modules and the outbox; the door's own are the scope in
// routes/execution-shapes.ts (`driverRouteScope`,
// `findAssignedRoute`, `noSuchAssignedRoute`), whose fence is the assignment
// where the office's is `inProjects`, and the route read's pickups
// (`driverPickupsOfRoute`): `GET /driver/routes/:id` answers the contracts'
// `DriverRouteDetail`, the route with what hangs off it and each pickup's
// place joined — the address and the point of the property or the shared
// collection point it names, the container's label, the fraction's name —
// the one read that denormalises for the wire what the synced device joins
// from its own buckets (#104 §5).
import {
  COMMAND_BODIES,
  CommandOutcomeRow,
  DriverCommandBatch,
  DriverCommandBatchOutcome,
  DriverCommandReceipt,
  DriverIdentification,
  DriverIdentifyQuery,
  DriverMe,
  DriverRouteDetail,
  type CommandResult,
  type DriverCommandEnvelope,
  type DriverIdentifiedStop,
  type DriverPickup,
} from "@waste/contracts/driver-commands"
import { RouteStatus } from "@waste/contracts/execution"
import type { Action } from "@waste/domain/access/modules"
import { routeLabel } from "@waste/domain/numbering"
import type { FlatPoint } from "@waste/contracts/geojson"
import { Id } from "@waste/contracts/ids"
import type { RouteProblem } from "@waste/contracts/outbox"
import { Page, PageRequest } from "@waste/contracts/pagination"
import type { PickupDetail } from "@waste/contracts/pickups"
import type { Problem } from "@waste/contracts/problem"
import { Route } from "@waste/contracts/routes"
import type { Tx } from "@waste/db/client"
import { recordUnload, stationTakes } from "@waste/db/commands/unloads"
import type { Send } from "@waste/db/jobs"
import { tableObjectName } from "@waste/db/names"
import { wasteFraction } from "@waste/db/schema/catalogue"
import { container } from "@waste/db/schema/containers"
import { property, sharedCollectionPoint } from "@waste/db/schema/customers"
import { driverCommand, pickup, proofOfService, route, session, sessionPosition, unload } from "@waste/db/schema/execution"
import { tankInstallation } from "@waste/db/schema/tanks"
import { dayOnClock, todayOnClock } from "@waste/db/query/project-clock"
import { validOn } from "@waste/db/query/valid-on"
import { driver, vehicle } from "@waste/db/schema/fleet"
import { project } from "@waste/db/schema/organisation"
import { unloadingStation } from "@waste/db/schema/places"
import { alreadyOnRoute, assignedTo, decide, OCCURRED_AT_SKEW_MS, PROOF_COMMAND_KINDS, type Clock, type Command, type CommandDriver, type Effect, type Lookups, type PickupState, type RouteState, type SessionState, type VehicleState } from "@waste/domain/execution/commands"
import { alreadyActive, closingReasonOf } from "@waste/domain/execution/transitions"
import { DISPATCHED_ROUTE_STATUSES, DRIVER_COMMAND_KINDS, type DriverCommandKind } from "@waste/domain/execution/vocabulary"
import { isOneOf } from "@waste/domain/lists"
import { identifiedBy } from "@waste/domain/registry/container-identity"
import { ACTIVE_VEHICLE_STATUSES } from "@waste/domain/resources/vocabulary"
import { and, asc, eq, gt, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { isDeepStrictEqual } from "node:util"
import { emit } from "@waste/db/commands/outbox"
import { lockRow, replayed } from "@waste/db/commands/shared"
import { stopOutcomeChanged } from "@waste/db/commands/stop-outcomes"
import { labelOf, routeColumns, routesOf, routeWithProgress, type RouteRow } from "@waste/db/shapes/routes"
import { pickupColumns, pickupOf, type PickupRow } from "@waste/db/shapes/pickups"
import { proofColumns, proofOf } from "@waste/db/shapes/proofs"
import { receiptColumns, receiptOf, type ReceiptRow } from "@waste/db/shapes/driver-commands"
import { uniqueConstraintOf } from "@waste/db/sqlstate"
import { unloadAnswered, unloadsFrom } from "@waste/db/shapes/unloads"
import { vehicleLabel } from "@waste/db/commands/fleet-fit"
import { bulkyItemsOf } from "@waste/db/shapes/bulky-bookings"

import { resolveDriver, type DriverProfile } from "../auth/driver"
import { actorOf, type Principal } from "../auth/principal"
import type { RouteDeps } from "../deps"
import { routes } from "../operation"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problemBody } from "../problem"
import { namedByCode } from "./container-identity"
import { driverColumns, driverOf } from "./drivers"
import { driverRouteScope, findAssignedRoute, noSuchAssignedRoute, routeWithSessions, sessionColumns, sessionOf, type SessionRow } from "./execution-shapes"
import { planContextOf, sequencedPickups } from "./plan-shapes"
import { vehicleColumns } from "./fleet-lookups"
import { idsColumn } from "./id-sets"
import { COMMAND_BACKDATE_MS, describeJson, IdParam, primaryKeyOf } from "./shared"
import { fractions as stationFractions } from "./unloading-stations"
import { tellOfficeNotTaken } from "./unload-writes"

const MODULE = "operate.driver-app"
const RoutePage = Page(Route)
const ReceiptPage = Page(DriverCommandReceipt)

/** `GET /driver/routes`: the page, narrowed to one status of the day's routes. */
const DriverRouteListQuery = PageRequest.extend({ status: RouteStatus.optional() })

/** `GET /driver/commands`: the page, narrowed to one route's receipts. */
const DriverReceiptListQuery = PageRequest.extend({ routeId: Id.optional() })

/** The primary keys a race between two uploads of one batch can meet: the receipt's, and that of the row a command makes with the same id. */
const REPLAY_KEYS = [primaryKeyOf(driverCommand), primaryKeyOf(session), primaryKeyOf(proofOfService), primaryKeyOf(unload)]

/** What a command is told when its id is already another device's command's — one of the keys above taken, and no receipt of this driver's under it: never replayed, since a replay would hand that command's rows to a device that did not send it, and recorded nowhere, since the receipt's key is that id. */
export const ANOTHER_DEVICES_COMMAND = "That command id belongs to another device's command"

/**
 * The two partial unique indexes a `start-route` can meet that the route's
 * lock does not serialise (packages/db/src/schema/execution.ts, `session`):
 * one live session per driver — two of the driver's routes started at once,
 * each batch under its own route's lock, the second's insert waiting on the
 * first's commit and then refused — and one per route, the backstop, since
 * the route's own lock serialises its starts. Each becomes the command's
 * rejection in the domain's words, the rule `decide` judged a statement too
 * early, and never the batch's 409.
 */
const DRIVER_OPEN_INDEX = tableObjectName(session, "driver_open_idx", "driverDoorRoutes")
const ROUTE_OPEN_INDEX = tableObjectName(session, "route_open_idx", "driverDoorRoutes")

/**
 * The log's word for a `start-route` one of those indexes refused where
 * `decide` had passed it. The rejection reads the same whichever door refused
 * — the rule a statement earlier or the index at the write — so without this
 * line nobody, operations or a test, could tell that the write was what held
 * it. A fact for operations: which index, which command, whose; never the body.
 */
export const HELD_AT_WRITE = "driver-command-held-at-write"

/** Notes a start the write held, once per command, before its rejection is recorded. */
const heldAtWrite = (applier: Applier, envelope: DriverCommandEnvelope, constraint: string): void =>
  applier.log({ event: HELD_AT_WRITE, constraint, commandId: envelope.id, kind: envelope.kind, routeId: envelope.routeId, driverId: applier.profile.id })

/**
 * The routes a driver's day is made of: `ready` or `active`, or `completed`
 * today on the project's clock at the request's instant.
 */
const todays = (now: Date): SQL =>
  or(
    inArray(route.status, [...DISPATCHED_ROUTE_STATUSES]),
    and(eq(route.status, "completed"), sql`${dayOnClock(route.completedAt, project.timezone)} = ${todayOnClock(now, project.timezone)}`),
  ) as SQL

/** One driver's day, as `GET /driver/me` answers it whole and `GET /driver/routes` pages it. */
async function dayRoutes(tx: Tx, principal: Principal, profile: DriverProfile, now: Date, narrow: { status?: RouteStatus; after?: string; limit?: number }): Promise<RouteRow[]> {
  const statement = tx
    .select(routeColumns)
    .from(route)
    .innerJoin(project, and(eq(project.companyId, route.companyId), eq(project.id, route.projectId)))
    .where(
      and(
        driverRouteScope(principal, profile),
        todays(now),
        narrow.status === undefined ? undefined : eq(route.status, narrow.status),
        narrow.after === undefined ? undefined : gt(route.id, narrow.after),
      ),
    )
    .orderBy(asc(route.id))
  return narrow.limit === undefined ? await statement : await statement.limit(narrow.limit)
}

/** The three lists of `DriverMe` a start and an unload pick from. */
type PickLists = Pick<DriverMe, "vehicles" | "unloadingStations" | "wasteFractions">

/**
 * What the start screen and the unload screen pick from (#144): the rows #104
 * §3's sync rules put in the `company` bucket, which a browser has no bucket
 * for, narrowed to what the commands that name them accept. Three
 * statements, one per list — a station's fractions a column of its own row
 * (`idsColumn`) — each carrying the tenant and bounded the way the command
 * that names its rows is judged: the vehicles by the driver profile's
 * project — `start-route` takes a vehicle and a trailer of the route's
 * project, and the assignment's key puts every route of this driver in the
 * profile's (#125, Q5) — and `active`, the one status a start accepts; the
 * stations and the fractions by the company alone, since `record-unload`
 * takes any of the company's, and the stations `closed` left out. Never
 * Project Access, like the rest of the door: a Service Provider's driver,
 * whose account works in no project, picks from the same lists as the
 * employee beside them, the company's stations included, which the office's
 * station reads do not show their account (routes/unloading-stations.ts).
 * Each list is by id, and so is each station's set of fractions, the order
 * every set of this API is read in (routes/id-sets.ts).
 */
async function pickLists(tx: Tx, companyId: string, profile: DriverProfile): Promise<PickLists> {
  const [vehicles, stations, wasteFractions] = await Promise.all([
    tx
      .select(vehicleColumns)
      .from(vehicle)
      .where(and(eq(vehicle.companyId, companyId), eq(vehicle.projectId, profile.projectId), inArray(vehicle.status, [...ACTIVE_VEHICLE_STATUSES])))
      .orderBy(asc(vehicle.id)),
    tx
      .select({ id: unloadingStation.id, name: unloadingStation.name, location: unloadingStation.location, weighbridge: unloadingStation.weighbridge, wasteFractionIds: idsColumn(tx, stationFractions, companyId, unloadingStation.id) })
      .from(unloadingStation)
      .where(and(eq(unloadingStation.companyId, companyId), ne(unloadingStation.status, "closed")))
      .orderBy(asc(unloadingStation.id)),
    tx.select({ id: wasteFraction.id, key: wasteFraction.key, name: wasteFraction.name }).from(wasteFraction).where(eq(wasteFraction.companyId, companyId)).orderBy(asc(wasteFraction.id)),
  ])
  return {
    vehicles: vehicles.map((row) => ({ id: row.id, label: vehicleLabel(row), kind: row.kind, requiredLicenceClass: row.requiredLicenceClass })),
    // A station's column is `geometry(Point, 4326)`, flat: what it holds is the contracts' `FlatPoint`, however the column's type spells the altitude as optional.
    unloadingStations: stations.map((row) => ({ ...row, location: row.location as FlatPoint })),
    wasteFractions,
  }
}

/** The open session of this driver, whichever route it is on; undefined when none. */
async function openSessionOf(tx: Tx, companyId: string, profile: DriverProfile): Promise<SessionRow | undefined> {
  const [row] = await tx
    .select(sessionColumns)
    .from(session)
    .where(and(eq(session.companyId, companyId), eq(session.driverId, profile.id), isNull(session.endedAt)))
    .limit(1)
  return row
}

/**
 * One route's pickups with their places joined, by position: the
 * `DriverPickup`s of `GET /driver/routes/:id` (#104 §5). One statement over
 * the pickup's own place columns — `property_id` or
 * `shared_collection_point_id`, the place on the service date (§7.11), never
 * the placement valid today, which may have moved since — and its container
 * and fraction, the address and the point read through the property's or
 * the point's column, the point's codec decoding it (@waste/db/schema/geometry)
 * exactly as the Registry's own reads do, and the place's instructions to the
 * driver, never the property's notes. `pickup_place_exactly_one` and the
 * two project keys hold every pickup to one place that is there, so a row
 * with neither address is a broken invariant and thrown, not a client's. The
 * container is a left join: an address-only stop the office added (#111)
 * names none, and is on the list with its address and a null label; a bulky
 * collection (O11 of #290) carries its booking's items, what the driver
 * takes away; and a stop at a tank (M11 of #293) the tank its container
 * stands for on the route's service date, what the driver pumps.
 */
async function driverPickupsOfRoute(tx: Tx, companyId: string, routeId: string): Promise<DriverPickup[]> {
  // A swap's replacement, by its label (O3b of #290): what the driver brings.
  const replacement = alias(container, "replacement")
  const rows = await tx
    .select({
      ...pickupColumns,
      propertyAddress: property.address,
      propertyLocation: property.location,
      propertyInstructions: property.driverInstructions,
      pointAddress: sharedCollectionPoint.address,
      pointLocation: sharedCollectionPoint.location,
      pointInstructions: sharedCollectionPoint.driverInstructions,
      containerLabel: container.label,
      replacementContainerLabel: replacement.label,
      wasteFractionName: wasteFraction.name,
    })
    .from(pickup)
    .leftJoin(container, and(eq(container.companyId, pickup.companyId), eq(container.id, pickup.containerId)))
    .leftJoin(replacement, and(eq(replacement.companyId, pickup.companyId), eq(replacement.id, pickup.replacementContainerId)))
    .innerJoin(wasteFraction, and(eq(wasteFraction.companyId, pickup.companyId), eq(wasteFraction.id, pickup.wasteFractionId)))
    .leftJoin(property, and(eq(property.companyId, pickup.companyId), eq(property.id, pickup.propertyId)))
    .leftJoin(sharedCollectionPoint, and(eq(sharedCollectionPoint.companyId, pickup.companyId), eq(sharedCollectionPoint.id, pickup.sharedCollectionPointId)))
    .where(and(eq(pickup.companyId, companyId), eq(pickup.routeId, routeId)))
    .orderBy(asc(pickup.position), asc(pickup.id))
  const items = await bulkyItemsOf(
    tx,
    companyId,
    rows.flatMap((row) => (row.bulkyBookingId === null ? [] : [row.bulkyBookingId])),
  )
  const confirmed = await confirmationsOfRoute(tx, companyId, routeId)
  const tanks = await tanksOfRoute(tx, companyId, routeId)
  return rows.map(({ propertyAddress, propertyLocation, propertyInstructions, pointAddress, pointLocation, pointInstructions, containerLabel, replacementContainerLabel, wasteFractionName, ...stop }) => {
    const address = propertyAddress ?? pointAddress
    if (address === null) throw new Error(`pickup ${stop.id} names no place that is there`)
    // The columns are `geometry(Point, 4326)`, flat: what they hold is the contracts' `FlatPoint`, however the column's type spells the altitude as optional.
    const location = (propertyLocation ?? pointLocation) as FlatPoint | null
    // The place's own words for the driver; a property's `notes` are the office's and never reach a phone.
    const driverInstructions = propertyInstructions ?? pointInstructions
    const bulkyItems = stop.bulkyBookingId === null ? [] : (items.get(stop.bulkyBookingId) ?? [])
    const containerConfirmedAt = confirmed.get(stop.id)?.toISOString() ?? null
    const tank = stop.containerId === null ? null : (tanks.get(stop.containerId) ?? null)
    return { ...pickupOf(stop), address, driverInstructions, location, containerLabel, wasteFractionName, replacementContainerLabel, bulkyItems, containerConfirmedAt, tank }
  })
}

/** The tanks a route's containers stand for on its service date (M11 of #293), by container. */
async function tanksOfRoute(tx: Tx, companyId: string, routeId: string): Promise<Map<string, NonNullable<DriverPickup["tank"]>>> {
  const rows = await tx
    .select({ containerId: tankInstallation.containerId, kind: tankInstallation.kind, volumeLitres: tankInstallation.volumeLitres, outlet: tankInstallation.outlet })
    .from(pickup)
    .innerJoin(route, and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)))
    .innerJoin(tankInstallation, and(eq(tankInstallation.companyId, pickup.companyId), eq(tankInstallation.containerId, pickup.containerId), validOn(tankInstallation, route.serviceDate)))
    .where(and(eq(pickup.companyId, companyId), eq(pickup.routeId, routeId)))
  return new Map(rows.map((row) => [row.containerId, { kind: row.kind, volumeLitres: row.volumeLitres, outlet: row.outlet }]))
}

/**
 * When each stop of the route last had its container confirmed (O19 of
 * #290): the device's instant of the latest applied `arrive` whose body
 * carried an identification. The receipt is the record — the door applied it
 * only once the code named the stop's own container — so nothing beyond the
 * arrival is written for it.
 */
async function confirmationsOfRoute(tx: Tx, companyId: string, routeId: string): Promise<Map<string, Date>> {
  const rows = await tx
    .select({ pickupId: driverCommand.pickupId, at: sql<Date>`max(${driverCommand.occurredAt})`.mapWith(driverCommand.occurredAt) })
    .from(driverCommand)
    .where(
      and(
        eq(driverCommand.companyId, companyId),
        eq(driverCommand.routeId, routeId),
        eq(driverCommand.kind, "arrive"),
        eq(driverCommand.outcome, "applied"),
        sql`${driverCommand.body} ? 'identification'`,
      ),
    )
    .groupBy(driverCommand.pickupId)
  return new Map(rows.flatMap((row) => (row.pickupId === null ? [] : [[row.pickupId, row.at] as const])))
}

/**
 * The stops of the route whose container a code names (O19 of #290) — the
 * container standing there, or a swap's replacement — by position, and by
 * which identifier. Only the route's own containers are read, so a code that
 * names a container elsewhere answers no stop, and a device learns nothing
 * of the company's other bins.
 */
async function identifiedStopsOfRoute(tx: Tx, companyId: string, routeId: string, code: string): Promise<DriverIdentifiedStop[]> {
  const read = async (replacement: boolean): Promise<DriverIdentifiedStop[]> => {
    const named = alias(container, "named")
    const rows = await tx
      .select({ pickupId: pickup.id, position: pickup.position, containerId: named.id, label: named.label, barcode: named.barcode, rfid: named.rfid, serialNumber: named.serialNumber })
      .from(pickup)
      .innerJoin(named, and(eq(named.companyId, pickup.companyId), eq(named.id, replacement ? pickup.replacementContainerId : pickup.containerId)))
      .where(and(eq(pickup.companyId, companyId), eq(pickup.routeId, routeId), namedByCode(named, code)))
    return rows.flatMap(({ pickupId, position, containerId, ...identifiers }) => {
      const matchedBy = identifiedBy(identifiers, code)
      // The SQL and the domain compare alike; a row the domain does not name is left out rather than answered under a guess.
      return matchedBy === undefined ? [] : [{ pickupId, position, containerId, containerLabel: identifiers.label, matchedBy, replacement }]
    })
  }
  const stops = [...(await read(false)), ...(await read(true))]
  return stops.sort((a, b) => a.position - b.position || a.pickupId.localeCompare(b.pickupId) || Number(a.replacement) - Number(b.replacement))
}

// The applier.

/** What every command in a batch is judged and recorded with. */
type Applier = {
  principal: Principal
  profile: DriverProfile
  /** The request's clock and the two bounds. */
  clock: Clock
  /** The request's instant as a Date, what `last_seen_at` moves to. */
  now: Date
  /** Where a replay with a differing body, a rejection no receipt can hold, or a start the index held at the write is noted. */
  log: (entry: unknown) => void
  /** What a ticket's automation queues a message with, for a ticket a command opens or services. */
  send: Send
}

/** What was read for one command beyond the domain's lookups: the rows themselves, for the receipt and the effects. */
type Read = {
  lookups: Lookups
  route: RouteRow | undefined
  /** The open session on the route, whoever's. */
  session: SessionRow | undefined
  /** The pickup the body names, on this route. */
  pickup: PickupRow | undefined
}

/** Whether the pickup id the body names is read from the parsed body; every kind that names one spells it `pickupId`. */
const namedPickup = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null) return undefined
  const { pickupId } = body as { pickupId?: unknown }
  return typeof pickupId === "string" ? pickupId : undefined
}

/**
 * The receipt by the command's id, among this driver's; undefined when the
 * command is new to them. Bounded by the driver and not the company alone,
 * because a replay answers the rows the first upload made — a session, a
 * proof with where the device stood — and only the device that sent a
 * command is owed them: an id another driver's command holds is met at the
 * key on the write and refused there (`ANOTHER_DEVICES_COMMAND`).
 */
async function findReceipt(tx: Tx, companyId: string, profile: DriverProfile, id: string): Promise<ReceiptRow | undefined> {
  const [row] = await tx
    .select(receiptColumns)
    .from(driverCommand)
    .where(and(eq(driverCommand.companyId, companyId), eq(driverCommand.driverId, profile.id), eq(driverCommand.id, id)))
    .limit(1)
  return row
}

/** The route by id in this company, whoever it is assigned to: `decide` judges the assignment, and the receipt needs the project either way. */
async function findRouteInCompany(tx: Tx, companyId: string, id: string): Promise<RouteRow | undefined> {
  const [row] = await tx
    .select(routeColumns)
    .from(route)
    .where(and(eq(route.companyId, companyId), eq(route.id, id)))
    .limit(1)
  return row
}

/** A vehicle or a trailer the body names, of the route's project, as the start rule reads it; undefined when it is not there. */
async function findVehicleState(tx: Tx, companyId: string, projectId: string, id: string): Promise<VehicleState | undefined> {
  const [row] = await tx
    .select(vehicleColumns)
    .from(vehicle)
    .where(and(eq(vehicle.companyId, companyId), eq(vehicle.projectId, projectId), eq(vehicle.id, id)))
    .limit(1)
  if (row === undefined) return undefined
  return { id: row.id, label: vehicleLabel(row), kind: row.kind, status: row.status, requiredLicenceClass: row.requiredLicenceClass }
}

/** Whether a row of this company exists in a company-wide table: the station and the fraction a `record-unload` names. */
async function knownToCompany(tx: Tx, table: typeof unloadingStation | typeof wasteFraction, companyId: string, id: string): Promise<boolean> {
  const [row] = await tx.select({ id: table.id }).from(table).where(and(eq(table.companyId, companyId), eq(table.id, id))).limit(1)
  return row !== undefined
}

/** The label of the route this driver has a session open on, any route; undefined when none. What the start rule reads, and what the loser of a race on `DRIVER_OPEN_INDEX` reads again to name the winner. */
async function driverOpenOn(tx: Tx, companyId: string, profile: DriverProfile): Promise<string | undefined> {
  const [driving] = await tx
    .select({ number: route.number })
    .from(session)
    .innerJoin(route, and(eq(route.companyId, session.companyId), eq(route.id, session.routeId)))
    .where(and(eq(session.companyId, companyId), eq(session.driverId, profile.id), isNull(session.endedAt)))
    .limit(1)
  return driving === undefined ? undefined : routeLabel(driving.number)
}

const routeState = (row: RouteRow): RouteState => ({ id: row.id, label: labelOf(row), status: row.status, plannedDriverId: row.plannedDriverId, actualDriverId: row.actualDriverId, operatingDate: row.operatingDate })
const sessionState = (row: SessionRow): SessionState => ({ id: row.id, driverId: row.driverId, startedAt: row.startedAt.toISOString(), endedAt: row.endedAt === null ? null : row.endedAt.toISOString(), pausedAt: row.pausedAt === null ? null : row.pausedAt.toISOString() })
const pickupState = (row: PickupRow): PickupState => ({ id: row.id, position: row.position, status: row.status, arrivedAt: row.arrivedAt === null ? null : row.arrivedAt.toISOString(), containerId: row.containerId })

/**
 * Everything `decide` asks for, each lookup bounded the way the door bounds
 * it, and only what the kind needs: the open session on the route for every
 * kind, the route the driver has a session open on for `start-route`, the
 * pickup the body names, the vehicle and the trailer of the route's project,
 * the station and the fraction of the company. Nothing is read for a route
 * that is not there, or that is not this driver's (the domain's
 * `assignedTo`, the rule `decide` refuses by first): the receipt of that
 * rejection then names no session and no pickup, and a device learns nothing
 * of a route it was not given — not the other driver's open session, not the
 * stop it guessed at.
 */
async function readLookups(tx: Tx, applier: Applier, envelope: DriverCommandEnvelope, routeRow: RouteRow | undefined, body: unknown): Promise<Read> {
  const { companyId } = applier.principal
  const lookups: Lookups = { companyId, route: undefined, session: undefined, driverOpenOn: undefined, pickup: undefined, vehicle: undefined, trailer: undefined, stationKnown: false, fractionKnown: false }
  if (routeRow === undefined) return { lookups, route: undefined, session: undefined, pickup: undefined }
  lookups.route = routeState(routeRow)
  if (!assignedTo(routeRow, applier.profile.id)) return { lookups, route: routeRow, session: undefined, pickup: undefined }

  const [open] = await tx
    .select(sessionColumns)
    .from(session)
    .where(and(eq(session.companyId, companyId), eq(session.routeId, routeRow.id), isNull(session.endedAt)))
    .limit(1)
  if (open !== undefined) lookups.session = sessionState(open)

  let named: PickupRow | undefined
  const pickupId = namedPickup(body)
  if (pickupId !== undefined) {
    ;[named] = await tx
      .select(pickupColumns)
      .from(pickup)
      .where(and(eq(pickup.companyId, companyId), eq(pickup.routeId, routeRow.id), eq(pickup.id, pickupId)))
      .limit(1)
    if (named !== undefined) lookups.pickup = pickupState(named)
  }

  // A body that failed its schema is not here (`undefined`), and a body that passed is an object; the fields are read the same way either way.
  const fields: Record<string, unknown> = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
  if (envelope.kind === "start-route") {
    lookups.driverOpenOn = await driverOpenOn(tx, companyId, applier.profile)
    const { vehicleId, trailerId } = fields
    if (typeof vehicleId === "string") lookups.vehicle = await findVehicleState(tx, companyId, routeRow.projectId, vehicleId)
    if (typeof trailerId === "string") lookups.trailer = await findVehicleState(tx, companyId, routeRow.projectId, trailerId)
  }

  // An arrival that confirms its container (O19 of #290): the stop's container and the company's containers the code names, the rule `decide` judges between.
  if (envelope.kind === "arrive" && named !== undefined) {
    const { identification } = fields
    const code = typeof identification === "object" && identification !== null ? (identification as { code?: unknown }).code : undefined
    if (typeof code === "string") {
      const identified = await tx
        .select({ id: container.id })
        .from(container)
        .where(and(eq(container.companyId, companyId), namedByCode(container, code)))
      lookups.identification = { containerId: named.containerId, identifiedContainerIds: identified.map((row) => row.id) }
    }
  }

  if (envelope.kind === "record-unload") {
    const { unloadingStationId, wasteFractionId } = fields
    lookups.stationKnown = typeof unloadingStationId === "string" && (await knownToCompany(tx, unloadingStation, companyId, unloadingStationId))
    lookups.fractionKnown = typeof wasteFractionId === "string" && (await knownToCompany(tx, wasteFraction, companyId, wasteFractionId))
  }

  return { lookups, route: routeRow, session: open, pickup: named }
}

/** The problem a rejection is recorded with and answered in: the contracts' shape, built the way every problem of this API is. */
const rejectionProblem = (status: 400 | 404 | 409, detail: string, errors?: { path: string; message: string }[]): Problem => problemBody(status, errors === undefined ? { detail } : { detail, errors })

/**
 * The row a command made, read back and tagged with what it is: a session
 * for `start-route`, a proof for the evidence and outcome commands, an unload
 * for `record-unload`, the route for `end-route`, the stop for
 * `record-fill` (M23 of #293), nothing for `pause` and
 * `resume`, which make no row. What a write says is what the next read says,
 * so the apply path and the replay path both answer through this. A receipt
 * that names no route (a rejection for one the driver does not reach) has
 * nothing to read back.
 */
async function resultOf(tx: Tx, companyId: string, kind: DriverCommandKind, id: string, routeId: string | null): Promise<CommandResult | undefined> {
  if (kind === "start-route") {
    const [row] = await tx.select(sessionColumns).from(session).where(and(eq(session.companyId, companyId), eq(session.id, id))).limit(1)
    return row === undefined ? undefined : { resource: "session", value: sessionOf(row) }
  }
  if (isOneOf(kind, PROOF_COMMAND_KINDS)) {
    const [row] = await tx.select(proofColumns).from(proofOfService).where(and(eq(proofOfService.companyId, companyId), eq(proofOfService.id, id))).limit(1)
    return row === undefined ? undefined : { resource: "proof", value: proofOf(row) }
  }
  if (kind === "record-unload") {
    // Through the same statement every unload is read by, so a replay of a since-reviewed unload carries its reading (Issue #112).
    const [row] = await unloadsFrom(tx, companyId)
      .query.where(and(eq(unload.companyId, companyId), eq(unload.id, id)))
      .limit(1)
    return row === undefined ? undefined : { resource: "unload", value: await unloadAnswered(tx, companyId, row) }
  }
  if (kind === "record-fill") {
    // The stop as it stands, read through the receipt that names it: a later estimate's replay answers the stop as the later one left it, as every read does.
    const [receipt] = await tx.select({ pickupId: driverCommand.pickupId }).from(driverCommand).where(and(eq(driverCommand.companyId, companyId), eq(driverCommand.id, id))).limit(1)
    if (receipt?.pickupId == null) return undefined
    const [row] = await tx.select(pickupColumns).from(pickup).where(and(eq(pickup.companyId, companyId), eq(pickup.id, receipt.pickupId))).limit(1)
    return row === undefined ? undefined : { resource: "pickup", value: pickupOf(row) }
  }
  if (kind === "end-route" && routeId !== null) {
    const found = await readRoute(tx, companyId, routeId)
    return found === undefined ? undefined : { resource: "route", value: found }
  }
  return undefined
}

/** The route on the wire as it stands, with its progress read the way a page reads it; undefined when it is somehow gone. */
async function readRoute(tx: Tx, companyId: string, id: string): Promise<Route | undefined> {
  const row = await findRouteInCompany(tx, companyId, id)
  return row === undefined ? undefined : await routeWithProgress(tx, companyId, row)
}

/** The route on the wire as it stands, which an event of the command names: the payload of its route events. */
async function routeNamed(tx: Tx, companyId: string, routeId: string): Promise<Route> {
  const found = await readRoute(tx, companyId, routeId)
  if (found === undefined) throw new Error(`route ${routeId} is not in company ${companyId}`)
  return found
}

/** A pickup on the wire as it stands, with the proofs this command made for it: the payload of a pickup event. */
async function readPickupWithProofs(tx: Tx, companyId: string, pickupId: string, commandId: string): Promise<PickupDetail> {
  const [row] = await tx.select(pickupColumns).from(pickup).where(and(eq(pickup.companyId, companyId), eq(pickup.id, pickupId))).limit(1)
  if (row === undefined) throw new Error(`pickup ${pickupId}, which command ${commandId} names, is not in company ${companyId}`)
  const proofs = await tx
    .select(proofColumns)
    .from(proofOfService)
    .where(and(eq(proofOfService.companyId, companyId), eq(proofOfService.pickupId, pickupId), eq(proofOfService.id, commandId)))
  return { ...pickupOf(row), proofs: proofs.map(proofOf) }
}

/**
 * The route on the wire as it stands, with the proofs this command made on
 * the route alone: the payload of a `route-problem-reported`, so
 * the problem's `reason` and `note` travel with the event the way a stop's
 * problem travels with its pickup, and a consumer reads `proofs[0]` either
 * way. The route's other events carry the bare `Route`.
 */
async function readRouteWithProofs(tx: Tx, companyId: string, routeId: string, commandId: string): Promise<RouteProblem> {
  const found = await routeNamed(tx, companyId, routeId)
  const proofs = await tx
    .select(proofColumns)
    .from(proofOfService)
    .where(and(eq(proofOfService.companyId, companyId), eq(proofOfService.routeId, routeId), isNull(proofOfService.pickupId), eq(proofOfService.id, commandId)))
  return { ...found, proofs: proofs.map(proofOf) }
}

/** Whether a replay says something other than the first upload did: the kind, the device, the instant, the route, or the body — the route read from the body where the receipt kept the claimed id there. */
const differsFromReceipt = (receipt: ReceiptRow, envelope: DriverCommandEnvelope): boolean =>
  receipt.kind !== envelope.kind ||
  receipt.deviceId !== envelope.deviceId ||
  receipt.occurredAt.getTime() !== Date.parse(envelope.occurredAt) ||
  (receipt.routeId !== null && receipt.routeId !== envelope.routeId) ||
  !isDeepStrictEqual(receipt.body, bodyKept(envelope, receipt.routeId))

/** The receipt's first answer, given again: the stored outcome with the row it made read back or the problem it was refused with, and nothing written. */
async function replayOf(tx: Tx, applier: Applier, receipt: ReceiptRow, envelope: DriverCommandEnvelope): Promise<CommandOutcomeRow> {
  if (differsFromReceipt(receipt, envelope)) {
    applier.log({ commandId: envelope.id, kind: envelope.kind, detail: "replayed with a command that differs from the first upload; the first answer stands" })
  }
  if (receipt.outcome === "rejected") return { commandId: receipt.id, outcome: "replayed", problem: receipt.problem as Problem }
  const result = await resultOf(tx, applier.principal.companyId, receipt.kind, receipt.id, receipt.routeId)
  return result === undefined ? { commandId: receipt.id, outcome: "replayed" } : { commandId: receipt.id, outcome: "replayed", result }
}

/** Where a receipt is written: the route's own project and id where the driver reaches the route, else the driver's project and no route. */
type ReceiptScope = { projectId: string; routeId: string | null }

/**
 * A route the driver reaches — there, and of the driver's own project, which
 * is what the receipt's `route_id` and `driver_id` keys both demand — is the
 * receipt's route; any other, or none, is recorded without one, in the
 * driver's project, and the id the device claimed is kept in `body`
 * (`bodyKept`). The one place that decides.
 */
function receiptScope(applier: Applier, routeRow: RouteRow | undefined): ReceiptScope {
  if (routeRow === undefined || routeRow.projectId !== applier.profile.projectId) return { projectId: applier.profile.projectId, routeId: null }
  return { projectId: routeRow.projectId, routeId: routeRow.id }
}

/**
 * The body as the receipt keeps it: verbatim, a JSON `null` for a body the
 * envelope did not carry, and — on a receipt with no route — the claimed
 * route id beside it, `{ routeId, body }`, since the column that would have
 * held it is null and a rejection is kept for a reader who wants that id.
 */
const bodyKept = (envelope: DriverCommandEnvelope, routeId: string | null): unknown => {
  const body = envelope.body === undefined ? null : withoutPoints(envelope.kind, envelope.body)
  return routeId === null ? { routeId: envelope.routeId, body } : body
}

/**
 * A `record-positions`'s body as the receipt keeps it (O8 of #290): the count
 * of its fixes and none of their points. A position is personal location data
 * kept `POSITION_RETENTION_DAYS` (#381) and a receipt is kept for good — and
 * synced back down to the device, and the payload of a rejection's event — so
 * the receipt keeps no copy for the purge to miss. A body its schema refused
 * keeps nothing of its points either: a count where they were a list, null
 * where they were not.
 */
const withoutPoints = (kind: DriverCommandKind, body: unknown): unknown => {
  if (kind !== "record-positions") return body
  const points = typeof body === "object" && body !== null ? (body as { points?: unknown }).points : undefined
  return { points: Array.isArray(points) ? points.length : null }
}

/** `bodyKept` as the insert takes it: a JSON `null` spelled for the `jsonb not null` column, which would read a bare null as SQL's. */
const bodyValue = (kept: unknown): unknown => (kept === null ? sql`'null'::jsonb` : kept)

type ReceiptDraft = {
  envelope: DriverCommandEnvelope
  scope: ReceiptScope
  sessionId: string | null
  pickupId: string | null
} & ({ outcome: "applied" } | { outcome: "rejected"; problem: Problem })

/** Writes the receipt and answers it as the wire spells it; a receipt with no route names no session and no pickup, as its shape check demands. */
async function writeReceipt(tx: Tx, applier: Applier, draft: ReceiptDraft): Promise<DriverCommandReceipt> {
  const { envelope, scope } = draft
  const [row] = await tx
    .insert(driverCommand)
    .values({
      id: envelope.id,
      companyId: applier.principal.companyId,
      projectId: scope.projectId,
      routeId: scope.routeId,
      sessionId: scope.routeId === null ? null : draft.sessionId,
      pickupId: scope.routeId === null ? null : draft.pickupId,
      driverId: applier.profile.id,
      deviceId: envelope.deviceId,
      kind: envelope.kind,
      occurredAt: new Date(envelope.occurredAt),
      body: bodyValue(bodyKept(envelope, scope.routeId)),
      outcome: draft.outcome,
      problem: draft.outcome === "rejected" ? draft.problem : null,
    })
    .returning(receiptColumns)
  return receiptOf(row)
}

/**
 * Records a rejection: the receipt with its problem, then `command-rejected`
 * with the receipt as payload, inside the command's savepoint. Every
 * rejection is recorded; one for a route of another project, or none, is
 * recorded without a route (`receiptScope`).
 */
async function recordRejection(tx: Tx, applier: Applier, envelope: DriverCommandEnvelope, read: Read, problem: Problem): Promise<CommandOutcomeRow> {
  const outcome: CommandOutcomeRow = { commandId: envelope.id, outcome: "rejected", problem }
  const scope = receiptScope(applier, read.route)
  await tx.transaction(async (savepoint) => {
    const receipt = await writeReceipt(savepoint, applier, { envelope, scope, sessionId: read.session?.id ?? null, pickupId: read.pickup?.id ?? null, outcome: "rejected", problem })
    await emit(savepoint, applier.principal, { kind: "command-rejected", aggregateId: envelope.id, payload: receipt, projectId: scope.projectId, occurredAt: new Date(envelope.occurredAt) })
  })
  return outcome
}

/** What the effects left behind, for the receipt and the events. */
type Made = {
  /** The session the command ran in, or opened. */
  sessionId: string | null
  /** The pickups `end-route` closed, for one `pickup-skipped` each. */
  closed: string[]
  /** The events the decision asked for, emitted after the receipt. */
  events: Extract<Effect, { kind: "event" }>[]
}

/** Runs the decided effects as statements, in order. */
async function runEffects(tx: Tx, applier: Applier, envelope: DriverCommandEnvelope, read: Read, routeRow: RouteRow, effects: readonly Effect[]): Promise<Made> {
  const { companyId } = applier.principal
  const { projectId } = routeRow
  const made: Made = { sessionId: read.session?.id ?? null, closed: [], events: [] }
  const onRoute = and(eq(route.companyId, companyId), eq(route.id, routeRow.id))
  const onSession = () => and(eq(session.companyId, companyId), eq(session.id, made.sessionId!))
  for (const effect of effects) {
    switch (effect.kind) {
      case "start-route": {
        await tx.insert(session).values({
          id: effect.sessionId,
          companyId,
          projectId,
          routeId: routeRow.id,
          driverId: applier.profile.id,
          vehicleId: effect.vehicleId,
          trailerId: effect.trailerId,
          deviceId: envelope.deviceId,
          appVersion: effect.appVersion,
          startedAt: new Date(effect.at),
          lastSeenAt: applier.now,
        })
        await tx
          .update(route)
          .set({ status: "active", startedAt: new Date(effect.at), actualVehicleId: effect.vehicleId, actualDriverId: applier.profile.id, actualTrailerId: effect.trailerId })
          .where(onRoute)
        made.sessionId = effect.sessionId
        break
      }
      case "append-proof": {
        const { proof } = effect
        await tx.insert(proofOfService).values({
          id: proof.id,
          companyId,
          projectId,
          routeId: routeRow.id,
          pickupId: proof.pickupId,
          sessionId: made.sessionId,
          kind: proof.kind,
          source: "driver-app",
          occurredAt: new Date(proof.occurredAt),
          recordedBy: applier.principal.user.id,
          deviceId: envelope.deviceId,
          location: proof.location,
          locationAccuracyM: proof.locationAccuracyM,
          reason: proof.reason,
          note: proof.note,
          weightKg: proof.weightKg,
          volumeLitres: proof.volumeLitres,
          objectKey: proof.objectKey,
          outcome: null,
        })
        break
      }
      case "arrive":
        await tx
          .update(pickup)
          .set({ arrivedAt: new Date(effect.at) })
          .where(and(eq(pickup.companyId, companyId), eq(pickup.id, effect.pickupId), isNull(pickup.arrivedAt)))
        break
      case "pickup-outcome":
        await tx
          .update(pickup)
          .set({ status: effect.status, reason: effect.reason, outcomeAt: new Date(effect.at) })
          .where(and(eq(pickup.companyId, companyId), eq(pickup.id, effect.pickupId)))
        // What the outcome sets going: a work order's ledger movements and the booked ticket's service as the stop completes (O3b, O3c of #290); a miss reaches the ticket through Resolution's consumer.
        await stopOutcomeChanged(tx, actorOf(applier.principal), applier.send, effect.pickupId, { from: "planned", to: effect.status, occurredAt: effect.at, by: "driver" }, applier.now)
        break
      case "append-unload": {
        const { unload: draft } = effect
        await recordUnload(tx, companyId, {
          id: draft.id,
          projectId,
          routeId: routeRow.id,
          sessionId: made.sessionId,
          unloadingStationId: draft.unloadingStationId,
          wasteFractionId: draft.wasteFractionId,
          source: "driver-app",
          occurredAt: new Date(draft.occurredAt),
          recordedBy: applier.principal.user.id,
          deviceId: envelope.deviceId,
          location: draft.location,
          grossKg: draft.grossKg,
          tareKg: draft.tareKg,
          netKg: draft.netKg,
          weighbridgeTicket: draft.weighbridgeTicket,
          objectKey: draft.objectKey,
          note: draft.note,
          refusalReason: draft.refusalReason,
          refusalNote: draft.refusalNote,
        })
        // A tipped load of a fraction the station does not take is recorded all the same, and the office is told (O9 of #290).
        if (draft.refusalReason === null) {
          const takes = await stationTakes(tx, companyId, draft.unloadingStationId, draft.wasteFractionId)
          if (!takes.takes) {
            await tellOfficeNotTaken(tx, {
              companyId,
              projectId,
              routeId: routeRow.id,
              routeNumber: routeRow.number,
              driverId: applier.profile.id,
              recordedBy: applier.principal.user.id,
              netKg: draft.netKg,
              occurredAt: draft.occurredAt,
              takes,
              now: () => applier.now,
              send: applier.send,
            })
          }
        }
        break
      }
      case "pause":
        await tx.update(session).set({ pausedAt: new Date(effect.at) }).where(onSession())
        break
      case "resume":
        await tx.update(session).set({ pausedAt: null }).where(onSession())
        break
      case "end-route": {
        const at = new Date(effect.at)
        const closed = await tx
          .update(pickup)
          .set({ status: "skipped", reason: closingReasonOf("end"), outcomeAt: at })
          .where(and(eq(pickup.companyId, companyId), eq(pickup.routeId, routeRow.id), eq(pickup.status, "planned")))
          .returning({ id: pickup.id })
        made.closed = closed.map((row) => row.id)
        await tx.update(route).set({ status: "completed", completedAt: at }).where(onRoute)
        await tx.update(session).set({ endedAt: at }).where(onSession())
        break
      }
      case "append-positions":
        // At most `POSITIONS_MAX` rows, one statement: the fixes as the device kept them, in the session the command ran in.
        await tx.insert(sessionPosition).values(
          effect.points.map((point) => ({
            companyId,
            projectId,
            routeId: routeRow.id,
            sessionId: made.sessionId!,
            driverId: applier.profile.id,
            fixedAt: new Date(point.at),
            location: point.location,
            accuracyM: point.accuracyM,
            speedKmh: point.speedKmh ?? null,
            headingDeg: point.headingDeg ?? null,
          })),
        )
        break
      case "estimate-fill":
        // The latest estimate stands; the receipt keeps every one.
        await tx
          .update(pickup)
          .set({ fillLevel: effect.fill })
          .where(and(eq(pickup.companyId, companyId), eq(pickup.routeId, routeRow.id), eq(pickup.id, effect.pickupId)))
        break
      case "event":
        made.events.push(effect)
        break
    }
  }
  return made
}

/**
 * Records an application: the effects, `last_seen_at`, the receipt, the
 * events, all inside the command's savepoint, and the row the command made
 * read back as its result.
 */
async function recordApplication(tx: Tx, applier: Applier, envelope: DriverCommandEnvelope, read: Read, routeRow: RouteRow, effects: readonly Effect[]): Promise<CommandOutcomeRow> {
  const { companyId } = applier.principal
  const scope = receiptScope(applier, routeRow)
  // An applied command's route is assigned to the driver, and the assignment's own key puts them in one project.
  if (scope.routeId === null) throw new Error(`driver ${applier.profile.id} applied a command on route ${routeRow.id} of another project`)
  return await tx.transaction(async (savepoint) => {
    const made = await runEffects(savepoint, applier, envelope, read, routeRow, effects)
    if (made.sessionId !== null) {
      await savepoint.update(session).set({ lastSeenAt: applier.now }).where(and(eq(session.companyId, companyId), eq(session.id, made.sessionId)))
    }
    await writeReceipt(savepoint, applier, { envelope, scope, sessionId: made.sessionId, pickupId: read.pickup?.id ?? null, outcome: "applied" })
    // Each payload is read now, after the rows it describes: the resource the route would answer at this instant.
    const at = { projectId: scope.projectId, occurredAt: new Date(envelope.occurredAt) }
    for (const { event } of made.events) {
      if (event.kind === "route-problem-reported") {
        await emit(savepoint, applier.principal, { ...event, ...at, payload: await readRouteWithProofs(savepoint, companyId, event.aggregateId, envelope.id) })
      } else if (event.aggregate === "route") {
        await emit(savepoint, applier.principal, { ...event, ...at, payload: await routeNamed(savepoint, companyId, event.aggregateId) })
      } else if (event.aggregate === "pickup") {
        await emit(savepoint, applier.principal, { ...event, ...at, payload: await readPickupWithProofs(savepoint, companyId, event.aggregateId, envelope.id) })
      } else {
        const recorded = await resultOf(savepoint, companyId, envelope.kind, envelope.id, routeRow.id)
        if (recorded?.resource !== "unload") throw new Error(`command ${envelope.id} recorded no unload to tell of`)
        await emit(savepoint, applier.principal, { ...event, ...at, payload: recorded.value })
      }
    }
    for (const closedId of made.closed) {
      await emit(savepoint, applier.principal, { kind: "pickup-skipped", aggregateId: closedId, ...at, payload: await readPickupWithProofs(savepoint, companyId, closedId, envelope.id) })
    }
    const result = await resultOf(savepoint, companyId, envelope.kind, envelope.id, routeRow.id)
    return result === undefined ? { commandId: envelope.id, outcome: "applied" } : { commandId: envelope.id, outcome: "applied", result }
  })
}

/** One command through the door: the header's order. */
async function applyOne(tx: Tx, applier: Applier, envelope: DriverCommandEnvelope): Promise<CommandOutcomeRow> {
  const { companyId, user } = applier.principal
  const { profile } = applier
  const earlier = await findReceipt(tx, companyId, profile, envelope.id)
  if (earlier !== undefined) return await replayOf(tx, applier, earlier, envelope)

  await lockRow(tx, route, { companyId, id: envelope.routeId })
  const routeRow = await findRouteInCompany(tx, companyId, envelope.routeId)

  // The replay door as this one uses it (`replayed`, @waste/db/commands/shared): the write; or, the key met, the caller's own first answer; or, the key held by no receipt of the caller's, the rejection an id another device minted earns — never a replay, and recorded nowhere, since the receipt's key is that id, so the log has it.
  const replaying = () => findReceipt(tx, companyId, profile, envelope.id).then((found) => (found === undefined ? undefined : replayOf(tx, applier, found, envelope)))
  const taken = async (): Promise<CommandOutcomeRow> => {
    applier.log({ commandId: envelope.id, kind: envelope.kind, routeId: envelope.routeId, driverId: profile.id, userId: user.id, detail: ANOTHER_DEVICES_COMMAND })
    return { commandId: envelope.id, outcome: "rejected", problem: rejectionProblem(409, ANOTHER_DEVICES_COMMAND) }
  }
  const through = (write: () => Promise<CommandOutcomeRow>) => replayed(REPLAY_KEYS, write, replaying, taken)

  const parsed = COMMAND_BODIES[envelope.kind].safeParse(envelope.body)
  if (!parsed.success) {
    const invalid = invalidRequest("json", parsed.error.issues.map((issue) => ({ path: ["body", ...issue.path].map(String).join("."), message: issue.message })))
    const read = await readLookups(tx, applier, envelope, routeRow, undefined)
    return await through(() => recordRejection(tx, applier, envelope, read, invalid.body))
  }

  const read = await readLookups(tx, applier, envelope, routeRow, parsed.data)
  // The body was parsed by its kind's schema, which is the shape the domain's `CommandBodies[kind]` spells.
  const command = { id: envelope.id, kind: envelope.kind, routeId: envelope.routeId, occurredAt: envelope.occurredAt, deviceId: envelope.deviceId, body: parsed.data } as Command
  const driving: CommandDriver = { id: profile.id, name: profile.name, licenceClass: profile.licenceClass, licenceExpiry: profile.licenceExpiry }
  const decision = decide(command, driving, read.lookups, applier.clock)
  if ("reject" in decision) {
    const { status, detail, errors } = decision.reject
    return await through(() => recordRejection(tx, applier, envelope, read, rejectionProblem(status, detail, errors)))
  }
  // `decide` applies nothing to a route it did not find under the assignment.
  if (read.route === undefined) throw new Error(`decide applied ${envelope.kind} to route ${envelope.routeId}, which was not read`)
  const found = read.route
  // Applying nothing with a reason — a device ending a route the office cancelled meanwhile — is recorded as applied; the reason is the log's.
  if (decision.note !== undefined) applier.log({ commandId: envelope.id, kind: envelope.kind, routeId: envelope.routeId, note: decision.note })
  try {
    return await through(() => recordApplication(tx, applier, envelope, read, found, decision.apply))
  } catch (error) {
    // The race the route's lock does not see: two of this driver's routes started at once, each under its own lock, meeting on the one-live-session-per-driver index once the winner commits — the rule `decide` judged over `driverOpenOn` a statement too early. The command's savepoint has rolled its rows back; the winner is read and the loser recorded as the rejection the rule would have been, and the rest of the batch stands. The route's own index is the same news of a start the lock somehow did not serialise.
    const constraint = uniqueConstraintOf(error)
    if (constraint === DRIVER_OPEN_INDEX) {
      const winner = await driverOpenOn(tx, companyId, profile)
      // The index refused this insert for the winner's committed row, which the statement after reads; a row ended in between is a race of races, left to the error handler with the constraint's name.
      if (winner === undefined) throw error
      heldAtWrite(applier, envelope, constraint)
      return await through(() => recordRejection(tx, applier, envelope, read, rejectionProblem(409, alreadyOnRoute(profile.name, winner))))
    }
    if (constraint === ROUTE_OPEN_INDEX) {
      heldAtWrite(applier, envelope, constraint)
      return await through(() => recordRejection(tx, applier, envelope, read, rejectionProblem(409, alreadyActive(labelOf(found)))))
    }
    throw error
  }
}

/** What every route here describes the same way: no usable token, no grant, no driver profile. */
const driverProblems = (action: Action) => ({
  403: describeProblem(`No active account here, the caller's role does not allow \`${action}\` on \`operate.driver-app\`, or no active driver profile is bound to this login.`),
})

export function driverDoorRoutes(deps: RouteDeps) {
  const { now, log, jobs } = deps
  return routes(deps)
    .get(
      "/driver/me",
      {
        operationId: "getDriverMe",
        summary: "The driver's start screen",
        description:
          "The caller's own driver profile, the session they are on or null, the routes assigned to them that are `ready` or `active`, or `completed` today on their project's clock, and the three lists a start and an unload pick from: `vehicles`, the `active` powered vehicles and trailers of the driver profile's project, each with its `label` (the callsign, else the registration), `kind` and `requiredLicenceClass`; `unloadingStations`, the company's stations that are not `closed`, each with its `location`, whether it has a `weighbridge`, and the `wasteFractionIds` it accepts; and `wasteFractions`, the company's, each with its `key` and `name` — every list, and every station's fractions, by id. The caller is a driver: the account is bound to an active driver profile of the company (403 for the whole request otherwise), and the routes are the ones planned for or started by that driver — the assignment, never Project Access — so a service provider's driver, whose account works in no project, reads their assigned routes here, and picks from the same lists as any driver of their profile's project. The connected client's start screen; the offline one reads its synced buckets.",
        module: MODULE,
        action: "view",
        responses: {
          200: describeJson("The driver, the open session or null, the day's routes, and what a start and an unload pick from.", DriverMe),
          ...driverProblems("view"),
        },
      },
      async (c) => {
        const tx = c.get("tx")
        const principal = c.get("principal")
        const profile = await resolveDriver(tx, principal)
        const [row] = await tx.select(driverColumns).from(driver).where(and(eq(driver.companyId, principal.companyId), eq(driver.id, profile.id))).limit(1)
        // Resolved a moment ago in this same transaction.
        if (row === undefined) throw new Error(`driver ${profile.id} resolved and then not found`)
        const open = await openSessionOf(tx, principal.companyId, profile)
        const routes = await dayRoutes(tx, principal, profile, now(), {})
        const body: DriverMe = { driver: driverOf(row), openSession: open === undefined ? null : sessionOf(open), routes: await routesOf(tx, principal.companyId, routes), ...(await pickLists(tx, principal.companyId, profile)) }
        return c.json(body)
      },
    )
    .get(
      "/driver/routes",
      {
        operationId: "listDriverRoutes",
        summary: "The driver's routes",
        description:
          "One page of the routes assigned to the caller's driver profile that are `ready` or `active`, or `completed` today on their project's clock — the same routes `GET /driver/me` answers — oldest first; `status` narrows the page to one of those statuses. Bounded by the assignment (planned for or started by this driver) and never by Project Access. Hand `nextCursor` back as `cursor` for the next page.",
        module: MODULE,
        action: "view",
        query: DriverRouteListQuery,
        invalid: ["`status` is not a route status"],
        responses: {
          200: describeJson("One page of the driver's routes, each with its progress.", RoutePage),
          ...driverProblems("view"),
        },
      },
      async (c) => {
        const { limit, cursor, status } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        const profile = await resolveDriver(tx, principal)
        const rows = await dayRoutes(tx, principal, profile, now(), { status, after, limit: fetchLimit(limit) })
        // Paged first, so the row that only proves there is a next page is not one whose progress is counted.
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: await routesOf(tx, principal.companyId, items), nextCursor })
      },
    )
    .get(
      "/driver/routes/:id",
      {
        operationId: "getDriverRoute",
        summary: "One of the driver's routes, with its stops and their places",
        description:
          "The route with what hangs off it: its pickups by position, each with its place joined — the `address` and `location` (a point, or null for a property not yet geocoded) of the property or the shared collection point the pickup names on the service date, the container's `label` (null on an address-only stop the office added, which names no container) and the waste fraction's `name` — the open session or null, every session oldest first, and its unloads oldest first: what a device without sync reads to run the route, and the one read that denormalises for the wire what the synced device joins from its own buckets. A route not assigned to the caller's driver profile, of another company, or not there at all is answered the same way (404, `No route <id> assigned to this driver`), so the device learns nothing about routes it was not given.",
        module: MODULE,
        action: "view",
        params: IdParam,
        responses: {
          200: describeJson("The route with its pickups and their places, its sessions and its unloads.", DriverRouteDetail),
          ...driverProblems("view"),
          404: describeProblem("No route with that id is assigned to this driver."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const profile = await resolveDriver(tx, principal)
        const row = await findAssignedRoute(tx, principal, profile, id)
        if (row === undefined) throw noSuchAssignedRoute(id)
        const [answered, pickups] = await Promise.all([routeWithSessions(tx, principal.companyId, row), driverPickupsOfRoute(tx, principal.companyId, id)])
        // The driver door orders by sequence and reads only the active Plan of a route assigned to them (#124 §5).
        const context = await planContextOf(tx, principal.companyId, row, pickups)
        const body: DriverRouteDetail = { ...answered, pickups: sequencedPickups(pickups, context), activePlan: context.activePlan }
        return c.json(body)
      },
    )
    .get(
      "/driver/routes/:id/identify",
      {
        operationId: "identifyOnDriverRoute",
        summary: "Which stop of the driver's route a code read off a bin names",
        description:
          "A code read off a bin — scanned by the phone's camera or typed in, off the label or a hand-held RFID reader — looked up among the containers of one of the driver's routes (O19 of #290): `stops` lists each stop whose container one of whose identifiers (the label, the barcode, the RFID tag, the serial number) spells the code, spaces either side and case ignored, with the `matchedBy` identifier, and each swap whose replacement it names with `replacement` true — by position, empty when the code names no container on this route. Only the route's own containers are read, so a device learns nothing of the company's other bins. A read and never a record: the confirmation is an `arrive` that carries the code as its `identification`, which the door judges against the stop's container again. A route not assigned to the caller's driver profile, of another company, or not there at all is answered 404, as `GET /driver/routes/:id` answers it.",
        module: MODULE,
        action: "view",
        params: IdParam,
        query: DriverIdentifyQuery,
        invalid: ["`code` is missing, blank or longer than a label"],
        responses: {
          200: describeJson("The stops of the route the code names, by position; none when it names no container here.", DriverIdentification),
          ...driverProblems("view"),
          404: describeProblem("No route with that id is assigned to this driver."),
        },
      },
      async (c) => {
        const { id } = c.req.valid("param")
        const { code } = c.req.valid("query")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const profile = await resolveDriver(tx, principal)
        const row = await findAssignedRoute(tx, principal, profile, id)
        if (row === undefined) throw noSuchAssignedRoute(id)
        const body: DriverIdentification = { code: code.trim(), stops: await identifiedStopsOfRoute(tx, principal.companyId, id, code) }
        return c.json(body)
      },
    )
    .post(
      "/driver/commands",
      {
        operationId: "applyDriverCommands",
        summary: "Apply a device's queued commands",
        description:
          "The driver door of ADR-0004. The body is one to two hundred commands, each `{ id, kind, routeId, occurredAt, deviceId, body }` with an id the device minted (a UUIDv7, the command's idempotency key and the id of the row it makes), applied in body order, each in its own savepoint, and answered 200 with one outcome per command in order — `applied` with the row it made, `replayed` with the first outcome for an id this driver's devices already sent (nothing written, a command that differs in kind, route, instant, device or body logged and ignored), or `rejected` with the problem, which is recorded in the command's receipt as well. An id that another device's command already holds — another driver's, whatever its company — is refused (409, `That command id belongs to another device's command`) and never replayed, since a replay would hand that command's rows to a device that did not send it; it is the one rejection no receipt can hold, the receipt's key being that id, so it is logged instead. A 400 is for a batch that does not parse (an id twice, more than two hundred, an envelope out of shape): then nothing is applied and nothing recorded. A body that fails its kind's schema is one command's rejection, never the batch's. The " +
          DRIVER_COMMAND_KINDS.length +
          " kinds and their bodies: `start-route` (`vehicleId`, `trailerId?`, `appVersion?`, `location?`) opens the session and moves the route `ready → active`; `arrive` (`pickupId`, `identification?`, `location?`, `accuracyM?`) appends an arrival and sets the pickup's first `arrivedAt`, and with an `identification` (`{ code, method }`: a code read off the bin by the `camera` or `typed`) confirms the stop's container — refused at `body.identification.code` when the code names no container of the stop (400, `WH82014 is not the container of pickup 12`) and at `body.identification` on a stop with no container (400), the receipt of an applied one being the confirmation `GET /driver/routes/:id` reads as the stop's `containerConfirmedAt`; `complete-pickup`, `skip-pickup` and `fail-pickup` (`pickupId`, a `reason` for the last two, `note?`, `location?`) append the proof and move the pickup out of `planned`; `report-problem` (`pickupId?`, `reason`, `note`, `location?`) appends a problem and moves nothing; `add-photo` and `add-signature` (`pickupId` — optional for a photo — and `objectKey`) and `add-weight` (`pickupId`, `weightKg`), `record-volume` (`pickupId`, `volumeLitres`: the whole litres a tank was emptied of, M11 of #293) and `add-note` (`pickupId?`, `note`) append evidence; `record-unload` (`unloadingStationId`, `wasteFractionId`, `netKg`, `grossKg?`, `tareKg?`, `weighbridgeTicket?`, `objectKey?`, `location?`, `note?`) appends an unload; `pause` and `resume` (`{}`) set and clear the session's `pausedAt`, idempotently; `end-route` (`location?`, `note?`) closes every planned pickup as `skipped · route-ended`, moves the route `active → completed` and ends the session; `record-positions` (`points`: one to sixty fixes, each `{ at, location, accuracyM, speedKmh?, headingDeg? }`, in the order they were taken) appends where the session's vehicle was, one position per fix, and writes no event. The rules, judged in this order and each answering its sentence: the route is one of this driver's (404, `No route <id> assigned to this driver`); `occurredAt` is at most five minutes ahead of the request's clock (400, `Recorded after it happened`) and at most forty-eight hours behind it (400, `Recorded more than 48 hours after it happened`); `start-route` wants a `ready` route (409, `Route RC-1042 is not dispatched; a driver starts a ready route` / `… is already active` / `… is completed and does not change`), a driver on no other route (409, `Mads Jensen is already on route RC-1039; end it first` — held again at the write: two of the driver's routes started at once, each batch under its own route's lock, meet on the one-live-session-per-driver index once the first commits, and the second is that command's rejection with this sentence naming the route that won, the rest of its batch standing), a powered vehicle of the route's project (400 at `body.vehicleId`, `Not a powered vehicle of this project`) and a trailer where one is named (400 at `body.trailerId`), the licence the vehicle requires on the operating date (400 at `body.vehicleId`, `Freja Holm needs a C licence for WH-24`), and a vehicle and trailer in service (409, `WH-99 is retired; a route needs a vehicle in service`); every later command wants an `active` route with this driver's open session on it (409, `Route RC-1042 is not active`) and an instant at or after the session started (400, `Before the session started`), and every fix of a `record-positions` the same two clock bounds and the session's start at its own field (400 at `body.points.<n>.at`), a paused session taking them all the same; a command naming a pickup wants one of the route's (404, `No pickup <id> on route RC-1042`), and an outcome wants a `planned` one (409, `Pickup 12 is already completed`: the first outcome stands and a second is a rejection, not a change); `record-unload` wants a station and a fraction of the company (400 at `body.unloadingStationId` / `body.wasteFractionId`); an `objectKey` is `<companyId>/<routeId>/<commandId>.<jpg|jpeg|png|webp>` for this command (400 at `body.objectKey`, `The object key names another route or another command`). A vehicle or trailer not in service is refused naming its status (409, `WH-99 is retired; a route needs a vehicle in service`). Every applied command moves the session's `lastSeenAt` to the request's clock and writes its outbox events — a pickup's event carries the pickup with the proofs this command made, a route-level `report-problem`'s `route-problem-reported` the route with its problem proof as `proofs` the same way, so the reason and the note travel with it, and the route's other events the route alone; every command's receipt is written with the body verbatim, but a `record-positions`'s, which keeps the count of its fixes and none of their points (`{ points: <count> }`), a position being personal data the receipt would otherwise outlive — a rejection for a route of another project, another company or none is recorded without a route, in the driver's project, the claimed route id kept beside the body as `{ routeId, body }`, and one for a route of their project assigned to another driver names that route — which `GET /driver/routes/:id` still answers 404 for — and no session and no pickup, since nothing of a route the driver was not given is read for it. An `end-route` on a route the office cancelled meanwhile is applied as nothing, so the device is not locked out. `record-fill` (`pickupId`, `fill`: `empty`, `quarter`, `half`, `three-quarters`, `full` or `overflowing`, M23 of #293) sets how full the stop's container was, whatever the stop's outcome, a later estimate replacing it, and answers the stop; a stop with no container is refused at `body.pickupId` (400, `Pickup 12 names no container whose fill to estimate`).",
        module: MODULE,
        action: "edit",
        body: DriverCommandBatch,
        invalid: ["the batch does not parse: no commands or more than two hundred, an id named twice, or an envelope out of shape. Nothing was applied or recorded"],
        responses: {
          200: describeJson("One outcome per command, in body order.", DriverCommandBatchOutcome),
          ...driverProblems("edit"),
        },
      },
      async (c) => {
        const { commands } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const profile = await resolveDriver(tx, principal)
        const at = now()
        const applier: Applier = { principal, profile, clock: { now: at.toISOString(), skewAheadMs: OCCURRED_AT_SKEW_MS, backdateMs: COMMAND_BACKDATE_MS }, now: at, log, send: jobs.send }
        const outcomes: CommandOutcomeRow[] = []
        for (const envelope of commands) outcomes.push(await applyOne(tx, applier, envelope))
        const body: DriverCommandBatchOutcome = { outcomes }
        return c.json(body)
      },
    )
    .get(
      "/driver/commands",
      {
        operationId: "listDriverCommands",
        summary: "The driver's receipts",
        description:
          "One page of the receipts of every command this driver's devices ever sent, applied or rejected, oldest first — ids are time-ordered by the device's clock, so a cursor over them is a cursor over the order the commands were minted in — each with the body as it arrived and, on a rejection, the problem it was refused with. `routeId` names the route the command claimed when that route is of this driver's project — one assigned to another driver included, which `GET /driver/routes/:id` still answers 404 for, so a receipt may name a route the device cannot read — and is null for a route of another project, another company or none, the claimed id then kept in the body as `{ routeId, body }`. `routeId` narrows the page to one route's. Hand `nextCursor` back as `cursor` for the next page.",
        module: MODULE,
        action: "view",
        query: DriverReceiptListQuery,
        invalid: ["`routeId` is not an id"],
        responses: {
          200: describeJson("One page of receipts.", ReceiptPage),
          ...driverProblems("view"),
        },
      },
      async (c) => {
        const { limit, cursor, routeId } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        const profile = await resolveDriver(tx, principal)
        const rows = await tx
          .select(receiptColumns)
          .from(driverCommand)
          .where(
            and(
              eq(driverCommand.companyId, principal.companyId),
              eq(driverCommand.driverId, profile.id),
              routeId === undefined ? undefined : eq(driverCommand.routeId, routeId),
              after === undefined ? undefined : gt(driverCommand.id, after),
            ),
          )
          .orderBy(asc(driverCommand.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(receiptOf), limit))
      },
    )
}
