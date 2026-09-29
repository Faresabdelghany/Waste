// The driver's commands on the wire (Issue #104, ADR-0004): fourteen kinds,
// one contract each, every one a `z.strictObject` under a common envelope —
// `{ id, kind, routeId, occurredAt, deviceId, body }` — where `id` is minted
// by the device (a UUIDv7 from the device's clock, through
// @waste/domain/ids) and is the command's idempotency key and, where the
// command makes a row, that row's id. `DriverCommand` is the discriminated
// union over the fourteen, so a client that imports this package as the
// Expo app does builds a typed command per kind.
//
// The door, `POST /driver/commands`, takes `DriverCommandBatch`: one to two
// hundred envelopes, each id once (`EACH_COMMAND_ONCE`), applied in body
// order, each in its own savepoint, answering 200 with
// `DriverCommandBatchOutcome` — one `CommandOutcomeRow` per command, in body
// order — whenever the envelope parses, and a 400 only for an envelope that
// does not, with nothing applied and nothing recorded.
// So the batch is parsed loosely first, `DriverCommandEnvelope` with `body:
// z.unknown()`, and each body against its kind's schema afterwards
// (`COMMAND_BODIES`), a body that fails being a rejection recorded like any
// other, with the schema's issues as its `problem`, so a device never blocks
// its queue on a shape mistake. The outcome is `applied`, `replayed` — the
// first outcome answered again for an id already received, stored nowhere —
// or `rejected`, with the row the command made or the problem the applier
// answered. `DriverCommandReceipt` is the stored receipt — its `routeId`
// null on a rejection for a route the driver does not reach, which is
// recorded in the driver's project with the claimed id kept in `body` as
// `{ routeId, body }` — and `DriverMe` the connected client's start screen,
// with the three lists its commands pick from (#144): the active vehicles
// and trailers of the driver profile's project a `start-route` names, and
// the company's stations that are not closed, with what each accepts, and
// its fractions, which a `record-unload` names — narrowed from the rows the
// synced client reads in its `company` bucket (#104 §3), which a browser
// has no bucket for.
// `DriverRouteDetail` is the driver's read of one route (#104 §5): a
// `RouteDetail` whose pickups are `DriverPickup`s, each with its place
// joined — the address and the point of the property or the shared
// collection point it names, the container's label, the waste fraction's
// name — the one read that denormalises for the wire what the device
// otherwise gets by sync.
//
// The rules the bodies hold: a reason is one of the driver's six
// (`DriverPickupReason`; the system's four are the server's), a
// `record-unload`'s weights carry the unload's own rule (unloads.ts), an
// object key has the agreed shape (execution.ts; which ids it names is the
// applier's), and `pause`, `resume` carry nothing at all. What each command
// does when applied is #104 §3's table and the domain's `decide`.
import { COMMAND_OUTCOMES } from "@waste/domain/execution/vocabulary"
import * as z from "zod"

import { WasteFraction } from "./catalogue"
import { IsoDateTime } from "./dates"
import { CommandOutcome, DriverCommandKind, DriverPickupReason, OBJECT_KEY, OBJECT_KEY_SHAPE, ObjectKey } from "./execution"
import { Driver, Vehicle } from "./fleet"
import { FlatPoint } from "./geojson"
import { Id } from "./ids"
import { Pickup } from "./pickups"
import { UnloadingStation } from "./places"
import { Problem } from "./problem"
import { ProofOfService } from "./proofs"
import { eachOnce, eachOnceSentence, PositiveInt, recorded } from "./resource"
import { ActivePlan } from "./plans"
import { labelIsTheNumber, labelMatches, Route, routeFields } from "./routes"
import { Session } from "./sessions"
import { Label, Paragraph } from "./text"
import { bothGrossAndTare, netIsGrossLessTare, Unload, weightsAddUp, weightsPaired } from "./unloads"

export { OBJECT_KEY, OBJECT_KEY_SHAPE, ObjectKey }

/** What every command says about itself: the device's id for it, the route, when, and which installation. */
const envelope = {
  /** Minted by the device: the idempotency key, and the id of the row the command makes. */
  id: Id,
  routeId: Id,
  /** The device's clock. */
  occurredAt: IsoDateTime,
  /** The installation's stable id the app mints once. */
  deviceId: Label,
}

/** Where the device stood when it said so, and how well it knew. */
const located = {
  location: FlatPoint.optional(),
  accuracyM: PositiveInt.optional(),
}

/** One command kind: the envelope with its literal kind and its body. */
const commandOf = <Kind extends DriverCommandKind, Body extends z.ZodType>(kind: Kind, body: Body) => z.strictObject({ ...envelope, kind: z.literal(kind), body })

/** The most a batch carries: PowerSync's upload is one transaction's writes, and two hundred is a long day. */
export const BATCH_MAX = 200

/** The fourteen bodies, by kind, for the route to parse a loosely read envelope's body against. */
export const COMMAND_BODIES = {
  "start-route": z.strictObject({ vehicleId: Id, trailerId: Id.optional(), appVersion: Label.optional(), ...located }),
  arrive: z.strictObject({ pickupId: Id, ...located }),
  "complete-pickup": z.strictObject({ pickupId: Id, note: Paragraph.optional(), ...located }),
  "skip-pickup": z.strictObject({ pickupId: Id, reason: DriverPickupReason, note: Paragraph.optional(), ...located }),
  "fail-pickup": z.strictObject({ pickupId: Id, reason: DriverPickupReason, note: Paragraph.optional(), ...located }),
  "report-problem": z.strictObject({ pickupId: Id.optional(), reason: DriverPickupReason, note: Paragraph, ...located }),
  "add-photo": z.strictObject({ pickupId: Id.optional(), objectKey: ObjectKey, ...located }),
  "add-weight": z.strictObject({ pickupId: Id, weightKg: PositiveInt }),
  "add-signature": z.strictObject({ pickupId: Id, objectKey: ObjectKey, ...located }),
  "add-note": z.strictObject({ pickupId: Id.optional(), note: Paragraph }),
  "record-unload": z
    .strictObject({
      unloadingStationId: Id,
      wasteFractionId: Id,
      netKg: PositiveInt,
      grossKg: PositiveInt.optional(),
      tareKg: PositiveInt.optional(),
      weighbridgeTicket: Label.optional(),
      objectKey: ObjectKey.optional(),
      note: Paragraph.optional(),
      ...located,
    })
    .refine(weightsPaired, bothGrossAndTare)
    .refine(weightsAddUp, netIsGrossLessTare),
  pause: z.strictObject({}),
  resume: z.strictObject({}),
  "end-route": z.strictObject({ note: Paragraph.optional(), ...located }),
} as const satisfies Record<DriverCommandKind, z.ZodType>

export const StartRoute = commandOf("start-route", COMMAND_BODIES["start-route"])
export const Arrive = commandOf("arrive", COMMAND_BODIES.arrive)
export const CompletePickup = commandOf("complete-pickup", COMMAND_BODIES["complete-pickup"])
export const SkipPickup = commandOf("skip-pickup", COMMAND_BODIES["skip-pickup"])
export const FailPickup = commandOf("fail-pickup", COMMAND_BODIES["fail-pickup"])
export const ReportProblem = commandOf("report-problem", COMMAND_BODIES["report-problem"])
export const AddPhoto = commandOf("add-photo", COMMAND_BODIES["add-photo"])
export const AddWeight = commandOf("add-weight", COMMAND_BODIES["add-weight"])
export const AddSignature = commandOf("add-signature", COMMAND_BODIES["add-signature"])
export const AddNote = commandOf("add-note", COMMAND_BODIES["add-note"])
export const RecordUnload = commandOf("record-unload", COMMAND_BODIES["record-unload"])
export const Pause = commandOf("pause", COMMAND_BODIES.pause)
export const Resume = commandOf("resume", COMMAND_BODIES.resume)
export const EndRoute = commandOf("end-route", COMMAND_BODIES["end-route"])

/** One command of any kind: the envelope and the body its kind takes. */
export const DriverCommand = z.discriminatedUnion("kind", [StartRoute, Arrive, CompletePickup, SkipPickup, FailPickup, ReportProblem, AddPhoto, AddWeight, AddSignature, AddNote, RecordUnload, Pause, Resume, EndRoute])
export type DriverCommand = z.infer<typeof DriverCommand>

/** The envelope read loosely, its body unparsed, so a body that fails its kind is one command's rejection and not the batch's 400. */
export const DriverCommandEnvelope = z.strictObject({
  ...envelope,
  kind: DriverCommandKind,
  body: z.unknown(),
})
export type DriverCommandEnvelope = z.infer<typeof DriverCommandEnvelope>

export const EACH_COMMAND_ONCE = eachOnceSentence("command", "one id is one command, and a second with the same id is its replay")

/** `POST /driver/commands`: one to two hundred envelopes, each id once, applied in this order. */
export const DriverCommandBatch = z.strictObject({
  commands: z
    .array(DriverCommandEnvelope)
    .min(1)
    .max(BATCH_MAX)
    .refine((commands) => eachOnce(commands, (command) => command.id), { message: EACH_COMMAND_ONCE }),
})
export type DriverCommandBatch = z.infer<typeof DriverCommandBatch>

/** What the door answers per command: the stored outcomes, and `replayed` for an id already received. */
export const WireOutcome = z.enum([...COMMAND_OUTCOMES, "replayed"])
export type WireOutcome = z.infer<typeof WireOutcome>

/** The row a command made, read back and tagged with what it is — a session for `start-route`, a proof for the evidence and outcome commands, an unload for `record-unload`, the route for `end-route` — so a device never takes a stripped object of one resource for another. */
export const CommandResult = z.discriminatedUnion("resource", [
  z.object({ resource: z.literal("session"), value: Session }),
  z.object({ resource: z.literal("proof"), value: ProofOfService }),
  z.object({ resource: z.literal("unload"), value: Unload }),
  z.object({ resource: z.literal("route"), value: Route }),
])
export type CommandResult = z.infer<typeof CommandResult>

/** One command's outcome in the batch's answer, in body order. */
export const CommandOutcomeRow = z.object({
  commandId: Id,
  outcome: WireOutcome,
  /** The row the command made, when it made one and was applied or replayed. */
  result: CommandResult.optional(),
  /** Why it was rejected, when it was. */
  problem: Problem.optional(),
})
export type CommandOutcomeRow = z.infer<typeof CommandOutcomeRow>

/** What `POST /driver/commands` answers: the outcomes, one per command of the batch in body order — as many as the batch carried, so one to `BATCH_MAX` — and nothing else. */
export const DriverCommandBatchOutcome = z.strictObject({
  outcomes: z.array(CommandOutcomeRow).min(1).max(BATCH_MAX),
})
export type DriverCommandBatchOutcome = z.infer<typeof DriverCommandBatchOutcome>

/** What a receipt with a problem and an applied outcome, or none and a rejected one, is told. */
export const PROBLEM_WITH_A_REJECTION = "A rejected command carries its problem, and an applied one none"
const problemWithARejection = { message: PROBLEM_WITH_A_REJECTION, path: ["problem"] }

/** The receipt: one row per command a device ever sent, applied or rejected, keyed by the device's id for it. */
export const DriverCommandReceipt = z
  .object({
    ...recorded,
    projectId: Id,
    /** The route the command named, where the driver reaches it; null on a rejection for one they do not — another company's, another project's, or none — recorded in the driver's project with the claimed id kept in `body` as `{ routeId, body }`. */
    routeId: Id.nullable(),
    /** What the command named or made; null on a rejected start-route, and on a receipt without a route. */
    sessionId: Id.nullable(),
    pickupId: Id.nullable(),
    driverId: Id,
    deviceId: Label,
    kind: DriverCommandKind,
    /** The device's clock, as sent, even when refused. */
    occurredAt: IsoDateTime,
    /** The command's body as received, verbatim. */
    body: z.json(),
    outcome: CommandOutcome,
    /** The problem the applier answered, exactly when rejected. */
    problem: Problem.nullable(),
  })
  .refine((receipt) => (receipt.outcome === "rejected") === (receipt.problem !== null), problemWithARejection)
export type DriverCommandReceipt = z.infer<typeof DriverCommandReceipt>

/** A vehicle or a trailer a `start-route` names, as the start screen offers it: the `Vehicle`'s id, kind and required licence class, and the one label a person names it by — the callsign where it has one, the plate otherwise. */
export const DriverVehicle = Vehicle.pick({ id: true, kind: true, requiredLicenceClass: true }).extend({ label: Label })
export type DriverVehicle = z.infer<typeof DriverVehicle>

/** A station a `record-unload` names, as the unload screen offers it: the `UnloadingStation`'s id, name, point and weighbridge, and the fractions it accepts, sorted by id — none on record, an empty list. */
export const DriverUnloadingStation = UnloadingStation.pick({ id: true, name: true, location: true, weighbridge: true, wasteFractionIds: true })
export type DriverUnloadingStation = z.infer<typeof DriverUnloadingStation>

/** A waste fraction a `record-unload` names: the `WasteFraction`'s id, key and name. */
export const DriverWasteFraction = WasteFraction.pick({ id: true, key: true, name: true })
export type DriverWasteFraction = z.infer<typeof DriverWasteFraction>

/** `GET /driver/me`: the connected client's start screen, and what its commands pick from. */
export const DriverMe = z.object({
  driver: Driver,
  /** The session the driver is on, or null. */
  openSession: Session.nullable(),
  /** The routes assigned to the driver that are ready or active, or completed today. */
  routes: z.array(Route),
  /** The `active` powered vehicles and trailers of the driver profile's project, by id. */
  vehicles: z.array(DriverVehicle),
  /** The company's stations that are not `closed`, by id. */
  unloadingStations: z.array(DriverUnloadingStation),
  /** The company's, by id. */
  wasteFractions: z.array(DriverWasteFraction),
})
export type DriverMe = z.infer<typeof DriverMe>

/**
 * A pickup as the driver's route read answers it (#104 §5): the `Pickup`
 * with its place joined — the `address` and `location` of the property or
 * the shared collection point the pickup names on the service date, the
 * container's `label` and the waste fraction's `name` — the four things a
 * device shows at a stop, which the synced client joins from its own buckets
 * and the connected client reads here. `location` is null for a property not
 * yet geocoded; a shared collection point always has one.
 */
export const DriverPickup = Pickup.extend({
  /** The service address as one text, the property's or the point's. */
  address: Paragraph,
  location: FlatPoint.nullable(),
  containerLabel: Label,
  wasteFractionName: Label,
})
export type DriverPickup = z.infer<typeof DriverPickup>

/** `GET /driver/routes/:id`: `RouteDetail` with the pickups' places joined — the one read that denormalises for the wire what the device otherwise gets by sync. */
export const DriverRouteDetail = z
  .object({
    ...routeFields,
    /** By `sequence` (#170): the active Plan's order where there is one, each with its place. */
    pickups: z.array(DriverPickup),
    /** The active Plan's reading, or null: the driver door reads only the active Plan of a route assigned to them (#124 §5). */
    activePlan: ActivePlan.nullable(),
    /** The open session, or null. */
    session: Session.nullable(),
    /** Every session, oldest first. */
    sessions: z.array(Session),
    /** Oldest first. */
    unloads: z.array(Unload),
  })
  .refine(labelMatches, labelIsTheNumber)
export type DriverRouteDetail = z.infer<typeof DriverRouteDetail>
