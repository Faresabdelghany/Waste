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
// order, each in its own savepoint, answering 200 with one
// `CommandOutcomeRow` per command whenever the envelope parses — a 400 only
// for an envelope that does not, with nothing applied and nothing recorded.
// So the batch is parsed loosely first, `DriverCommandEnvelope` with `body:
// z.unknown()`, and each body against its kind's schema afterwards
// (`COMMAND_BODIES`), a body that fails being a rejection recorded like any
// other, with the schema's issues as its `problem`, so a device never blocks
// its queue on a shape mistake. The outcome is `applied`, `replayed` — the
// first outcome answered again for an id already received, stored nowhere —
// or `rejected`, with the row the command made or the problem the applier
// answered. `DriverCommandReceipt` is the stored receipt, `DriverMe` the
// connected client's start screen.
//
// The rules the bodies hold: a reason is one of the driver's six
// (`DriverPickupReason`; the system's four are the server's), a
// `record-unload`'s weights carry the unload's own rule (unloads.ts), an
// object key has the agreed shape (execution.ts; which ids it names is the
// applier's), and `pause`, `resume` carry nothing at all. What each command
// does when applied is #104 §3's table and the domain's `decide`.
import { COMMAND_OUTCOMES } from "@waste/domain/execution/vocabulary"
import * as z from "zod"

import { IsoDateTime } from "./dates"
import { CommandOutcome, DriverCommandKind, DriverPickupReason, OBJECT_KEY, OBJECT_KEY_SHAPE, ObjectKey } from "./execution"
import { Driver } from "./fleet"
import { FlatPoint } from "./geojson"
import { Id } from "./ids"
import { Problem } from "./problem"
import { ProofOfService } from "./proofs"
import { eachOnce, eachOnceSentence, PositiveInt, recorded } from "./resource"
import { Route } from "./routes"
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

/** The row a command made, read back: a session for `start-route`, a proof for the evidence and outcome commands, an unload for `record-unload`, the route for `end-route`. */
export const CommandResult = z.union([Session, ProofOfService, Unload, Route])
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

/** What a receipt with a problem and an applied outcome, or none and a rejected one, is told. */
export const PROBLEM_WITH_A_REJECTION = "A rejected command carries its problem, and an applied one none"
const problemWithARejection = { message: PROBLEM_WITH_A_REJECTION, path: ["problem"] }

/** The receipt: one row per command a device ever sent, applied or rejected, keyed by the device's id for it. */
export const DriverCommandReceipt = z
  .object({
    ...recorded,
    projectId: Id,
    routeId: Id,
    /** What the command named or made; null on a rejected start-route. */
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

/** `GET /driver/me`: the connected client's start screen. */
export const DriverMe = z.object({
  driver: Driver,
  /** The session the driver is on, or null. */
  openSession: Session.nullable(),
  /** The routes assigned to the driver that are ready or active, or completed today. */
  routes: z.array(Route),
})
export type DriverMe = z.infer<typeof DriverMe>
