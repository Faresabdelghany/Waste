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
//   the receipt   — read first, by the command's id. Found: the stored outcome
//                   is answered again as `replayed`, with the row it made read
//                   back or the problem it was refused with, and nothing is
//                   written, not even `last_seen_at`. A replay whose body
//                   differs from the stored one is still the first answer —
//                   a replayed command is a no-op answering the first result
//                   — and the difference is logged, since it is the client's
//                   bug and not the server's decision to make;
//   the lock      — the route's row (`lockRow`), so commands on one route take
//                   turns with each other and with the office's cancel, and
//                   two uploads of one batch serialise on it: the second reads
//                   the first's receipt and replays. The route is then read by
//                   id inside the company and not under the assignment, since
//                   `decide` judges the assignment itself and the receipt of a
//                   refused command needs the route's project;
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
//                   the pickup, `append-unload` writes the row, `pause`,
//                   `resume` and `end-route` move the session and the route,
//                   `end-route` closing the open pickups as `skipped ·
//                   route-ended` from its own `returning`. Every applied
//                   command then moves `session.last_seen_at` to the
//                   request's clock;
//   the receipt   — written after the effects (`driver_command`: the outcome,
//                   the problem on a rejection, the body verbatim), and the
//                   outbox events last (outbox.ts), each with the resource the
//                   route would answer at that instant as its payload, a
//                   rejection's being the receipt itself.
//
// All of it inside the command's savepoint, so a command that fails midway
// leaves nothing of itself behind and the batch goes on. A race the lock did
// not see — two uploads of one batch meeting on a primary key, the receipt's
// or that of the row the command makes with the same id — is the fourth door,
// `replayed` in routes/shared.ts: the savepoint rolls the loser's rows back and
// the first receipt is read and answered as `replayed`, a 200 and never a
// 409, because here the key is the command and the command has already
// happened.
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
// The wire shapes are routes/execution-shapes.ts's, shared with the office's
// four modules; the door's own is the scope there (`driverRouteScope`,
// `findAssignedRoute`, `noSuchAssignedRoute`), whose fence is the assignment
// where the office's is `inProjects`.
import { COMMAND_BODIES, CommandOutcomeRow, DriverCommandBatch, DriverCommandBatchOutcome, DriverCommandReceipt, DriverMe, type CommandResult, type DriverCommandEnvelope } from "@waste/contracts/driver-commands"
import { RouteStatus, routeLabel } from "@waste/contracts/execution"
import { Id } from "@waste/contracts/ids"
import { Page, PageRequest } from "@waste/contracts/pagination"
import type { Problem } from "@waste/contracts/problem"
import { Route, RouteDetail } from "@waste/contracts/routes"
import type { Tx } from "@waste/db/client"
import { wasteFraction } from "@waste/db/schema/catalogue"
import { driverCommand, pickup, proofOfService, route, session, unload } from "@waste/db/schema/execution"
import { driver, vehicle } from "@waste/db/schema/fleet"
import { project } from "@waste/db/schema/organisation"
import { unloadingStation } from "@waste/db/schema/places"
import { decide, type Clock, type Command, type CommandDriver, type Effect, type Lookups, type PickupState, type RouteState, type SessionState, type VehicleState } from "@waste/domain/execution/commands"
import { closingReasonOf } from "@waste/domain/execution/transitions"
import type { DriverCommandKind, OutboxAggregate, OutboxKind } from "@waste/domain/execution/vocabulary"
import type { LicenceClass, VehicleKind, VehicleStatus } from "@waste/domain/resources/vocabulary"
import { and, asc, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import { isDeepStrictEqual } from "node:util"

import { resolveDriver, type DriverProfile } from "../auth/driver"
import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { emit } from "../outbox"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problemBody, validate } from "../problem"
import { driverColumns, driverOf } from "./drivers"
import {
  driverRouteScope,
  findAssignedRoute,
  noSuchAssignedRoute,
  pickupColumns,
  pickupOf,
  progressByRoute,
  proofColumns,
  proofOf,
  receiptColumns,
  receiptOf,
  routeColumns,
  routeOf,
  sessionColumns,
  sessionOf,
  unloadColumns,
  unloadOf,
  type PickupRow,
  type ReceiptRow,
  type RouteRow,
  type SessionRow,
} from "./execution-shapes"
import { vehicleColumns, vehicleLabel } from "./fleet-lookups"
import { COMMAND_BACKDATE_MS, describeJson, IdParam, lockRow, OCCURRED_AT_SKEW_MS, primaryKeyOf, replayed } from "./shared"

const MODULE = "operate.driver-app"
const RoutePage = Page(Route)
const ReceiptPage = Page(DriverCommandReceipt)

/** `GET /driver/routes`: the page, narrowed to one status of the day's routes. */
const DriverRouteListQuery = PageRequest.extend({ status: RouteStatus.optional() })

/** `GET /driver/commands`: the page, narrowed to one route's receipts. */
const DriverReceiptListQuery = PageRequest.extend({ routeId: Id.optional() })

/** The primary keys a race between two uploads of one batch can meet: the receipt's, and that of the row a command makes with the same id. */
const REPLAY_KEYS = [primaryKeyOf(driverCommand), primaryKeyOf(session), primaryKeyOf(proofOfService), primaryKeyOf(unload)]

/**
 * The routes a driver's day is made of: `ready` or `active`, or `completed`
 * today on the project's clock (`now() at time zone project.timezone`, the
 * precedent of the groups-in-force read). The request's clock goes in as an
 * ISO string cast to `timestamptz`, since the raw face takes no Date.
 */
const todays = (now: Date): SQL =>
  or(
    inArray(route.status, ["ready", "active"]),
    and(eq(route.status, "completed"), sql`(${route.completedAt} at time zone ${project.timezone})::date = (${now.toISOString()}::timestamptz at time zone ${project.timezone})::date`),
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

/** The open session of this driver, whichever route it is on; undefined when none. */
async function openSessionOf(tx: Tx, companyId: string, profile: DriverProfile): Promise<SessionRow | undefined> {
  const [row] = await tx
    .select(sessionColumns)
    .from(session)
    .where(and(eq(session.companyId, companyId), eq(session.driverId, profile.id), isNull(session.endedAt)))
    .limit(1)
  return row
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
  /** Where a replay with a differing body, or a rejection no receipt can hold, is noted. */
  log: (entry: unknown) => void
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

/** The receipt by the command's id, in this company; undefined when the command is new. */
async function findReceipt(tx: Tx, companyId: string, id: string): Promise<ReceiptRow | undefined> {
  const [row] = await tx
    .select(receiptColumns)
    .from(driverCommand)
    .where(and(eq(driverCommand.companyId, companyId), eq(driverCommand.id, id)))
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
  return { id: row.id, label: vehicleLabel(row), kind: row.kind as VehicleKind, status: row.status as VehicleStatus, requiredLicenceClass: row.requiredLicenceClass as LicenceClass }
}

/** Whether a row of this company exists in a company-wide table: the station and the fraction a `record-unload` names. */
async function knownToCompany(tx: Tx, table: typeof unloadingStation | typeof wasteFraction, companyId: string, id: string): Promise<boolean> {
  const [row] = await tx.select({ id: table.id }).from(table).where(and(eq(table.companyId, companyId), eq(table.id, id))).limit(1)
  return row !== undefined
}

const routeState = (row: RouteRow): RouteState => ({ id: row.id, label: routeLabel(row.number), status: row.status as RouteState["status"], plannedDriverId: row.plannedDriverId, actualDriverId: row.actualDriverId, operatingDate: row.operatingDate })
const sessionState = (row: SessionRow): SessionState => ({ id: row.id, driverId: row.driverId, startedAt: row.startedAt.toISOString(), endedAt: row.endedAt === null ? null : row.endedAt.toISOString(), pausedAt: row.pausedAt === null ? null : row.pausedAt.toISOString() })
const pickupState = (row: PickupRow): PickupState => ({ id: row.id, position: row.position, status: row.status as PickupState["status"], arrivedAt: row.arrivedAt === null ? null : row.arrivedAt.toISOString() })

/**
 * Everything `decide` asks for, each lookup bounded the way the door bounds
 * it, and only what the kind needs: the open session on the route for every
 * kind, the route the driver has a session open on for `start-route`, the
 * pickup the body names, the vehicle and the trailer of the route's project,
 * the station and the fraction of the company. Nothing is read for a route
 * that is not there, since the first rule refuses before any of it is asked.
 */
async function readLookups(tx: Tx, applier: Applier, envelope: DriverCommandEnvelope, routeRow: RouteRow | undefined, body: unknown): Promise<Read> {
  const { companyId } = applier.principal
  const lookups: Lookups = { companyId, route: undefined, session: undefined, driverOpenOn: undefined, pickup: undefined, vehicle: undefined, trailer: undefined, stationKnown: false, fractionKnown: false }
  if (routeRow === undefined) return { lookups, route: undefined, session: undefined, pickup: undefined }
  lookups.route = routeState(routeRow)

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
    const [driving] = await tx
      .select({ number: route.number })
      .from(session)
      .innerJoin(route, and(eq(route.companyId, session.companyId), eq(route.id, session.routeId)))
      .where(and(eq(session.companyId, companyId), eq(session.driverId, applier.profile.id), isNull(session.endedAt)))
      .limit(1)
    if (driving !== undefined) lookups.driverOpenOn = routeLabel(driving.number)
    const { vehicleId, trailerId } = fields
    if (typeof vehicleId === "string") lookups.vehicle = await findVehicleState(tx, companyId, routeRow.projectId, vehicleId)
    if (typeof trailerId === "string") lookups.trailer = await findVehicleState(tx, companyId, routeRow.projectId, trailerId)
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

/** The commands whose result is the proof they appended with their id; `start-route` and `end-route` append one too, but answer the session and the route. */
const PROOF_COMMANDS: readonly DriverCommandKind[] = ["arrive", "complete-pickup", "skip-pickup", "fail-pickup", "report-problem", "add-photo", "add-weight", "add-signature", "add-note"]

/**
 * The row a command made, read back and tagged with what it is: a session
 * for `start-route`, a proof for the evidence and outcome commands, an unload
 * for `record-unload`, the route for `end-route`, nothing for `pause` and
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
  if (PROOF_COMMANDS.includes(kind)) {
    const [row] = await tx.select(proofColumns).from(proofOfService).where(and(eq(proofOfService.companyId, companyId), eq(proofOfService.id, id))).limit(1)
    return row === undefined ? undefined : { resource: "proof", value: proofOf(row) }
  }
  if (kind === "record-unload") {
    const [row] = await tx.select(unloadColumns).from(unload).where(and(eq(unload.companyId, companyId), eq(unload.id, id))).limit(1)
    return row === undefined ? undefined : { resource: "unload", value: unloadOf(row) }
  }
  if (kind === "end-route" && routeId !== null) {
    const found = await readRoute(tx, companyId, routeId)
    return found === undefined ? undefined : { resource: "route", value: found }
  }
  return undefined
}

/** The route on the wire as it stands, with its progress; undefined when it is somehow gone. */
async function readRoute(tx: Tx, companyId: string, id: string): Promise<Route | undefined> {
  const row = await findRouteInCompany(tx, companyId, id)
  if (row === undefined) return undefined
  const progress = await progressByRoute(tx, companyId, [id])
  return routeOf(row, progress.get(id)!)
}

/** A pickup on the wire as it stands, with the proofs this command made for it: the payload of a pickup event. */
async function readPickupWithProofs(tx: Tx, companyId: string, pickupId: string, commandId: string): Promise<unknown> {
  const [row] = await tx.select(pickupColumns).from(pickup).where(and(eq(pickup.companyId, companyId), eq(pickup.id, pickupId))).limit(1)
  if (row === undefined) return undefined
  const proofs = await tx
    .select(proofColumns)
    .from(proofOfService)
    .where(and(eq(proofOfService.companyId, companyId), eq(proofOfService.pickupId, pickupId), eq(proofOfService.id, commandId)))
  return { ...pickupOf(row), proofs: proofs.map(proofOf) }
}

/** The receipt's first answer, given again: the stored outcome with the row it made read back or the problem it was refused with, and nothing written. */
async function replayOf(tx: Tx, applier: Applier, receipt: ReceiptRow, envelope: DriverCommandEnvelope): Promise<CommandOutcomeRow> {
  if (!isDeepStrictEqual(receipt.body, bodyKept(envelope, receipt.routeId))) {
    applier.log({ commandId: envelope.id, kind: envelope.kind, detail: "replayed with a body that differs from the first upload; the first answer stands" })
  }
  if (receipt.outcome === "rejected") return { commandId: receipt.id, outcome: "replayed", problem: receipt.problem as Problem }
  const result = await resultOf(tx, applier.principal.companyId, receipt.kind as DriverCommandKind, receipt.id, receipt.routeId)
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
  const body = envelope.body === undefined ? null : envelope.body
  return routeId === null ? { routeId: envelope.routeId, body } : body
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

/** One outbox event of a command, its payload read now: the resource the route would answer at this instant. */
async function emitFor(tx: Tx, applier: Applier, envelope: DriverCommandEnvelope, projectId: string, kind: OutboxKind, aggregate: OutboxAggregate, aggregateId: string, payload: unknown): Promise<void> {
  await emit(tx, applier.principal, { aggregate, aggregateId, kind, payload, projectId, occurredAt: new Date(envelope.occurredAt) })
}

/**
 * Records a rejection: the receipt with its problem, then `command-rejected`
 * with the receipt as payload, inside the command's savepoint. Every
 * rejection is recorded; one for a route the driver does not reach is
 * recorded without a route (`receiptScope`).
 */
async function recordRejection(tx: Tx, applier: Applier, envelope: DriverCommandEnvelope, read: Read, problem: Problem): Promise<CommandOutcomeRow> {
  const outcome: CommandOutcomeRow = { commandId: envelope.id, outcome: "rejected", problem }
  const scope = receiptScope(applier, read.route)
  await tx.transaction(async (savepoint) => {
    const receipt = await writeReceipt(savepoint, applier, { envelope, scope, sessionId: read.session?.id ?? null, pickupId: read.pickup?.id ?? null, outcome: "rejected", problem })
    await emitFor(savepoint, applier, envelope, scope.projectId, "command-rejected", "command", envelope.id, receipt)
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
        break
      case "append-unload": {
        const { unload: draft } = effect
        await tx.insert(unload).values({
          id: draft.id,
          companyId,
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
        })
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
    for (const event of made.events) {
      const payload =
        event.aggregate === "route"
          ? await readRoute(savepoint, companyId, event.aggregateId)
          : event.aggregate === "pickup"
            ? await readPickupWithProofs(savepoint, companyId, event.aggregateId, envelope.id)
            : (await resultOf(savepoint, companyId, envelope.kind, envelope.id, routeRow.id))?.value
      await emitFor(savepoint, applier, envelope, scope.projectId, event.event, event.aggregate, event.aggregateId, payload)
    }
    for (const closedId of made.closed) {
      await emitFor(savepoint, applier, envelope, scope.projectId, "pickup-skipped", "pickup", closedId, await readPickupWithProofs(savepoint, companyId, closedId, envelope.id))
    }
    const result = await resultOf(savepoint, companyId, envelope.kind, envelope.id, routeRow.id)
    return result === undefined ? { commandId: envelope.id, outcome: "applied" } : { commandId: envelope.id, outcome: "applied", result }
  })
}

/** One command through the door: the header's order. */
async function applyOne(tx: Tx, applier: Applier, envelope: DriverCommandEnvelope): Promise<CommandOutcomeRow> {
  const { companyId } = applier.principal
  const earlier = await findReceipt(tx, companyId, envelope.id)
  if (earlier !== undefined) return await replayOf(tx, applier, earlier, envelope)

  await lockRow(tx, route, { companyId, id: envelope.routeId })
  const routeRow = await findRouteInCompany(tx, companyId, envelope.routeId)

  const parsed = COMMAND_BODIES[envelope.kind].safeParse(envelope.body)
  const replaying = () => findReceipt(tx, companyId, envelope.id).then((found) => (found === undefined ? undefined : replayOf(tx, applier, found, envelope)))
  if (!parsed.success) {
    const invalid = invalidRequest("json", parsed.error.issues.map((issue) => ({ path: ["body", ...issue.path].map(String).join("."), message: issue.message })))
    const read = await readLookups(tx, applier, envelope, routeRow, undefined)
    return await replayed(REPLAY_KEYS, () => recordRejection(tx, applier, envelope, read, invalid.body), replaying)
  }

  const read = await readLookups(tx, applier, envelope, routeRow, parsed.data)
  // The body was parsed by its kind's schema, which is the shape the domain's `CommandBodies[kind]` spells.
  const command = { id: envelope.id, kind: envelope.kind, routeId: envelope.routeId, occurredAt: envelope.occurredAt, deviceId: envelope.deviceId, body: parsed.data } as Command
  const driving: CommandDriver = { id: applier.profile.id, name: applier.profile.name, licenceClass: applier.profile.licenceClass, licenceExpiry: applier.profile.licenceExpiry }
  const decision = decide(command, driving, read.lookups, applier.clock)
  if ("reject" in decision) {
    const { status, detail, errors } = decision.reject
    return await replayed(REPLAY_KEYS, () => recordRejection(tx, applier, envelope, read, rejectionProblem(status, detail, errors)), replaying)
  }
  // `decide` applies nothing to a route it did not find under the assignment.
  if (read.route === undefined) throw new Error(`decide applied ${envelope.kind} to route ${envelope.routeId}, which was not read`)
  const found = read.route
  // Applying nothing with a reason — a device ending a route the office cancelled meanwhile — is recorded as applied; the reason is the log's.
  if (decision.note !== undefined) applier.log({ commandId: envelope.id, kind: envelope.kind, routeId: envelope.routeId, note: decision.note })
  return await replayed(REPLAY_KEYS, () => recordApplication(tx, applier, envelope, read, found, decision.apply), replaying)
}

/** What every route here describes the same way: no usable token, no grant, no driver profile. */
const driverProblems = (action: "view" | "edit") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, the caller's role does not allow \`${action}\` on \`operate.driver-app\`, or no active driver profile is bound to this login.`),
})

export type DriverDoorOptions = {
  /** The request's clock: what the commands' instants are judged against and what `last_seen_at` moves to; the app's, so a test can pin it. */
  now?: () => Date
  /** Where a replay with a differing body, or a rejection no receipt can hold, is noted; `console.warn` unless a test wants to look. */
  log?: (entry: unknown) => void
}

export function driverDoorRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date(), log = console.warn }: DriverDoorOptions = {}) {
  return new Hono<AuthEnv>()
    .get(
      "/driver/me",
      describeRoute({
        operationId: "getDriverMe",
        summary: "The driver's start screen",
        description:
          "The caller's own driver profile, the session they are on or null, and the routes assigned to them that are `ready` or `active`, or `completed` today on their project's clock. The caller is a driver: the account is bound to an active driver profile of the company (403 for the whole request otherwise), and the routes are the ones planned for or started by that driver — the assignment, never Project Access — so a service provider's driver, whose account works in no project, reads their assigned routes here. The connected client's start screen; the offline one reads its synced buckets.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The driver, the open session or null, and the day's routes.", DriverMe),
          ...driverProblems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      async (c) => {
        const tx = c.get("tx")
        const principal = c.get("principal")
        const profile = await resolveDriver(tx, principal)
        const [row] = await tx.select(driverColumns).from(driver).where(and(eq(driver.companyId, principal.companyId), eq(driver.id, profile.id))).limit(1)
        // Resolved a moment ago in this same transaction.
        if (row === undefined) throw new Error(`driver ${profile.id} resolved and then not found`)
        const open = await openSessionOf(tx, principal.companyId, profile)
        const routes = await dayRoutes(tx, principal, profile, now(), {})
        const progress = await progressByRoute(tx, principal.companyId, routes.map((found) => found.id))
        const body: DriverMe = { driver: driverOf(row), openSession: open === undefined ? null : sessionOf(open), routes: routes.map((found) => routeOf(found, progress.get(found.id)!)) }
        return c.json(body)
      },
    )
    .get(
      "/driver/routes",
      describeRoute({
        operationId: "listDriverRoutes",
        summary: "The driver's routes",
        description:
          "One page of the routes assigned to the caller's driver profile that are `ready` or `active`, or `completed` today on their project's clock — the same routes `GET /driver/me` answers — oldest first; `status` narrows the page to one of those statuses. Bounded by the assignment (planned for or started by this driver) and never by Project Access. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of the driver's routes, each with its progress.", RoutePage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, or `status` is not a route status."),
          ...driverProblems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", DriverRouteListQuery),
      async (c) => {
        const { limit, cursor, status } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        const profile = await resolveDriver(tx, principal)
        const rows = await dayRoutes(tx, principal, profile, now(), { status, after, limit: fetchLimit(limit) })
        const progress = await progressByRoute(tx, principal.companyId, rows.map((found) => found.id))
        return c.json(pageOf(rows.map((found) => routeOf(found, progress.get(found.id)!)), limit))
      },
    )
    .get(
      "/driver/routes/:id",
      describeRoute({
        operationId: "getDriverRoute",
        summary: "One of the driver's routes, with its stops",
        description:
          "The route with what hangs off it: its pickups by position, the open session or null, every session oldest first, and its unloads oldest first — what a device without sync reads to run the route. A route not assigned to the caller's driver profile, of another company, or not there at all is answered the same way (404, `No route <id> assigned to this driver`), so the device learns nothing about routes it was not given.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The route with its pickups, sessions and unloads.", RouteDetail),
          400: describeProblem("The path does not hold an id."),
          ...driverProblems("view"),
          404: describeProblem("No route with that id is assigned to this driver."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const profile = await resolveDriver(tx, principal)
        const row = await findAssignedRoute(tx, principal, profile, id)
        if (row === undefined) throw noSuchAssignedRoute(id)
        const { companyId } = principal
        const pickups = await tx
          .select(pickupColumns)
          .from(pickup)
          .where(and(eq(pickup.companyId, companyId), eq(pickup.routeId, id)))
          .orderBy(asc(pickup.position), asc(pickup.id))
        const sessions = await tx
          .select(sessionColumns)
          .from(session)
          .where(and(eq(session.companyId, companyId), eq(session.routeId, id)))
          .orderBy(asc(session.id))
        const unloads = await tx
          .select(unloadColumns)
          .from(unload)
          .where(and(eq(unload.companyId, companyId), eq(unload.routeId, id)))
          .orderBy(asc(unload.id))
        const progress = await progressByRoute(tx, companyId, [id])
        const open = sessions.find((found) => found.endedAt === null)
        const body: RouteDetail = {
          ...routeOf(row, progress.get(id)!),
          pickups: pickups.map(pickupOf),
          session: open === undefined ? null : sessionOf(open),
          sessions: sessions.map(sessionOf),
          unloads: unloads.map(unloadOf),
        }
        return c.json(body)
      },
    )
    .post(
      "/driver/commands",
      describeRoute({
        operationId: "applyDriverCommands",
        summary: "Apply a device's queued commands",
        description:
          "The driver door of ADR-0004. The body is one to two hundred commands, each `{ id, kind, routeId, occurredAt, deviceId, body }` with an id the device minted (a UUIDv7, the command's idempotency key and the id of the row it makes), applied in body order, each in its own savepoint, and answered 200 with one outcome per command in order — `applied` with the row it made, `replayed` with the first outcome for an id already received (nothing written, a body that differs logged and ignored), or `rejected` with the problem, which is recorded in the command's receipt as well. A 400 is for a batch that does not parse (an id twice, more than two hundred, an envelope out of shape): then nothing is applied and nothing recorded. A body that fails its kind's schema is one command's rejection, never the batch's. The fourteen kinds and their bodies: `start-route` (`vehicleId`, `trailerId?`, `appVersion?`, `location?`) opens the session and moves the route `ready → active`; `arrive` (`pickupId`, `location?`, `accuracyM?`) appends an arrival and sets the pickup's first `arrivedAt`; `complete-pickup`, `skip-pickup` and `fail-pickup` (`pickupId`, a `reason` for the last two, `note?`, `location?`) append the proof and move the pickup out of `planned`; `report-problem` (`pickupId?`, `reason`, `note`, `location?`) appends a problem and moves nothing; `add-photo` and `add-signature` (`pickupId` — optional for a photo — and `objectKey`) and `add-weight` (`pickupId`, `weightKg`) and `add-note` (`pickupId?`, `note`) append evidence; `record-unload` (`unloadingStationId`, `wasteFractionId`, `netKg`, `grossKg?`, `tareKg?`, `weighbridgeTicket?`, `objectKey?`, `location?`, `note?`) appends an unload; `pause` and `resume` (`{}`) set and clear the session's `pausedAt`, idempotently; `end-route` (`location?`, `note?`) closes every planned pickup as `skipped · route-ended`, moves the route `active → completed` and ends the session. The rules, judged in this order and each answering its sentence: the route is one of this driver's (404, `No route <id> assigned to this driver`); `occurredAt` is at most five minutes ahead of the request's clock (400, `Recorded after it happened`) and at most forty-eight hours behind it (400, `Recorded more than 48 hours after it happened`); `start-route` wants a `ready` route (409, `Route RC-1042 is not dispatched; a driver starts a ready route` / `… is already active` / `… is completed and does not change`), a driver on no other route (409, `Mads Jensen is already on route RC-1039; end it first`), a powered vehicle of the route's project (400 at `body.vehicleId`, `Not a powered vehicle of this project`) and a trailer where one is named (400 at `body.trailerId`), the licence the vehicle requires on the operating date (400 at `body.vehicleId`, `Freja Holm needs a C licence for WH-24`), and a vehicle and trailer in service (409, `WH-99 is retired; a route needs a vehicle in service`); every later command wants an `active` route with this driver's open session on it (409, `Route RC-1042 is not active`) and an instant at or after the session started (400, `Before the session started`); a command naming a pickup wants one of the route's (404, `No pickup <id> on route RC-1042`), and an outcome wants a `planned` one (409, `Pickup 12 is already completed`: the first outcome stands and a second is a rejection, not a change); `record-unload` wants a station and a fraction of the company (400 at `body.unloadingStationId` / `body.wasteFractionId`); an `objectKey` is `<companyId>/<routeId>/<commandId>.<jpg|jpeg|png|webp>` for this command (400 at `body.objectKey`, `The object key names another route or another command`). A vehicle or trailer not in service is refused naming its status (409, `WH-99 is retired; a route needs a vehicle in service`). Every applied command moves the session's `lastSeenAt` to the request's clock and writes its outbox events; every command's receipt is written with the body verbatim — a rejection for a route the driver does not reach is recorded without a route, in the driver's project, the claimed route id kept beside the body as `{ routeId, body }`. An `end-route` on a route the office cancelled meanwhile is applied as nothing, so the device is not locked out.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One outcome per command, in body order.", DriverCommandBatchOutcome),
          400: describeProblem("The batch does not parse: no commands or more than two hundred, an id named twice, or an envelope out of shape. Nothing was applied or recorded."),
          ...driverProblems("edit"),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("json", DriverCommandBatch),
      async (c) => {
        const { commands } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const profile = await resolveDriver(tx, principal)
        const at = now()
        const applier: Applier = { principal, profile, clock: { now: at.toISOString(), skewAheadMs: OCCURRED_AT_SKEW_MS, backdateMs: COMMAND_BACKDATE_MS }, now: at, log }
        const outcomes: CommandOutcomeRow[] = []
        for (const envelope of commands) outcomes.push(await applyOne(tx, applier, envelope))
        const body: DriverCommandBatchOutcome = { outcomes }
        return c.json(body)
      },
    )
    .get(
      "/driver/commands",
      describeRoute({
        operationId: "listDriverCommands",
        summary: "The driver's receipts",
        description:
          "One page of the receipts of every command this driver's devices ever sent, applied or rejected, oldest first — ids are time-ordered by the device's clock, so a cursor over them is a cursor over the order the commands were minted in — each with the body as it arrived and, on a rejection, the problem it was refused with. A receipt for a route this driver does not reach carries `routeId` null, the claimed id kept in the body as `{ routeId, body }`. `routeId` narrows the page to one route's. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of receipts.", ReceiptPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, or `routeId` is not an id."),
          ...driverProblems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", DriverReceiptListQuery),
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
