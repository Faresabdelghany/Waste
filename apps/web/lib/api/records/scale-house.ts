// Operate › Scale house on the API (M16a of #293): the window's tickets,
// `scale-ticket-<uuid>`, and the tare register, `vehicle-tare-<uuid>`, from
// the start (`@waste/contracts/scale-house`, routes
// apps/api/src/routes/scale-house.ts). A ticket is weighed in through its
// create, and weighed out (`complete`) and voided by command; an open one's
// visitor and note are its only patch, which the window leaves to the API's
// own clients. A tare is registered through its create, and re-weighed,
// retired and taken back through its patch, run as commands from its details.
// A completed ticket of one of our own vehicles is its route's Unload, which
// Weight Control reads again (`touches`). The words are
// lib/data/scale-house.ts'.
import type { ScaleTicket, ScaleTicketAmountDue, ScaleTicketComplete, ScaleTicketCreate, VehicleTare, VehicleTareCreate } from "@waste/contracts/scale-house"
import { LITRES_PER_M3 } from "@waste/domain/finance/window"
import { scaleTicketLabel } from "@waste/domain/numbering"
import { FOUR_DIGITS_PATTERN, MUNICIPALITY_CODE_SHAPE } from "@waste/domain/registry/address"
import { VOID_SAYS_WHY } from "@waste/domain/scale-house/rules"
import { SCALE_TICKET_PARTIES, SCALE_TICKET_VOID_REASONS, TARE_SOURCES, type ScaleTicketParty, type ScaleTicketVoidReason, type TareSource } from "@waste/domain/scale-house/vocabulary"

import { AGREEMENT_PREFIX, isAgreementRecord } from "@/lib/data/agreements"
import { isProductRecord, PRODUCT_PREFIX } from "@/lib/data/commercial"
import { type BusinessRecord } from "@/lib/data/business-modules"
import { MASTER_DATA_KIND_DETAILS } from "@/lib/data/master-data-kinds"
import { WEIGHTS_MODULE } from "@/lib/data/provider-money"
import {
  PARTY_LABELS,
  SCALE_HOUSE_MODULE,
  SCALE_TICKET_PREFIX,
  SCALE_TICKET_RECORD_KIND,
  SCALE_TICKET_STATUS_LABELS,
  TARE_SOURCE_LABELS,
  VEHICLE_TARE_PREFIX,
  VEHICLE_TARE_RECORD_KIND,
  VEHICLE_TARE_STATUS_LABELS,
  VOID_REASON_LABELS,
  WINDOW_LINES,
} from "@/lib/data/scale-house"

import { command, create, get, listAll, patch, type ApiClient } from "../client"
import { said, type CommandInput, type MappingContext, type RecordCommand, type RecordFields, type ResourceAdapter, type ServerModule } from "./adapter"
import { isLocalRefusal, ofKind, typed, webIdOf, type LocalRefusal } from "@/lib/records/fields"
import { kilograms } from "@/lib/format/measures"
import { shownOn } from "@/lib/format/clock"
import { projectServerIdOf, referenced, refusal } from "./places"
import { nameVia, referencedServerId, typedReference } from "./references"
import { customerAdapter } from "./registry"

const CUSTOMER_PREFIX = "customer"
const STATION_PREFIX = "station"
const FRACTION_PREFIX = MASTER_DATA_KIND_DETAILS["waste-fraction"].prefix

export const KILOGRAMS = "A weight is a whole number of kilograms, 1 or more"

const KEPT = "What was weighed and for whom is what the ticket is: void it and weigh again"

function weightIn(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : Number.NaN
}

export const COMPLETE_TICKET = "complete"
export const VOID_TICKET = "void"

/** What a ticket's details offer: Weigh out and Void while open, Void once completed unless it is a route's Unload, nothing once voided. */
export const ticketCommandsOffered = (record: { submittedValues?: Record<string, unknown> }): string[] => {
  const status = record.submittedValues?.status
  if (status === "open") return [COMPLETE_TICKET, VOID_TICKET]
  if (status === "completed" && record.submittedValues?.unloadId === undefined) return [VOID_TICKET]
  return []
}

export function toScaleTicketRecord(ticket: ScaleTicket, context: MappingContext): RecordFields {
  const project = referenced(context, "project", ticket.projectId)
  const projectRecord = context.resolve.byServerId(ticket.projectId)
  const timezone = projectRecord === undefined ? undefined : typed(projectRecord, "timezone")
  const site = nameVia(context, STATION_PREFIX, ticket.unloadingStationId)
  const party = ticket.customerId === null ? (ticket.visitorName ?? PARTY_LABELS.cash) : nameVia(context, CUSTOMER_PREFIX, ticket.customerId)
  const route = ticket.routeId === null ? undefined : nameVia(context, "route", ticket.routeId)
  const lines = Object.fromEntries(
    ticket.lines.map((line) => [
      `Line ${line.position}`,
      [
        nameVia(context, FRACTION_PREFIX, line.wasteFractionId),
        ...(line.originMunicipality === null ? [] : [line.originMunicipality]),
        kilograms(line.netKg),
        ...(line.volumeLitres === null ? [] : [`${line.volumeLitres / LITRES_PER_M3} m³`]),
        ...(line.productId === null ? [] : [nameVia(context, PRODUCT_PREFIX, line.productId)]),
      ].join(" · "),
    ]),
  )
  return {
    name: `${scaleTicketLabel(ticket.number)} · ${ticket.vehiclePlate}`,
    context: `${site} · ${party}`,
    status: SCALE_TICKET_STATUS_LABELS[ticket.status],
    value: ticket.netKg === null ? kilograms(ticket.grossKg) : kilograms(ticket.netKg),
    description:
      ticket.status === "open"
        ? "Weighed in; waiting for the second pass."
        : ticket.status === "voided"
          ? `Voided: ${ticket.voidReason === null ? "" : VOID_REASON_LABELS[ticket.voidReason].toLowerCase()}${ticket.voidNote === null ? "" : ` — ${ticket.voidNote}`}.`
          : route !== undefined
            ? `Written as ${route}'s unload.`
            : `Completed at ${kilograms(ticket.netKg ?? 0)}.`,
    facts: {
      Ticket: scaleTicketLabel(ticket.number),
      Site: site,
      Plate: ticket.vehiclePlate,
      ...(ticket.trailerPlate === null ? {} : { Trailer: ticket.trailerPlate }),
      ...(ticket.containerRef === null ? {} : { Container: ticket.containerRef }),
      ...(ticket.vehicleId === null ? {} : { Vehicle: nameVia(context, "vehicle", ticket.vehicleId) }),
      For: PARTY_LABELS[ticket.party],
      ...(ticket.customerId === null ? {} : { Customer: party }),
      ...(ticket.agreementId === null ? {} : { Agreement: nameVia(context, AGREEMENT_PREFIX, ticket.agreementId) }),
      ...(ticket.visitorName === null ? {} : { Visitor: ticket.visitorName }),
      "Weighed in": shownOn(ticket.weighedInAt, timezone),
      Gross: kilograms(ticket.grossKg),
      ...(ticket.tareKg === null ? {} : { Tare: `${kilograms(ticket.tareKg)} · ${ticket.tareSource === null ? "" : TARE_SOURCE_LABELS[ticket.tareSource].toLowerCase()}` }),
      ...(ticket.weighedOutAt === null ? {} : { "Weighed out": shownOn(ticket.weighedOutAt, timezone) }),
      ...(ticket.netKg === null ? {} : { Net: kilograms(ticket.netKg) }),
      ...lines,
      ...(route === undefined ? {} : { Route: route }),
      ...(ticket.unloadId === null ? {} : { Unload: webIdOf("unload", ticket.unloadId) }),
      ...(ticket.voidReason === null ? {} : { Voided: VOID_REASON_LABELS[ticket.voidReason] }),
      ...(ticket.note === null ? {} : { Note: ticket.note }),
    },
    related: [site, ...(route === undefined ? [] : [route])],
    allowedTransitions: [],
    projectIds: [project.webId],
    recordKind: SCALE_TICKET_RECORD_KIND,
    submittedValues: {
      projectId: project.webId,
      status: ticket.status,
      party: ticket.party,
      vehiclePlate: ticket.vehiclePlate,
      unloadingStationId: webIdOf(STATION_PREFIX, ticket.unloadingStationId),
      ...(ticket.vehicleId === null ? {} : { vehicleId: webIdOf("vehicle", ticket.vehicleId) }),
      ...(ticket.unloadId === null ? {} : { unloadId: webIdOf("unload", ticket.unloadId) }),
    },
  }
}

const isParty = (value: string | undefined): value is ScaleTicketParty => SCALE_TICKET_PARTIES.includes(value as ScaleTicketParty)

/** `POST /scale-tickets` from the record Weigh in made: every id by the server's, an account's customer and agreement, a walk-in's name. */
export function toScaleTicketCreateBody(record: BusinessRecord, context: MappingContext): ScaleTicketCreate | LocalRefusal {
  const projectId = projectServerIdOf(record, context)
  if (isLocalRefusal(projectId)) return projectId
  const stationWebId = typed(record, "unloadingStationId")
  const unloadingStationId = stationWebId === undefined ? undefined : referencedServerId(stationWebId, STATION_PREFIX, context)
  if (unloadingStationId === undefined) return refusal("unloadingStationId", "Pick the site")
  const vehiclePlate = typed(record, "vehiclePlate")
  if (vehiclePlate === undefined) return refusal("vehiclePlate", "Type the plate")
  const grossKg = weightIn(typed(record, "grossKg"))
  if (grossKg === undefined || Number.isNaN(grossKg)) return refusal("grossKg", KILOGRAMS)
  const party = typed(record, "party") ?? "cash"
  if (!isParty(party)) return refusal("party", "Pick an account customer or a walk-in")
  const optional = (key: string) => typed(record, key) ?? null
  const body = { projectId, unloadingStationId, vehiclePlate, trailerPlate: optional("trailerPlate"), containerRef: optional("containerRef"), grossKg, note: optional("note") }
  if (party === "cash") return { ...body, party, visitorName: optional("visitorName") }
  const customerId = typedReference(record, "customerId", CUSTOMER_PREFIX, context, "Pick a customer the API holds", { owns: customerAdapter.owns })
  if (isLocalRefusal(customerId)) return customerId
  if (customerId === undefined) return refusal("customerId", "Pick the account customer")
  const agreementId = typedReference(record, "agreementId", AGREEMENT_PREFIX, context, "Pick an agreement the API holds", { owns: isAgreementRecord })
  if (isLocalRefusal(agreementId)) return agreementId
  if (agreementId === undefined) return refusal("agreementId", "Pick the agreement the ticket is charged under")
  return { ...body, party, customerId, agreementId }
}

/** `POST /scale-tickets/:id/complete` from the Weigh out form: the tare, and each line the form filled. */
export function toCompleteBody(input: CommandInput, context: MappingContext): ScaleTicketComplete | LocalRefusal {
  const source = said(input, "tareSource") ?? "weighed"
  if (!TARE_SOURCES.includes(source as TareSource)) return refusal("tareSource", "Pick a second pass or the registered tare")
  let tare: ScaleTicketComplete["tare"]
  if (source === "weighed") {
    const tareKg = weightIn(said(input, "tareKg"))
    if (tareKg === undefined || Number.isNaN(tareKg)) return refusal("tareKg", KILOGRAMS)
    tare = { source: "weighed", tareKg }
  } else {
    tare = { source: "registered" }
  }
  const lines: ScaleTicketComplete["lines"] = []
  for (let n = 1; n <= WINDOW_LINES; n++) {
    const fractionWebId = said(input, `fraction${n}`)
    const net = said(input, `net${n}`)
    if (fractionWebId === undefined && net === undefined) continue
    const wasteFractionId = fractionWebId === undefined ? undefined : referencedServerId(fractionWebId, FRACTION_PREFIX, context)
    if (wasteFractionId === undefined) return refusal(`fraction${n}`, "Pick a waste fraction the API holds")
    const netKg = weightIn(net)
    if (netKg === undefined || Number.isNaN(netKg)) return refusal(`net${n}`, KILOGRAMS)
    const origin = said(input, `origin${n}`)
    if (origin !== undefined && !new RegExp(FOUR_DIGITS_PATTERN).test(origin)) return refusal(`origin${n}`, MUNICIPALITY_CODE_SHAPE)
    const productWebId = said(input, `product${n}`)
    const productId = productWebId === undefined ? undefined : referencedServerId(productWebId, PRODUCT_PREFIX, context, { owns: isProductRecord })
    if (productWebId !== undefined && productId === undefined) return refusal(`product${n}`, "Pick a product the API holds")
    const volume = said(input, `volume${n}`)
    const volumeLitres = volume === undefined ? undefined : Math.round(Number(volume) * LITRES_PER_M3)
    if (volumeLitres !== undefined && !(Number.isFinite(volumeLitres) && volumeLitres >= 1)) return refusal(`volume${n}`, "A volume is cubic metres above 0: 1.5")
    lines.push({ wasteFractionId, netKg, ...(origin === undefined ? {} : { originMunicipality: origin }), ...(productId === undefined ? {} : { productId }), ...(volumeLitres === undefined ? {} : { volumeLitres }) })
  }
  if (lines.length === 0) return refusal("fraction1", "Split the load into at least one line")
  return { tare, lines }
}

export const SCALE_TICKET_COMMANDS: Readonly<Record<string, RecordCommand<ScaleTicket>>> = {
  [COMPLETE_TICKET]: {
    toBody: (input, _record, context) => toCompleteBody(input, context),
    run: (client, serverId, body) => command<ScaleTicket>(client, `/scale-tickets/${serverId}/complete`, body),
    refused: (record) => `${record.name} was not weighed out`,
    // One of our own vehicles' ticket is now its route's unload: Weight Control reads it.
    touches: [`${WEIGHTS_MODULE.workspaceId}.${WEIGHTS_MODULE.moduleId}`],
  },
  [VOID_TICKET]: {
    toBody: (input) => {
      const reason = said(input, "reason")
      if (!SCALE_TICKET_VOID_REASONS.includes(reason as ScaleTicketVoidReason)) return refusal("reason", "Pick why the ticket is voided")
      const note = said(input, "note")
      if (reason === "other" && note === undefined) return refusal("note", VOID_SAYS_WHY)
      return { reason, ...(note === undefined ? {} : { note }) }
    },
    run: (client, serverId, body) => command<ScaleTicket>(client, `/scale-tickets/${serverId}/void`, body),
    refused: (record) => `${record.name} was not voided`,
  },
}

export const scaleTicketAdapter: ResourceAdapter<ScaleTicket, ScaleTicketCreate> = {
  prefix: SCALE_TICKET_PREFIX,
  auditTable: "scale_ticket",
  // A ticket Weigh in has just made is `scale-house-scale-ticket-<clock>` until the server answers: owned by its recordKind.
  owns: ofKind(SCALE_TICKET_PREFIX, [SCALE_TICKET_RECORD_KIND]),
  // A ticket's status moves by its commands alone.
  statuses: undefined,
  list: (client: ApiClient) => listAll<ScaleTicket>(client, "/scale-tickets"),
  toRecord: toScaleTicketRecord,
  toCreateBody: toScaleTicketCreateBody,
  kept: { path: "vehiclePlate", message: KEPT },
  create: (client, body) => create<ScaleTicket>(client, "/scale-tickets", body).then((created) => created.body),
  read: (client, serverId) => get<ScaleTicket>(client, `/scale-tickets/${serverId}`),
  commands: SCALE_TICKET_COMMANDS,
}

export const REWEIGH_TARE = "reweigh"
export const RETIRE_TARE = "retire"
export const REACTIVATE_TARE = "reactivate"

export const tareCommandsOffered = (record: { submittedValues?: Record<string, unknown> }): string[] => (record.submittedValues?.status === "active" ? [REWEIGH_TARE, RETIRE_TARE] : [REACTIVATE_TARE])

export function toVehicleTareRecord(tare: VehicleTare, context: MappingContext): RecordFields {
  const project = referenced(context, "project", tare.projectId)
  const keys = [tare.plate, tare.trailerPlate, tare.containerRef].filter((part) => part !== null).join(" + ")
  const owner = tare.customerId === null ? undefined : nameVia(context, CUSTOMER_PREFIX, tare.customerId)
  return {
    name: tare.label === null ? keys : `${keys} · ${tare.label}`,
    context: `Registered tare${owner === undefined ? "" : ` · ${owner}`}`,
    status: VEHICLE_TARE_STATUS_LABELS[tare.status],
    value: kilograms(tare.tareKg),
    description: `Weighed empty on ${tare.weighedOn}.`,
    facts: {
      Plate: tare.plate,
      ...(tare.trailerPlate === null ? {} : { Trailer: tare.trailerPlate }),
      ...(tare.containerRef === null ? {} : { Container: tare.containerRef }),
      Tare: kilograms(tare.tareKg),
      "Weighed on": tare.weighedOn,
      ...(owner === undefined ? {} : { Haulier: owner }),
    },
    related: owner === undefined ? [] : [owner],
    allowedTransitions: [],
    projectIds: [project.webId],
    recordKind: VEHICLE_TARE_RECORD_KIND,
    submittedValues: { projectId: project.webId, status: tare.status, plate: tare.plate, tareKg: String(tare.tareKg), weighedOn: tare.weighedOn },
  }
}

/** `POST /vehicle-tares` from the record Register tare made. */
export function toVehicleTareCreateBody(record: BusinessRecord, context: MappingContext): VehicleTareCreate | LocalRefusal {
  const projectId = projectServerIdOf(record, context)
  if (isLocalRefusal(projectId)) return projectId
  const plate = typed(record, "plate")
  if (plate === undefined) return refusal("plate", "Type the plate")
  const tareKg = weightIn(typed(record, "tareKg"))
  if (tareKg === undefined || Number.isNaN(tareKg)) return refusal("tareKg", KILOGRAMS)
  const weighedOn = typed(record, "weighedOn")
  if (weighedOn === undefined) return refusal("weighedOn", "Pick the day it was weighed empty")
  const customerId = typedReference(record, "customerId", CUSTOMER_PREFIX, context, "Pick a customer the API holds", { owns: customerAdapter.owns })
  if (isLocalRefusal(customerId)) return customerId
  const optional = (key: string) => typed(record, key) ?? null
  return { projectId, plate, trailerPlate: optional("trailerPlate"), containerRef: optional("containerRef"), tareKg, weighedOn, customerId: customerId ?? null, label: optional("label") }
}

export const VEHICLE_TARE_COMMANDS: Readonly<Record<string, RecordCommand<VehicleTare>>> = {
  [REWEIGH_TARE]: {
    toBody: (input) => {
      const tareKg = weightIn(said(input, "tareKg"))
      if (tareKg === undefined || Number.isNaN(tareKg)) return refusal("tareKg", KILOGRAMS)
      const weighedOn = said(input, "weighedOn")
      if (weighedOn === undefined) return refusal("weighedOn", "Pick the day it was weighed empty")
      return { tareKg, weighedOn }
    },
    run: (client, serverId, body) => patch<VehicleTare>(client, `/vehicle-tares/${serverId}`, body),
    refused: (record) => `${record.name} was not re-weighed`,
  },
  [RETIRE_TARE]: {
    run: (client, serverId) => patch<VehicleTare>(client, `/vehicle-tares/${serverId}`, { status: "retired" }),
    refused: (record) => `${record.name} was not retired`,
  },
  [REACTIVATE_TARE]: {
    run: (client, serverId) => patch<VehicleTare>(client, `/vehicle-tares/${serverId}`, { status: "active" }),
    refused: (record) => `${record.name} was not taken back`,
  },
}

export const vehicleTareAdapter: ResourceAdapter<VehicleTare, VehicleTareCreate> = {
  prefix: VEHICLE_TARE_PREFIX,
  auditTable: "vehicle_tare",
  owns: ofKind(VEHICLE_TARE_PREFIX, [VEHICLE_TARE_RECORD_KIND]),
  // A tare's status moves by its commands alone.
  statuses: undefined,
  list: (client: ApiClient) => listAll<VehicleTare>(client, "/vehicle-tares"),
  toRecord: toVehicleTareRecord,
  toCreateBody: toVehicleTareCreateBody,
  kept: { path: "plate", message: "A tare's plates and container are what it is: re-weigh or retire it from its details" },
  create: (client, body) => create<VehicleTare>(client, "/vehicle-tares", body).then((created) => created.body),
  read: (client, serverId) => get<VehicleTare>(client, `/vehicle-tares/${serverId}`),
  commands: VEHICLE_TARE_COMMANDS,
}

/** Operate › Scale house: the tickets and the tares, read after the projects, the stations, the customers, the agreements, the vehicles, the routes and the fractions they name. */
export const scaleHouseModule = { ...SCALE_HOUSE_MODULE, resources: [scaleTicketAdapter, vehicleTareAdapter] } satisfies ServerModule

/** `GET /scale-tickets/:id/amount-due` (M16b of #293): what a completed ticket comes to at the window, each line priced as Finance would price it. A read; nothing is stored or paid. */
export function amountDueOf(client: ApiClient, serverId: string): Promise<ScaleTicketAmountDue> {
  return get<ScaleTicketAmountDue>(client, `/scale-tickets/${serverId}/amount-due`)
}
