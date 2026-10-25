// The Unload on the wire (Issue #104): the glossary's event on a dated Route
// at an Unloading Station, with weight evidence — neither a Pickup nor a
// stop's proof. A ledger row, spreading `recorded`: a wrong unload is
// corrected by Finance with a new row (step 7), never updated here.
//
// The weights are whole kilograms (#104 §7.15) and hold the prototype's own
// sentence, which the database spells as `unload_weights_shape`: `netKg` is
// given, gross and tare come together or not at all
// (`BOTH_GROSS_AND_TARE`, at `tareKg`), and where both are given net is gross
// less tare (`NET_IS_GROSS_LESS_TARE`, at `netKg`). The office's capture
// (`UnloadCreate`, `POST /routes/:id/unloads`) says the station, the fraction,
// the weights, the station's ticket, when and a note; the source, the
// recorder and the id are the server's, and a device records an unload
// through its `record-unload` command instead (driver-commands.ts), whose
// body carries the same rule.
//
// Weight control (Issue #112) reads beside every Unload: `weightReview` is
// the reading of the review ledger over the row — the latest decision or
// `captured`, the latest review's id and the new Unload a correction wrote
// (`WeightReviewState`, finance.ts, since weight-control.ts imports the
// weights rule from here and could not be imported back) — never null,
// since every unload has a reading, and never written: the three review
// commands append rows the reading folds. The list takes `reviewStatus`,
// the prototype's Weight Control queue ("Needs review" is `captured`).
//
// The weighbridge in the office (O9 of #290): a load the station refused
// carries its `refusal` — a reason from the domain's list, and a note,
// which `other` needs — set at capture by either door, since the row is a
// ledger's; and every unload reads its `load`, what the stops of its fraction
// weighed on board since the route's last unload of it against the
// weighbridge's net, within the project's tolerance or above it, null where no
// stop was weighed.
import { refusalIssue, SAY_WHY_REFUSED } from "@waste/domain/execution/unloads"
import { UNLOAD_REFUSAL_REASONS } from "@waste/domain/execution/vocabulary"
import * as z from "zod"

import { IsoDateTime } from "./dates"
import { ExecutionSource, ObjectKey } from "./execution"
import { WeightReviewState, WeightReviewStatus } from "./finance"
import { FlatPoint } from "./geojson"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { PositiveInt, recorded } from "./resource"
import { OCCURRED_WINDOW_ORDERED } from "./stock"
import { Label, Paragraph } from "./text"

/** What a body giving one of gross and tare without the other is told, at the tare. */
export const BOTH_GROSS_AND_TARE = "Give grossKg and tareKg together or neither"
export const bothGrossAndTare = { message: BOTH_GROSS_AND_TARE, path: ["tareKg"] }

/** What a body whose net is not gross less tare is told, at the net. */
export const NET_IS_GROSS_LESS_TARE = "netKg is grossKg less tareKg where both are given"
export const netIsGrossLessTare = { message: NET_IS_GROSS_LESS_TARE, path: ["netKg"] }

/** Why the station refused a load (O9 of #290). */
export const UnloadRefusalReason = z.enum(UNLOAD_REFUSAL_REASONS)
export type UnloadRefusalReason = z.infer<typeof UnloadRefusalReason>

/** What a refusal for another reason is told without its words, at the note: `refusalIssue`'s sentence. */
export { SAY_WHY_REFUSED }

/** A refusal as a body gives it: the reason, and the note, which `other` needs. */
export const UnloadRefusal = z
  .strictObject({ reason: UnloadRefusalReason, note: Paragraph.optional() })
  .refine((refusal) => refusalIssue({ reason: refusal.reason, note: refusal.note ?? null }) === undefined, { message: SAY_WHY_REFUSED, path: ["note"] })
export type UnloadRefusal = z.infer<typeof UnloadRefusal>

/** What the stops weighed on board against the weighbridge's net: the difference in percent of the on-board load, to one decimal, and whether it is within the project's tolerance. */
export const LoadReading = z.object({
  onBoardKg: PositiveInt,
  deviationPercent: z.number(),
  withinTolerance: z.boolean(),
})
export type LoadReading = z.infer<typeof LoadReading>

/** The weights as any body or row carries them: net always, gross and tare together or not at all. */
export type Weights = { netKg: number; grossKg?: number | null; tareKg?: number | null }

/** Gross and tare come together or not at all. */
export const weightsPaired = (weights: Weights): boolean => (weights.grossKg == null) === (weights.tareKg == null)

/** Where both are given, net is gross less tare; a half-given pair is judged by `weightsPaired` and not here. */
export const weightsAddUp = (weights: Weights): boolean => weights.grossKg == null || weights.tareKg == null || weights.netKg === weights.grossKg - weights.tareKg

/** The two rules together, for a body or a row. */
export const unloadWeights = (weights: Weights): boolean => weightsPaired(weights) && weightsAddUp(weights)

export const Unload = z
  .object({
    ...recorded,
    projectId: Id,
    routeId: Id,
    /** The session, on every driver-recorded row and on no office row. */
    sessionId: Id.nullable(),
    /** Any station of the company; the route's planned one is a default the device offers, not a rule. */
    unloadingStationId: Id,
    /** What was tipped; a multi-compartment vehicle records one row per fraction. */
    wasteFractionId: Id,
    source: ExecutionSource,
    occurredAt: IsoDateTime,
    recordedBy: Id,
    deviceId: Label.nullable(),
    location: FlatPoint.nullable(),
    grossKg: PositiveInt.nullable(),
    tareKg: PositiveInt.nullable(),
    netKg: PositiveInt,
    /** The station's reference, `WB-2026-3901`. */
    weighbridgeTicket: Label.nullable(),
    /** A photo of the ticket. */
    objectKey: ObjectKey.nullable(),
    note: Paragraph.nullable(),
    /** Weight control's reading over the row: the latest review's decision, or `captured` where nobody has looked (Issue #112). */
    weightReview: WeightReviewState,
    /** The station's refusal of the load (O9 of #290), null for one it took; absent from a row the outbox carried before, read as none. */
    refusal: z.object({ reason: UnloadRefusalReason, note: Paragraph.nullable() }).nullable().default(null),
    /** The load on board against the weighbridge, null where no stop of its fraction was weighed; absent from a row the outbox carried before, read as none. */
    load: LoadReading.nullable().default(null),
  })
  .refine(weightsPaired, bothGrossAndTare)
  .refine(weightsAddUp, netIsGrossLessTare)
export type Unload = z.infer<typeof Unload>

/** `POST /routes/:id/unloads`: the office's capture of a weighbridge ticket; the source is dispatch, the recorder the caller, the id the server's. */
export const UnloadCreate = z
  .strictObject({
    unloadingStationId: Id,
    wasteFractionId: Id,
    netKg: PositiveInt,
    grossKg: PositiveInt.optional(),
    tareKg: PositiveInt.optional(),
    weighbridgeTicket: Label.optional(),
    /** When the truck tipped, under the skew rule. */
    occurredAt: IsoDateTime,
    note: Paragraph.optional(),
    /** The station refused the load (O9 of #290): an accepted unload's fraction is one the station takes, a refused one's any. */
    refusal: UnloadRefusal.optional(),
  })
  .refine(weightsPaired, bothGrossAndTare)
  .refine(weightsAddUp, netIsGrossLessTare)
export type UnloadCreate = z.infer<typeof UnloadCreate>

/** A page of unloads: one project's, one route's, at one station, of one fraction, of one review status, over a window of `occurredAt`, oldest first. */
export const UnloadListQuery = ProjectScopedListQuery.extend({
  routeId: Id.optional(),
  unloadingStationId: Id.optional(),
  wasteFractionId: Id.optional(),
  /** The reading to page by: `captured` is the weights desk's queue. */
  reviewStatus: WeightReviewStatus.optional(),
  /** The first instant of the window over `occurredAt`, inclusive. */
  from: IsoDateTime.optional(),
  /** The last instant, inclusive. */
  to: IsoDateTime.optional(),
}).refine((query) => query.from === undefined || query.to === undefined || Date.parse(query.to) >= Date.parse(query.from), { message: OCCURRED_WINDOW_ORDERED, path: ["to"] })
export type UnloadListQuery = z.infer<typeof UnloadListQuery>
