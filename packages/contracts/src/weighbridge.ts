// A weighbridge's tickets on the wire (O27 of #290, row 8.8). The ingest,
// `POST /weighbridge-tickets`, takes a batch of the station's own tickets —
// its code, the ticket's number, the vehicle's plate, when it was weighed,
// the weights, and the product as a fraction's key or a waste code — under
// the same weights rule as an Unload (unloads.ts). Each ticket is answered in
// the body's order: matched to a route and written as its Unload, kept
// unmatched with the reason the office reads, replayed (the station and the
// number already known), or refused and not kept (`WEIGHBRIDGE_REFUSALS`).
// Vendor-neutral: any weighbridge's integration posts this shape, and no
// vendor's own is read here.
//
// The office reads the tickets (`WeighbridgeTicket`, a page by status) and
// matches an unmatched one by hand to a route and a fraction
// (`WeighbridgeTicketMatch`), or dismisses it with a note
// (`WeighbridgeTicketDismiss`).
import { WEIGHBRIDGE_REFUSALS, WEIGHBRIDGE_TICKET_STATUSES, WEIGHBRIDGE_UNMATCHED_REASONS } from "@waste/domain/execution/vocabulary"
import { WEIGHBRIDGE_BATCH_MAX } from "@waste/domain/execution/weighbridge"
import * as z from "zod"

import { WasteCode } from "./catalogue"
import { IsoDateTime } from "./dates"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { PositiveInt, stamped } from "./resource"
import { Label, Paragraph, Slug } from "./text"
import { bothGrossAndTare, netIsGrossLessTare, weightsAddUp, weightsPaired } from "./unloads"

export const WeighbridgeTicketStatus = z.enum(WEIGHBRIDGE_TICKET_STATUSES)
export type WeighbridgeTicketStatus = z.infer<typeof WeighbridgeTicketStatus>
export const WeighbridgeUnmatchedReason = z.enum(WEIGHBRIDGE_UNMATCHED_REASONS)
export type WeighbridgeUnmatchedReason = z.infer<typeof WeighbridgeUnmatchedReason>
export const WeighbridgeRefusal = z.enum(WEIGHBRIDGE_REFUSALS)
export type WeighbridgeRefusal = z.infer<typeof WeighbridgeRefusal>

/** One ticket as a weighbridge sends it. */
export const WeighbridgeTicketIn = z
  .strictObject({
    /** The station's code as registered, `ARC-AMAGER`. */
    stationCode: Label,
    /** The station's own number for the ticket; with the station, what a replay is known by. */
    ticketNumber: Label,
    /** The plate as the weighbridge read it; spaces, dashes and case do not matter. */
    vehicleRegistration: Label,
    weighedAt: IsoDateTime,
    netKg: PositiveInt,
    grossKg: PositiveInt.optional(),
    tareKg: PositiveInt.optional(),
    /** The product as the company keys a fraction, `residual`. */
    fractionKey: Slug().optional(),
    /** The product as a waste code, compact, `200301`: the one fraction filed under it. */
    wasteCode: WasteCode.optional(),
  })
  .refine(weightsPaired, bothGrossAndTare)
  .refine(weightsAddUp, netIsGrossLessTare)
export type WeighbridgeTicketIn = z.infer<typeof WeighbridgeTicketIn>

/** `POST /weighbridge-tickets`: one to `WEIGHBRIDGE_BATCH_MAX` tickets. */
export const WeighbridgeTicketBatch = z.strictObject({ tickets: z.array(WeighbridgeTicketIn).min(1).max(WEIGHBRIDGE_BATCH_MAX) })
export type WeighbridgeTicketBatch = z.infer<typeof WeighbridgeTicketBatch>

/** What one ticket of a batch came to, named by the station's code and number as sent. */
export const WeighbridgeTicketOutcome = z.discriminatedUnion("outcome", [
  z.object({ stationCode: Label, ticketNumber: Label, outcome: z.literal("matched"), ticketId: Id, unloadId: Id }),
  z.object({ stationCode: Label, ticketNumber: Label, outcome: z.literal("unmatched"), ticketId: Id, reason: WeighbridgeUnmatchedReason }),
  z.object({ stationCode: Label, ticketNumber: Label, outcome: z.literal("replayed"), ticketId: Id }),
  z.object({ stationCode: Label, ticketNumber: Label, outcome: z.literal("refused"), reason: WeighbridgeRefusal }),
])
export type WeighbridgeTicketOutcome = z.infer<typeof WeighbridgeTicketOutcome>

/** The ingest's answer: one outcome per ticket, in the body's order. */
export const WeighbridgeIngest = z.object({ outcomes: z.array(WeighbridgeTicketOutcome) })
export type WeighbridgeIngest = z.infer<typeof WeighbridgeIngest>

/** A ticket as the office reads it. */
export const WeighbridgeTicket = z.object({
  ...stamped,
  /** The project of its vehicle or of the route it was matched to; null where its vehicle is not known. */
  projectId: Id.nullable(),
  unloadingStationId: Id,
  ticketNumber: Label,
  /** The plate as the weighbridge sent it. */
  vehicleRegistration: Label,
  /** The vehicle the plate is, where it is one the integration reaches. */
  vehicleId: Id.nullable(),
  weighedAt: IsoDateTime,
  grossKg: PositiveInt.nullable(),
  tareKg: PositiveInt.nullable(),
  netKg: PositiveInt,
  fractionKey: Slug().nullable(),
  wasteCode: WasteCode.nullable(),
  status: WeighbridgeTicketStatus,
  /** Why it found no route on its own; kept once it is matched or dismissed, as what it waited for. */
  unmatchedReason: WeighbridgeUnmatchedReason.nullable(),
  /** The route and the Unload it was written as, once matched. */
  routeId: Id.nullable(),
  unloadId: Id.nullable(),
  /** Why the office dismissed it. */
  dismissedNote: Paragraph.nullable(),
  /** The account that sent it. */
  receivedBy: Id,
})
export type WeighbridgeTicket = z.infer<typeof WeighbridgeTicket>

/** A page of tickets: one project's (or every project's and the tickets of no known vehicle), of one status, oldest first. */
export const WeighbridgeTicketListQuery = ProjectScopedListQuery.extend({ status: WeighbridgeTicketStatus.optional() })
export type WeighbridgeTicketListQuery = z.infer<typeof WeighbridgeTicketListQuery>

/** `POST /weighbridge-tickets/:id/match`: the route the ticket's load came off, and its fraction. */
export const WeighbridgeTicketMatch = z.strictObject({ routeId: Id, wasteFractionId: Id })
export type WeighbridgeTicketMatch = z.infer<typeof WeighbridgeTicketMatch>

/** `POST /weighbridge-tickets/:id/dismiss`: why it is no route's. */
export const WeighbridgeTicketDismiss = z.strictObject({ note: Paragraph })
export type WeighbridgeTicketDismiss = z.infer<typeof WeighbridgeTicketDismiss>
