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
import * as z from "zod"

import { IsoDateTime } from "./dates"
import { ExecutionSource, ObjectKey } from "./execution"
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
  })
  .refine(weightsPaired, bothGrossAndTare)
  .refine(weightsAddUp, netIsGrossLessTare)
export type UnloadCreate = z.infer<typeof UnloadCreate>

/** A page of unloads: one project's, one route's, at one station, of one fraction, over a window of `occurredAt`, oldest first. */
export const UnloadListQuery = ProjectScopedListQuery.extend({
  routeId: Id.optional(),
  unloadingStationId: Id.optional(),
  wasteFractionId: Id.optional(),
  /** The first instant of the window over `occurredAt`, inclusive. */
  from: IsoDateTime.optional(),
  /** The last instant, inclusive. */
  to: IsoDateTime.optional(),
}).refine((query) => query.from === undefined || query.to === undefined || Date.parse(query.to) >= Date.parse(query.from), { message: OCCURRED_WINDOW_ORDERED, path: ["to"] })
export type UnloadListQuery = z.infer<typeof UnloadListQuery>
