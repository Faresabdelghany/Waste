// A transfer station's haul-out on the wire (M17 of #293, row 28.3): the
// Outbound Load that takes material from a Transfer Station on to the site
// that treats or disposes of it, a station's stock by project and fraction,
// and the office's adjustments of it after a count.
//
// An Outbound Load is a project's, and leaves a transfer station of the
// company for another of its stations, usually an external plant. Its carrier
// is a plate always: our vehicle's, read off the vehicle where the body names
// one (`vehicleId`), or a hauler's, given with the plate. Its out-weighing
// holds an Unload's rule: net always, gross and tare together or not at all,
// net gross less tare where both are given. Its costs are integer minor units
// in the project's currency, recorded and never billed or settled.
//
// The receiving site's ticket arrives by `POST /outbound-loads/:id/receive`
// and reads as `receipt`: the site's number, its net and when it weighed,
// with the difference from our out-weighing in kilograms and in percent of
// ours, and whether that is within the project's weight tolerance. Then the
// office reconciles the load, or disputes it saying why; a load that has not
// been received may be cancelled, saying why. The status machine is the
// domain's (@waste/domain/execution/haul-out).
//
// A station's stock (`GET /unloading-stations/:id/stock`) is a reading, one
// row per project and fraction: what our Unloads tipped there by their weight
// review, approved or not yet reviewed (`inKg`); what of that a review rejected,
// beside and in no total (`rejectedKg`); what left on loads not cancelled
// (`outKg`); the adjustments (`adjustedKg`); and what that leaves on hand,
// which may read below zero. An adjustment is a ledger row: signed whole
// kilograms, never zero, with the count's words.
import { SAME_STATION } from "@waste/domain/execution/haul-out"
import { OUTBOUND_LOAD_STATUSES } from "@waste/domain/execution/vocabulary"
import * as z from "zod"

import { IsoDateTime } from "./dates"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { changesSomething, Int4, NonNegativeInt, PositiveInt, recorded, somethingToChange, stamped } from "./resource"
import { Label, Paragraph } from "./text"
import { bothGrossAndTare, netIsGrossLessTare, weightsAddUp, weightsPaired } from "./unloads"

export const OutboundLoadStatus = z.enum(OUTBOUND_LOAD_STATUSES)
export type OutboundLoadStatus = z.infer<typeof OutboundLoadStatus>

/** What a load sent back to the station it left from is told, at the receiving station. */
export const stationsApart = { message: SAME_STATION, path: ["toStationId"] }
/** What a load with neither our vehicle nor a plate is told, at the plate. */
export const NAME_THE_CARRIER = "Name our vehicle or give the plate"

/** The receiving site's ticket, read against our out-weighing. */
export const OutboundLoadReceipt = z.object({
  /** The receiving site's own ticket number. */
  ticket: Label,
  netKg: PositiveInt,
  receivedAt: IsoDateTime,
  /** The site's net less ours, in whole kilograms. */
  differenceKg: z.int(),
  /** The difference in percent of ours, to one decimal. */
  deviationPercent: z.number(),
  /** Whether the difference is within the project's weight tolerance. */
  withinTolerance: z.boolean(),
})
export type OutboundLoadReceipt = z.infer<typeof OutboundLoadReceipt>

export const OutboundLoad = z
  .object({
    ...stamped,
    projectId: Id,
    /** The transfer station the load left. */
    fromStationId: Id,
    /** The site that takes it. */
    toStationId: Id,
    wasteFractionId: Id,
    /** Our vehicle, where it is one. */
    vehicleId: Id.nullable(),
    /** The hauler, where a Service Provider carries it. */
    serviceProviderId: Id.nullable(),
    vehicleRegistration: Label,
    departedAt: IsoDateTime,
    grossKg: PositiveInt.nullable(),
    tareKg: PositiveInt.nullable(),
    netKg: PositiveInt,
    /** Our weighbridge's reference for the out-weighing. */
    outboundTicket: Label.nullable(),
    /** The receiving site's ticket; null until the load is received. Written through the receive command. */
    receipt: OutboundLoadReceipt.nullable(),
    /** In the project's currency, integer minor units. */
    haulCostMinor: NonNegativeInt.nullable(),
    disposalCostMinor: NonNegativeInt.nullable(),
    status: OutboundLoadStatus,
    /** Why it is disputed or cancelled; a note on any other. */
    note: Paragraph.nullable(),
  })
  .refine(weightsPaired, bothGrossAndTare)
  .refine(weightsAddUp, netIsGrossLessTare)
export type OutboundLoad = z.infer<typeof OutboundLoad>

/** `POST /outbound-loads`: the load departs; the status and the receipt are the server's. */
export const OutboundLoadCreate = z
  .strictObject({
    projectId: Id,
    fromStationId: Id,
    toStationId: Id,
    wasteFractionId: Id,
    vehicleId: Id.optional().describe("Our vehicle of the project; its plate is the load's unless the body gives one."),
    serviceProviderId: Id.optional(),
    vehicleRegistration: Label.optional().describe("Required unless the body names our vehicle."),
    departedAt: IsoDateTime,
    netKg: PositiveInt,
    grossKg: PositiveInt.optional(),
    tareKg: PositiveInt.optional(),
    outboundTicket: Label.optional(),
    haulCostMinor: NonNegativeInt.optional(),
    disposalCostMinor: NonNegativeInt.optional(),
    note: Paragraph.optional(),
  })
  .refine((body) => body.fromStationId !== body.toStationId, stationsApart)
  .refine((body) => body.vehicleId !== undefined || body.vehicleRegistration !== undefined, { message: NAME_THE_CARRIER, path: ["vehicleRegistration"] })
  .refine(weightsPaired, bothGrossAndTare)
  .refine(weightsAddUp, netIsGrossLessTare)
export type OutboundLoadCreate = z.infer<typeof OutboundLoadCreate>

/** Records the costs, our ticket or the note as they become known; the stations, the carrier and the weights are the load's, and a wrong one is cancelled and sent again. */
export const OutboundLoadPatch = z
  .strictObject({
    outboundTicket: Label.nullable().optional(),
    haulCostMinor: NonNegativeInt.nullable().optional(),
    disposalCostMinor: NonNegativeInt.nullable().optional(),
    note: Paragraph.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type OutboundLoadPatch = z.infer<typeof OutboundLoadPatch>

/** `POST /outbound-loads/:id/receive`: the receiving site's ticket. Given again on a received or disputed load, it corrects the receipt. */
export const OutboundLoadReceive = z.strictObject({
  receivingTicket: Label,
  receivedNetKg: PositiveInt,
  receivedAt: IsoDateTime,
})
export type OutboundLoadReceive = z.infer<typeof OutboundLoadReceive>

/** `POST /outbound-loads/:id/dispute` and `/cancel`: why. */
export const OutboundLoadReason = z.strictObject({ note: Paragraph })
export type OutboundLoadReason = z.infer<typeof OutboundLoadReason>

/** `POST /outbound-loads/:id/reconcile`: the office accepts the receipt, with a word on how a dispute was settled if it likes. */
export const OutboundLoadReconcile = z.strictObject({ note: Paragraph.optional() })
export type OutboundLoadReconcile = z.infer<typeof OutboundLoadReconcile>

/** A page of loads: one project's, in one status, from or to one station. */
export const OutboundLoadListQuery = ProjectScopedListQuery.extend({
  status: OutboundLoadStatus.optional(),
  fromStationId: Id.optional(),
  toStationId: Id.optional(),
})
export type OutboundLoadListQuery = z.infer<typeof OutboundLoadListQuery>

/** What a transfer station holds of one fraction for one project. */
export const MaterialStockRow = z.object({
  projectId: Id,
  wasteFractionId: Id,
  /** Tipped by our Unloads, approved or not yet reviewed. */
  inKg: z.int(),
  /** Tipped under a weight a review rejected: beside, in no total. */
  rejectedKg: z.int(),
  /** Sent on in loads not cancelled. */
  outKg: z.int(),
  /** The counts' adjustments, signed. */
  adjustedKg: z.int(),
  /** In, less out, plus the adjustments; may read below zero. */
  onHandKg: z.int(),
})
export type MaterialStockRow = z.infer<typeof MaterialStockRow>

/** `GET /unloading-stations/:id/stock`: the station's stock by project and fraction, in the caller's projects. */
export const MaterialStock = z.object({
  unloadingStationId: Id,
  rows: z.array(MaterialStockRow),
})
export type MaterialStock = z.infer<typeof MaterialStock>

export const MaterialStockQuery = z.object({ projectId: Id.optional() })
export type MaterialStockQuery = z.infer<typeof MaterialStockQuery>

/** Signed whole kilograms of a count's correction: never zero. */
export const DeltaKg = Int4.refine((kg) => kg !== 0, "An adjustment moves the stock: give a number of kilograms other than zero")

export const MaterialAdjustment = z.object({
  ...recorded,
  projectId: Id,
  unloadingStationId: Id,
  wasteFractionId: Id,
  deltaKg: z.int(),
  note: Paragraph,
  recordedBy: Id,
})
export type MaterialAdjustment = z.infer<typeof MaterialAdjustment>

/** `POST /unloading-stations/:id/adjustments`: the station is the path's. */
export const MaterialAdjustmentCreate = z.strictObject({
  projectId: Id,
  wasteFractionId: Id,
  deltaKg: DeltaKg,
  note: Paragraph,
})
export type MaterialAdjustmentCreate = z.infer<typeof MaterialAdjustmentCreate>

/** A page of a station's adjustments: one project's, of one fraction. */
export const MaterialAdjustmentListQuery = ProjectScopedListQuery.extend({
  wasteFractionId: Id.optional(),
})
export type MaterialAdjustmentListQuery = z.infer<typeof MaterialAdjustmentListQuery>
