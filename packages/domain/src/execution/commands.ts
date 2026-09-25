// The pure half of the driver command applier (Issue #104, ADR-0004): a
// command, the driver sending it and what the applier read of the rows in,
// a decision out — the effects to run, or the rejection to record. Every rule
// of #104 §3 is judged here, in this order: the route is one of the driver's,
// the clock, the route's status, the session, the pickup, the body. The API
// (`POST /driver/commands`) reads the rows the command names, asks here, runs
// the effects as statements and writes the receipt; the driver app runs the
// same function over its local rows, so the device refuses what the server
// would refuse and the two agree by construction — which is why this module
// knows no row, no request and no clock of its own. The clock bounds are
// arguments: the request's instant, how far ahead of it a device's clock may
// run (five minutes), and how far behind (forty-eight hours: a device that
// was offline for two days is a device whose day is over, and its queue is
// answered as rejections Resolution reads rather than as facts, #104 §7.8).
//
// A rejection is a status and a sentence, with the fields a 400 names: what
// the API stores in the receipt as the contracts' `Problem` and answers in
// the batch's outcomes. A 404 is a route or a pickup that is not there for
// this driver, in the route's own words, so the device learns nothing about
// rows it was not given; a 400 is a body the driver can change — an instant
// out of bounds, a vehicle that is not a powered vehicle of the project, an
// object key naming another route; a 409 is a state the body cannot mend — a
// route not dispatched, a driver already on a route, a pickup already
// decided, a vehicle retired. The sentences are the transitions', the
// licence rule's (resources/licence.ts) and this module's own, spelled once.
//
// An effect is one thing the applier writes, named for what happened and
// carrying what the row needs beyond what the applier already has (the
// route, the session, the driver, the device, the request's clock): a proof
// appended with the command's id, a pickup's outcome, an unload, a session
// opened, paused, resumed or ended, and the outbox event each of those is
// worth. `start-route` opens the session and moves the route in one effect,
// since the two are one fact; `end-route` closes the open pickups, the route
// and the session in one, and the applier emits one `pickup-skipped` per
// pickup it closes from its own `returning`, since only it knows how many
// there were. A `pause` on a paused session and a `resume` on a running one
// decide to apply nothing: idempotent, like `confirm` (#101), and the receipt
// is still written. The applier moves `session.last_seen_at` on every applied
// command whatever the effects say; that is its rule, not an effect.
//
// The body types below are the shapes the contracts' command schemas
// (@waste/contracts/driver-commands) parse to, spelled here without zod
// because this package depends on nothing; a body that failed its schema
// never reaches `decide`, since the route records that rejection itself with
// the schema's issues.
import { licenceRefusal, licenceSentence, type Licence } from "../resources/licence"
import type { LicenceClass, VehicleKind, VehicleStatus } from "../resources/vocabulary"
import { alreadyDecided, notActive, PICKUP_OUTCOME_OF, routeTransition, type PickupCommand, type PickupOutcome } from "./transitions"
import type { DriverCommandKind, DriverPickupReason, OutboxAggregate, OutboxKind, PickupReason, PickupStatus, ProofKind, RouteStatus } from "./vocabulary"

/** A point as the device recorded it: `[longitude, latitude]`. */
export type FlatPoint = { type: "Point"; coordinates: [number, number] }

/** Where the device stood, and how well it knew. */
export type Located = { location?: FlatPoint; accuracyM?: number }

/** The bodies of the fourteen commands, as their contracts parse them. */
export type CommandBodies = {
  "start-route": Located & { vehicleId: string; trailerId?: string; appVersion?: string }
  arrive: Located & { pickupId: string }
  "complete-pickup": Located & { pickupId: string; note?: string }
  "skip-pickup": Located & { pickupId: string; reason: DriverPickupReason; note?: string }
  "fail-pickup": Located & { pickupId: string; reason: DriverPickupReason; note?: string }
  "report-problem": Located & { pickupId?: string; reason: DriverPickupReason; note: string }
  "add-photo": Located & { pickupId?: string; objectKey: string }
  "add-weight": { pickupId: string; weightKg: number }
  "add-signature": Located & { pickupId: string; objectKey: string }
  "add-note": { pickupId?: string; note: string }
  "record-unload": Located & { unloadingStationId: string; wasteFractionId: string; netKg: number; grossKg?: number; tareKg?: number; weighbridgeTicket?: string; objectKey?: string; note?: string }
  pause: Record<string, never>
  resume: Record<string, never>
  "end-route": Located & { note?: string }
}

/** One command as the device sent it: the envelope and the body its kind parsed. */
export type Command<Kind extends DriverCommandKind = DriverCommandKind> = {
  [K in Kind]: {
    /** Minted by the device: the idempotency key, and the id of the row the command makes. */
    id: string
    kind: K
    routeId: string
    /** The device's clock, RFC 3339. */
    occurredAt: string
    deviceId: string
    body: CommandBodies[K]
  }
}[Kind]

/** The driver sending the batch: the profile the principal's login resolved to, with the licence the start rule reads. */
export type CommandDriver = Licence & { id: string; name: string }

/** The route as the applier read it under the driver's assignment. */
export type RouteState = {
  id: string
  /** `RC-1042`, for the sentences. */
  label: string
  status: RouteStatus
  plannedDriverId: string | null
  actualDriverId: string | null
  /** The day the route runs, `YYYY-MM-DD`: the day the licence is judged on. */
  operatingDate: string
}

/** The open session on the route, as read. */
export type SessionState = { id: string; driverId: string; startedAt: string; endedAt: string | null; pausedAt: string | null }

/** The pickup the body names, as read on the route. */
export type PickupState = { id: string; position: number; status: PickupStatus; arrivedAt: string | null }

/** A vehicle or a trailer the body names, as read in the route's project. */
export type VehicleState = { id: string; label: string; kind: VehicleKind; status: VehicleStatus; requiredLicenceClass: LicenceClass }

/**
 * What the applier read for this command, each lookup bounded the way the
 * door bounds it: the route by the driver's assignment (`planned_driver_id`
 * or `actual_driver_id`), the session and the pickup by the route, the
 * vehicle and the trailer by the route's project, the station and the
 * fraction by the company. `undefined` is a row that is not there within
 * those bounds, which the rules answer in the route's own words.
 */
export type Lookups = {
  companyId: string
  route: RouteState | undefined
  /** The open session on the route, whoever's. */
  session: SessionState | undefined
  /** The label of the route the driver has an open session on, any route; undefined when none. */
  driverOpenOn: string | undefined
  /** The pickup the body names, on this route. */
  pickup: PickupState | undefined
  /** The vehicle a `start-route` names, of the route's project. */
  vehicle: VehicleState | undefined
  /** The trailer a `start-route` names, of the route's project. */
  trailer: VehicleState | undefined
  /** Whether the station a `record-unload` names is the company's. */
  stationKnown: boolean
  /** Whether the fraction a `record-unload` names is the company's. */
  fractionKnown: boolean
}

/** The request's clock and the two bounds a device's clock is held within. */
export type Clock = {
  /** The request's instant, RFC 3339. */
  now: string
  /** How far ahead of the request `occurredAt` may run: a device's clock being a device's. */
  skewAheadMs: number
  /** How far behind: a queue older than this is answered as rejections, not facts. */
  backdateMs: number
}

/** One field a 400 names, in the command: `occurredAt`, `body.vehicleId`. */
export type FieldError = { path: string; message: string }

/** Why a command was refused: the status the problem carries, its sentence, and the fields where a 400 says which. */
export type Rejection = { status: 400 | 404 | 409; detail: string; errors?: FieldError[] }

/** A proof to append, with the command's id: what the applier adds is the route, the session, the source, who recorded it and the device. */
export type ProofDraft = {
  id: string
  kind: ProofKind
  pickupId: string | null
  occurredAt: string
  reason: PickupReason | null
  note: string | null
  weightKg: number | null
  objectKey: string | null
  location: FlatPoint | null
  locationAccuracyM: number | null
}

/** An unload to append, with the command's id. */
export type UnloadDraft = {
  id: string
  unloadingStationId: string
  wasteFractionId: string
  occurredAt: string
  netKg: number
  grossKg: number | null
  tareKg: number | null
  weighbridgeTicket: string | null
  objectKey: string | null
  note: string | null
  location: FlatPoint | null
}

/** One thing the applier writes. */
export type Effect =
  /** The route `ready → active` at the instant, its actual assignment copied from the session opened with the command's id. */
  | { kind: "start-route"; sessionId: string; vehicleId: string; trailerId: string | null; appVersion: string | null; at: string }
  | { kind: "append-proof"; proof: ProofDraft }
  /** The pickup's first arrival: `arrived_at` set. A second arrival appends its proof and moves nothing, so it decides no such effect. */
  | { kind: "arrive"; pickupId: string; at: string }
  /** The pickup leaves `planned`: the status, the reason where the outcome takes one, `outcome_at`. */
  | { kind: "pickup-outcome"; pickupId: string; status: PickupOutcome; reason: PickupReason | null; at: string }
  | { kind: "append-unload"; unload: UnloadDraft }
  | { kind: "pause"; at: string }
  | { kind: "resume" }
  /** Every planned pickup `→ skipped · route-ended` at the instant, the route `active → completed`, the session ended; the applier emits one `pickup-skipped` per pickup it closed. */
  | { kind: "end-route"; at: string }
  /** An outbox event to write after the rows it describes, its payload the resource the route would answer. */
  | { kind: "event"; event: OutboxKind; aggregate: OutboxAggregate; aggregateId: string }

export type Decision = { apply: Effect[] } | { reject: Rejection }

// The sentences of this module.

/** A route the driver is not assigned to, or that is not there: one sentence, so the device learns nothing about rows it was not given. */
export const noRouteAssigned = (routeId: string): string => `No route ${routeId} assigned to this driver`
/** A pickup that is not on the route. */
export const noPickupOnRoute = (pickupId: string, label: string): string => `No pickup ${pickupId} on route ${label}`
/** `occurredAt` further ahead of the request's clock than a device's clock accounts for. */
export const RECORDED_AFTER_IT_HAPPENED = "Recorded after it happened"
/** `occurredAt` further behind the request's clock than the backdate bound: the day is over. */
export const recordedTooLate = (backdateMs: number): string => `Recorded more than ${Math.round(backdateMs / 3_600_000)} hours after it happened`
/** A command after `start-route` whose instant precedes the session it belongs to. */
export const BEFORE_THE_SESSION_STARTED = "Before the session started"
/** A driver starting a second route. */
export const alreadyOnRoute = (driver: string, label: string): string => `${driver} is already on route ${label}; end it first`
/** A `start-route` naming a vehicle that is not a powered vehicle of the project. */
export const NOT_A_POWERED_VEHICLE = "Not a powered vehicle of this project"
/** A `start-route` naming a trailer that is not a trailer of the project. */
export const NOT_A_TRAILER = "Not a trailer of this project"
/** A `start-route` naming a retired vehicle or trailer: the fleet's status gate in the route's words. */
export const isRetired = (label: string, as: "vehicle" | "trailer"): string => `${label} is retired; a route needs a ${as} in service`
/** A `record-unload` naming a station that is not the company's. */
export const NOT_A_STATION = "Not an unloading station of this company"
/** A `record-unload` naming a fraction that is not the company's. */
export const NOT_A_FRACTION = "Not a waste fraction of this company"
/** An `objectKey` outside the command's own prefix. */
export const OBJECT_KEY_NAMES_ANOTHER = "The object key names another route or another command"
/** What the licence sentence's last clause says the judged day was. */
export const THE_OPERATING_DATE = "the operating date"

// The object key rule: a photo or a signature is a Storage object under
// `<companyId>/<routeId>/<commandId>.<ext>`, agreed before the upload, and
// the API holds the key to the row's own ids so a device cannot name another
// tenant's object (#104 §3).

/** The image formats a proof's object may be. */
export const OBJECT_EXTENSIONS = ["jpg", "jpeg", "png", "webp"] as const
export type ObjectExtension = (typeof OBJECT_EXTENSIONS)[number]

/** The key a command's object is agreed to live under. */
export const objectKeyOf = (ids: { companyId: string; routeId: string; commandId: string }, extension: ObjectExtension): string => `${ids.companyId}/${ids.routeId}/${ids.commandId}.${extension}`

/** Whether the key is one of this command's: its company, its route, its id, one of the formats. */
export function objectKeyNames(key: string, ids: { companyId: string; routeId: string; commandId: string }): boolean {
  const prefix = `${ids.companyId}/${ids.routeId}/${ids.commandId}.`
  return key.startsWith(prefix) && (OBJECT_EXTENSIONS as readonly string[]).includes(key.slice(prefix.length))
}

const reject = (status: Rejection["status"], detail: string, errors?: FieldError[]): Decision => ({ reject: errors ? { status, detail, errors } : { status, detail } })
const invalid = (path: string, message: string): Decision => reject(400, message, [{ path, message }])

/** The kinds that decide a pickup's outcome, by command. */
const OUTCOME_COMMANDS: Readonly<Partial<Record<DriverCommandKind, PickupCommand>>> = { "complete-pickup": "complete", "skip-pickup": "skip", "fail-pickup": "fail" }
/** The proof each outcome command appends. */
const OUTCOME_PROOFS: Readonly<Record<PickupCommand, ProofKind>> = { complete: "completion", skip: "skip", fail: "failure" }
/** The event each outcome is worth. */
const OUTCOME_EVENTS: Readonly<Record<PickupOutcome, OutboxKind>> = { completed: "pickup-completed", skipped: "pickup-skipped", failed: "pickup-failed" }

/** A proof draft of the kind, with the command's id and instant, the columns the body did not give null. */
function proof(command: Command, kind: ProofKind, fields: Partial<Omit<ProofDraft, "id" | "kind" | "occurredAt">> & Located): ProofDraft {
  return {
    id: command.id,
    kind,
    occurredAt: command.occurredAt,
    pickupId: fields.pickupId ?? null,
    reason: fields.reason ?? null,
    note: fields.note ?? null,
    weightKg: fields.weightKg ?? null,
    objectKey: fields.objectKey ?? null,
    location: fields.location ?? null,
    locationAccuracyM: fields.accuracyM ?? null,
  }
}

const event = (kind: OutboxKind, aggregate: OutboxAggregate, aggregateId: string): Effect => ({ kind: "event", event: kind, aggregate, aggregateId })

/**
 * The decision: the effects to run, or the rejection to record. Judged in
 * §3's order — the route is the driver's, the clock, the route's status, the
 * session, the pickup, the body — each rule answering its own sentence.
 */
export function decide(command: Command, driver: CommandDriver, state: Lookups, clock: Clock): Decision {
  const { route } = state
  if (route === undefined || (route.plannedDriverId !== driver.id && route.actualDriverId !== driver.id)) {
    return reject(404, noRouteAssigned(command.routeId))
  }
  const occurred = Date.parse(command.occurredAt)
  const now = Date.parse(clock.now)
  if (occurred > now + clock.skewAheadMs) return invalid("occurredAt", RECORDED_AFTER_IT_HAPPENED)
  if (occurred < now - clock.backdateMs) return invalid("occurredAt", recordedTooLate(clock.backdateMs))

  if (command.kind === "start-route") return decideStart(command, driver, route, state)

  if (route.status !== "active") return reject(409, notActive(route.label))
  const { session } = state
  if (session === undefined || session.endedAt !== null || session.driverId !== driver.id) return reject(409, notActive(route.label))
  if (occurred < Date.parse(session.startedAt)) return invalid("occurredAt", BEFORE_THE_SESSION_STARTED)

  const named = "pickupId" in command.body ? command.body.pickupId : undefined
  const pickup = named === undefined ? undefined : state.pickup
  if (named !== undefined && (pickup === undefined || pickup.id !== named)) return reject(404, noPickupOnRoute(named, route.label))

  const outcomeCommand = OUTCOME_COMMANDS[command.kind]
  if (outcomeCommand !== undefined && pickup !== undefined) {
    if (pickup.status !== "planned") return reject(409, alreadyDecided(pickup.position, pickup.status))
    const body = command.body as CommandBodies["complete-pickup"] & { reason?: DriverPickupReason }
    const status = PICKUP_OUTCOME_OF[outcomeCommand]
    const reason = body.reason ?? null
    return {
      apply: [
        { kind: "append-proof", proof: proof(command, OUTCOME_PROOFS[outcomeCommand], { pickupId: pickup.id, reason, note: body.note, location: body.location, accuracyM: body.accuracyM }) },
        { kind: "pickup-outcome", pickupId: pickup.id, status, reason, at: command.occurredAt },
        event(OUTCOME_EVENTS[status], "pickup", pickup.id),
      ],
    }
  }

  switch (command.kind) {
    case "arrive": {
      // The body names a pickup, so the check above found it; the guard keeps the type honest.
      if (pickup === undefined) return reject(404, noPickupOnRoute(command.body.pickupId, route.label))
      const effects: Effect[] = [{ kind: "append-proof", proof: proof(command, "arrival", { pickupId: pickup.id, location: command.body.location, accuracyM: command.body.accuracyM }) }]
      if (pickup.arrivedAt === null) effects.push({ kind: "arrive", pickupId: pickup.id, at: command.occurredAt })
      return { apply: effects }
    }
    case "report-problem":
      return {
        apply: [
          { kind: "append-proof", proof: proof(command, "problem", { pickupId: pickup?.id, reason: command.body.reason, note: command.body.note, location: command.body.location, accuracyM: command.body.accuracyM }) },
          pickup === undefined ? event("pickup-problem-reported", "route", route.id) : event("pickup-problem-reported", "pickup", pickup.id),
        ],
      }
    case "add-photo":
    case "add-signature": {
      if (!objectKeyNames(command.body.objectKey, { companyId: state.companyId, routeId: route.id, commandId: command.id })) return invalid("body.objectKey", OBJECT_KEY_NAMES_ANOTHER)
      const kind: ProofKind = command.kind === "add-photo" ? "photo" : "signature"
      return { apply: [{ kind: "append-proof", proof: proof(command, kind, { pickupId: pickup?.id, objectKey: command.body.objectKey, location: command.body.location, accuracyM: command.body.accuracyM }) }] }
    }
    case "add-weight":
      return { apply: [{ kind: "append-proof", proof: proof(command, "weight", { pickupId: pickup?.id, weightKg: command.body.weightKg }) }] }
    case "add-note":
      return { apply: [{ kind: "append-proof", proof: proof(command, "note", { pickupId: pickup?.id, note: command.body.note }) }] }
    case "record-unload": {
      const { body } = command
      if (!state.stationKnown) return invalid("body.unloadingStationId", NOT_A_STATION)
      if (!state.fractionKnown) return invalid("body.wasteFractionId", NOT_A_FRACTION)
      if (body.objectKey !== undefined && !objectKeyNames(body.objectKey, { companyId: state.companyId, routeId: route.id, commandId: command.id })) return invalid("body.objectKey", OBJECT_KEY_NAMES_ANOTHER)
      const unload: UnloadDraft = {
        id: command.id,
        unloadingStationId: body.unloadingStationId,
        wasteFractionId: body.wasteFractionId,
        occurredAt: command.occurredAt,
        netKg: body.netKg,
        grossKg: body.grossKg ?? null,
        tareKg: body.tareKg ?? null,
        weighbridgeTicket: body.weighbridgeTicket ?? null,
        objectKey: body.objectKey ?? null,
        note: body.note ?? null,
        location: body.location ?? null,
      }
      return { apply: [{ kind: "append-unload", unload }, event("unload-recorded", "unload", command.id)] }
    }
    case "pause":
      return { apply: session.pausedAt === null ? [{ kind: "pause", at: command.occurredAt }] : [] }
    case "resume":
      return { apply: session.pausedAt === null ? [] : [{ kind: "resume" }] }
    case "end-route":
      return { apply: [{ kind: "end-route", at: command.occurredAt }, event("route-completed", "route", route.id)] }
    default:
      return reject(409, notActive(route.label))
  }
}

/** `start-route`: the route is ready, the driver is on no other route, the vehicle and the trailer are the project's and in service, the driver holds the class the vehicle requires on the operating date. */
function decideStart(command: Command<"start-route">, driver: CommandDriver, route: RouteState, state: Lookups): Decision {
  const transition = routeTransition(route.status, "start", route.label)
  if (transition.kind !== "move") return reject(409, transition.kind === "refuse" ? transition.sentence : notActive(route.label))
  if (state.driverOpenOn !== undefined) return reject(409, alreadyOnRoute(driver.name, state.driverOpenOn))
  const { vehicle, trailer } = state
  const { body } = command
  if (vehicle === undefined || vehicle.id !== body.vehicleId || vehicle.kind !== "powered-vehicle") return invalid("body.vehicleId", NOT_A_POWERED_VEHICLE)
  if (body.trailerId !== undefined && (trailer === undefined || trailer.id !== body.trailerId || trailer.kind !== "trailer")) return invalid("body.trailerId", NOT_A_TRAILER)
  const refusal = licenceRefusal(driver, vehicle.requiredLicenceClass, route.operatingDate)
  if (refusal !== undefined) return invalid("body.vehicleId", licenceSentence(refusal, { driver: driver.name, vehicle: vehicle.label }, THE_OPERATING_DATE))
  if (vehicle.status === "retired") return reject(409, isRetired(vehicle.label, "vehicle"))
  if (trailer !== undefined && body.trailerId !== undefined && trailer.status === "retired") return reject(409, isRetired(trailer.label, "trailer"))
  return {
    apply: [
      { kind: "start-route", sessionId: command.id, vehicleId: vehicle.id, trailerId: body.trailerId ?? null, appVersion: body.appVersion ?? null, at: command.occurredAt },
      event("route-started", "route", route.id),
    ],
  }
}
