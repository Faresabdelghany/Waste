// The scale house on the wire (M16a of #293, #404): the tare register and the
// tickets weighed at the window of one of our own sites.
//
// A registered tare (`VehicleTare`) is a vehicle's weight empty, by its plate
// and, where it is weighed with them, its trailer's plate and the container
// it carries; each kept as the match reads a plate — upper case, letters and
// digits alone — so the window finds it however the plate is typed.
//
// A ticket (`ScaleTicket`) is weighed in at its gross (`ScaleTicketCreate`),
// for an account customer under one of its agreements or a walk-in paying at
// the window, and completed (`ScaleTicketComplete`) at its tare — a second
// pass over the scale or the vehicle's registered tare — with its load split
// into lines by fraction and the municipality it came from, the lines summing
// to the net. A ticket is voided with its reason, never deleted
// (`ScaleTicketVoid`). One of our own vehicles' tickets, matched to the route
// it ran, is also written as that route's Unload: `routeId` and `unloadId`.
import { WEIGHBRIDGE_UNMATCHED_REASONS } from "@waste/domain/execution/vocabulary"
import { FOUR_DIGITS_PATTERN, MUNICIPALITY_CODE_SHAPE } from "@waste/domain/registry/address"
import { eachOnce } from "@waste/domain/requests"
import { EACH_LINE_ONCE, lineKey, PARTY_SHAPE, partyShaped, SCALE_TICKET_LINES_MAX, VOID_SAYS_WHY, voidSaysWhy } from "@waste/domain/scale-house/rules"
import { SCALE_TICKET_PARTIES, SCALE_TICKET_STATUSES, SCALE_TICKET_VOID_REASONS, TARE_SOURCES, VEHICLE_TARE_STATUSES } from "@waste/domain/scale-house/vocabulary"
import * as z from "zod"

import { IsoDate, IsoDateTime } from "./dates"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { BlockReason } from "./finance"
import { Minor, PositiveInt, resourceBodies, stamped } from "./resource"
import { Label, Paragraph } from "./text"

export const ScaleTicketStatus = z.enum(SCALE_TICKET_STATUSES)
export type ScaleTicketStatus = z.infer<typeof ScaleTicketStatus>
export const ScaleTicketParty = z.enum(SCALE_TICKET_PARTIES)
export type ScaleTicketParty = z.infer<typeof ScaleTicketParty>
export const TareSource = z.enum(TARE_SOURCES)
export type TareSource = z.infer<typeof TareSource>
export const ScaleTicketVoidReason = z.enum(SCALE_TICKET_VOID_REASONS)
export type ScaleTicketVoidReason = z.infer<typeof ScaleTicketVoidReason>
export const VehicleTareStatus = z.enum(VEHICLE_TARE_STATUSES)
export type VehicleTareStatus = z.infer<typeof VehicleTareStatus>

/** A municipality's code, the kommunekode, four digits as a Property spells it: `0101`. */
export const MunicipalityCode = z.string().regex(new RegExp(FOUR_DIGITS_PATTERN), { error: MUNICIPALITY_CODE_SHAPE })

/** A registered tare as the window reads it. */
export const VehicleTare = z.object({
  ...stamped,
  projectId: Id,
  /** As the register keys it: upper case, letters and digits alone. */
  plate: z.string(),
  trailerPlate: z.string().nullable(),
  containerRef: z.string().nullable(),
  tareKg: PositiveInt,
  /** The day it was weighed empty. */
  weighedOn: IsoDate,
  /** The haulier it belongs to, where the office names one. */
  customerId: Id.nullable(),
  label: Label.nullable(),
  status: VehicleTareStatus,
})
export type VehicleTare = z.infer<typeof VehicleTare>

/** A patch is a re-weighing, its owner and label, or its retirement, a status only a patch sets: the plates and the container are what the tare is of — register another. */
const vehicleTareBodies = resourceBodies(
  {
    projectId: Id,
    plate: Label,
    trailerPlate: Label.nullable().optional(),
    containerRef: Label.nullable().optional(),
    tareKg: PositiveInt,
    weighedOn: IsoDate,
    customerId: Id.nullable().optional(),
    label: Label.nullable().optional(),
  },
  { createOnly: { projectId: true, plate: true, trailerPlate: true, containerRef: true }, patch: { status: VehicleTareStatus.optional() } },
)

export const VehicleTareCreate = vehicleTareBodies.create
export type VehicleTareCreate = z.infer<typeof VehicleTareCreate>

export const VehicleTarePatch = vehicleTareBodies.patch
export type VehicleTarePatch = z.infer<typeof VehicleTarePatch>

/** A page of registered tares: one project's, one plate's (keyed as stored), one standing's. */
export const VehicleTareListQuery = ProjectScopedListQuery.extend({ plate: Label.optional(), status: VehicleTareStatus.optional() })
export type VehicleTareListQuery = z.infer<typeof VehicleTareListQuery>

/** One line of a ticket's split. */
export const ScaleTicketLine = z.object({
  id: Id,
  /** From 1, in the order the window gave them. */
  position: PositiveInt,
  wasteFractionId: Id,
  originMunicipality: MunicipalityCode.nullable(),
  netKg: PositiveInt,
  /** The window's product the line is sold by (M16b of #293), per tonne or per cubic metre; null where none was named. */
  productId: Id.nullable(),
  /** The declared volume of a line sold by the cubic metre, whole litres. */
  volumeLitres: PositiveInt.nullable(),
})
export type ScaleTicketLine = z.infer<typeof ScaleTicketLine>

/** A ticket as the window and the office read it. */
export const ScaleTicket = z.object({
  ...stamped,
  projectId: Id,
  /** The company's own number for it, what the customer is handed. */
  number: PositiveInt,
  /** The site it was weighed at: one of our own stations with a weighbridge. */
  unloadingStationId: Id,
  vehiclePlate: Label,
  trailerPlate: Label.nullable(),
  containerRef: Label.nullable(),
  /** One of our own vehicles, where the plate is one. */
  vehicleId: Id.nullable(),
  party: ScaleTicketParty,
  /** An account customer's, and the agreement it is charged under. */
  customerId: Id.nullable(),
  agreementId: Id.nullable(),
  /** A walk-in's name, where they gave one. */
  visitorName: Label.nullable(),
  grossKg: PositiveInt,
  weighedInAt: IsoDateTime,
  tareKg: PositiveInt.nullable(),
  tareSource: TareSource.nullable(),
  /** The registered tare it was completed on. */
  vehicleTareId: Id.nullable(),
  /** The second pass, or the completion on the registered tare. */
  weighedOutAt: IsoDateTime.nullable(),
  netKg: PositiveInt.nullable(),
  status: ScaleTicketStatus,
  lines: z.array(ScaleTicketLine),
  /** One of our own vehicles' ticket: the route it was matched to and the Unload it was written as. */
  routeId: Id.nullable(),
  unloadId: Id.nullable(),
  /** One of our own vehicles' ticket that found no route: why. */
  unmatchedReason: z.enum(WEIGHBRIDGE_UNMATCHED_REASONS).nullable(),
  voidReason: ScaleTicketVoidReason.nullable(),
  voidNote: Paragraph.nullable(),
  voidedAt: IsoDateTime.nullable(),
  note: Paragraph.nullable(),
  /** The account that weighed it in. */
  recordedBy: Id,
})
export type ScaleTicket = z.infer<typeof ScaleTicket>

/** `POST /scale-tickets`: the first pass, at the gross, weighed in now where the instant is omitted. A patch moves an open ticket's walk-in name and note; what was weighed and for whom is what the ticket is — void it and weigh again. */
const scaleTicketBodies = resourceBodies(
  {
    projectId: Id,
    unloadingStationId: Id,
    vehiclePlate: Label,
    trailerPlate: Label.nullable().optional(),
    containerRef: Label.nullable().optional(),
    party: ScaleTicketParty,
    customerId: Id.nullable().optional(),
    agreementId: Id.nullable().optional(),
    visitorName: Label.nullable().optional(),
    grossKg: PositiveInt,
    weighedInAt: IsoDateTime.optional(),
    note: Paragraph.nullable().optional(),
  },
  { createOnly: { projectId: true, unloadingStationId: true, vehiclePlate: true, trailerPlate: true, containerRef: true, party: true, customerId: true, agreementId: true, grossKg: true, weighedInAt: true } },
)

export const ScaleTicketCreate = scaleTicketBodies.create.refine(partyShaped, { message: PARTY_SHAPE, path: ["customerId"] })
export type ScaleTicketCreate = z.infer<typeof ScaleTicketCreate>

export const ScaleTicketPatch = scaleTicketBodies.patch
export type ScaleTicketPatch = z.infer<typeof ScaleTicketPatch>

export const ScaleTicketLineIn = z.strictObject({
  wasteFractionId: Id,
  originMunicipality: MunicipalityCode.nullable().optional(),
  netKg: PositiveInt,
  /** The window's product the line is sold by (M16b of #293): one of the project's sold per tonne or per cubic metre. An account's line names one to be charged. */
  productId: Id.nullable().optional(),
  /** The declared volume, whole litres: required for a product sold by the cubic metre, and refused otherwise. */
  volumeLitres: PositiveInt.nullable().optional(),
})
export type ScaleTicketLineIn = z.infer<typeof ScaleTicketLineIn>

/** The tare: a second pass over the scale, or the vehicle's registered tare. */
export const ScaleTicketTare = z.discriminatedUnion("source", [z.strictObject({ source: z.literal(TareSource.enum.weighed), tareKg: PositiveInt }), z.strictObject({ source: z.literal(TareSource.enum.registered) })])
export type ScaleTicketTare = z.infer<typeof ScaleTicketTare>

/** `POST /scale-tickets/:id/complete`: the tare, and the load split into lines that sum to the net. */
export const ScaleTicketComplete = z
  .strictObject({
    tare: ScaleTicketTare,
    /** Now, where omitted. */
    weighedOutAt: IsoDateTime.optional(),
    lines: z.array(ScaleTicketLineIn).min(1).max(SCALE_TICKET_LINES_MAX),
  })
  .refine((body) => eachOnce(body.lines, lineKey), { message: EACH_LINE_ONCE, path: ["lines"] })
export type ScaleTicketComplete = z.infer<typeof ScaleTicketComplete>

/** `POST /scale-tickets/:id/void`: why, the note saying more, and saying it where the reason is another. */
export const ScaleTicketVoid = z
  .strictObject({ reason: ScaleTicketVoidReason, note: Paragraph.nullable().optional() })
  .refine(voidSaysWhy, { message: VOID_SAYS_WHY, path: ["note"] })
export type ScaleTicketVoid = z.infer<typeof ScaleTicketVoid>

/** A page of tickets: one project's, one site's, one standing's, one party's, one customer's. */
export const ScaleTicketListQuery = ProjectScopedListQuery.extend({
  status: ScaleTicketStatus.optional(),
  unloadingStationId: Id.optional(),
  party: ScaleTicketParty.optional(),
  customerId: Id.optional(),
})
export type ScaleTicketListQuery = z.infer<typeof ScaleTicketListQuery>

/** One line of what is due at the window: its product and measure, and its price, or why it has none. */
export const AmountDueLine = z.object({
  lineId: Id,
  productId: Id.nullable(),
  /** The line's measure in its product's unit: 2.34 tonnes, 1.5 m³; null where it names no product the window sells. */
  quantity: z.number().nullable(),
  unitPriceMinor: Minor.nullable(),
  netMinor: Minor.nullable(),
  vatMinor: Minor.nullable(),
  /** Why the line has no price; null for a priced one. */
  blockReason: BlockReason.nullable(),
})
export type AmountDueLine = z.infer<typeof AmountDueLine>

/**
 * `GET /scale-tickets/:id/amount-due` (M16b of #293): what the ticket comes
 * to at the window — each line priced as Finance would price it, an account's
 * under its agreement, a walk-in's under the project's default list — and the
 * total, in the list's currency. It stores nothing and takes no payment.
 */
export const ScaleTicketAmountDue = z.object({
  ticketId: Id,
  currency: z.string().nullable(),
  lines: z.array(AmountDueLine),
  /** The net and the VAT of the priced lines, and their sum; every line priced or the total is not whole. */
  netMinor: Minor,
  vatMinor: Minor,
  totalMinor: Minor,
  complete: z.boolean(),
})
export type ScaleTicketAmountDue = z.infer<typeof ScaleTicketAmountDue>
