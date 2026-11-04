// A transfer station's haul-out on the Pilot (M17 of #293, row 28.3): the
// station's stock by project and fraction (`GET /unloading-stations/:id/stock`)
// and the loads that left it (`GET /outbound-loads?fromStationId=`), read in a
// transfer station's details; and the row's actions, each a request about the
// station that answers another resource, never the station itself:
//
//   adjust-stock    POST /unloading-stations/:id/adjustments
//   send-load       POST /outbound-loads
//   receive-load    POST /outbound-loads/:load/receive
//   reconcile-load  POST /outbound-loads/:load/reconcile
//   dispute-load    POST /outbound-loads/:load/dispute
//   cancel-load     POST /outbound-loads/:load/cancel
//
// A dialog names the project, the fraction, the receiving station and our
// vehicle by their web ids, which go out as their server ids; a hauler's load
// gives the plate instead. The instants are typed on the project's clock and
// go out as instants; the costs are typed in the project's currency and go out
// as its minor units, never billed. What the API refuses is the store's toast
// in its words. The grant is `route-studio.weights`, not the stations' own: a
// role without it is told so where the stock would be.
import type { MaterialStock, MaterialStockRow, OutboundLoad } from "@waste/contracts/haul-out"

import { minorOf } from "@/lib/commercial/money"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { STATIONS_MODULE } from "@/lib/data/haul-out"

import { get, listAll, post } from "../client"
import type { CommandInput, LocalRefusal, MappingContext, RecordAction } from "./adapter"
import { instantOn } from "./clock"
import type { ActionOutcome, SendAction } from "./server-records"

export const ADJUST_STOCK = "adjust-stock"
export const SEND_LOAD = "send-load"
export const RECEIVE_LOAD = "receive-load"
export const RECONCILE_LOAD = "reconcile-load"
export const DISPUTE_LOAD = "dispute-load"
export const CANCEL_LOAD = "cancel-load"

const refusal = (path: string, message: string): LocalRefusal => ({ path, message })
const text = (input: CommandInput, key: string): string => (typeof input[key] === "string" ? (input[key] as string).trim() : "")
const optional = (value: string): string | undefined => (value === "" ? undefined : value)

/** A web id typed into a dialog as the server id the API holds, or the refusal at the field. */
function serverId(input: CommandInput, key: string, context: MappingContext, message: string): string | LocalRefusal {
  const webId = text(input, key)
  const id = webId === "" ? undefined : context.resolve.serverIdOf(webId)
  return id ?? refusal(key, message)
}

/** Whole kilograms typed, at least one; `signed` takes a minus and refuses zero. */
function kilograms(input: CommandInput, key: string, message: string, { signed = false, optional: absent = false } = {}): number | undefined | LocalRefusal {
  const typed = text(input, key)
  if (typed === "" && absent) return undefined
  if (!(signed ? /^-?\d+$/ : /^\d+$/).test(typed)) return refusal(key, message)
  const kg = Number(typed)
  return (signed ? kg !== 0 : kg >= 1) && Number.isSafeInteger(kg) ? kg : refusal(key, message)
}

/** An amount typed in the project's currency as its minor units, blank for none. */
function cost(input: CommandInput, key: string, currency: string): number | undefined | LocalRefusal {
  const typed = text(input, key)
  if (typed === "") return undefined
  const minor = minorOf(typed, currency)
  return Number.isNaN(minor) ? refusal(key, `Give the cost as an amount in ${currency}, such as 1850.00, or leave it blank`) : minor
}

/** A wall-clock time typed on the project's clock as an instant. */
function instant(input: CommandInput, key: string, message: string): string | LocalRefusal {
  const at = instantOn(text(input, key), text(input, "timezone") || undefined)
  return at ?? refusal(key, message)
}

const isRefusal = (value: unknown): value is LocalRefusal => typeof value === "object" && value !== null && "message" in value && "path" in value

export const PICK_A_PROJECT = "Pick the project whose material it is"
export const PICK_A_FRACTION = "Pick the waste fraction"
export const PICK_A_DESTINATION = "Pick the station the load goes to"
export const NAME_THE_CARRIER = "Pick our vehicle or give the plate"
export const GIVE_THE_NET = "Give the net weight in whole kilograms"
export const GIVE_A_DELTA = "Give the kilograms the count found more, or less with a minus; not zero"
export const SAY_WHY = "Say why"

export function adjustStockBody(input: CommandInput, _record: BusinessRecord, context: MappingContext) {
  const projectId = serverId(input, "projectId", context, PICK_A_PROJECT)
  if (isRefusal(projectId)) return projectId
  const wasteFractionId = serverId(input, "wasteFractionId", context, PICK_A_FRACTION)
  if (isRefusal(wasteFractionId)) return wasteFractionId
  const deltaKg = kilograms(input, "deltaKg", GIVE_A_DELTA, { signed: true })
  if (isRefusal(deltaKg)) return deltaKg
  const note = text(input, "note")
  if (note === "") return refusal("note", "Say what the count found")
  return { projectId, wasteFractionId, deltaKg: deltaKg!, note }
}

export function sendLoadBody(input: CommandInput, record: BusinessRecord, context: MappingContext) {
  const projectId = serverId(input, "projectId", context, PICK_A_PROJECT)
  if (isRefusal(projectId)) return projectId
  const toStationId = serverId(input, "toStationId", context, PICK_A_DESTINATION)
  if (isRefusal(toStationId)) return toStationId
  if (text(input, "toStationId") === record.id) return refusal("toStationId", "A load goes to another station than the one it leaves")
  const wasteFractionId = serverId(input, "wasteFractionId", context, PICK_A_FRACTION)
  if (isRefusal(wasteFractionId)) return wasteFractionId
  const vehicle = text(input, "vehicleId")
  const vehicleId = vehicle === "" ? undefined : context.resolve.serverIdOf(vehicle)
  if (vehicle !== "" && vehicleId === undefined) return refusal("vehicleId", "Pick a vehicle the API holds")
  const plate = optional(text(input, "vehicleRegistration"))
  if (vehicleId === undefined && plate === undefined) return refusal("vehicleRegistration", NAME_THE_CARRIER)
  const provider = text(input, "serviceProviderId")
  const serviceProviderId = provider === "" ? undefined : context.resolve.serverIdOf(provider)
  if (provider !== "" && serviceProviderId === undefined) return refusal("serviceProviderId", "Pick a hauler the API holds")
  const departedAt = instant(input, "departedAt", "Give when the load left")
  if (isRefusal(departedAt)) return departedAt
  const netKg = kilograms(input, "netKg", GIVE_THE_NET)
  if (isRefusal(netKg)) return netKg
  const grossKg = kilograms(input, "grossKg", "Give the gross weight in whole kilograms, or leave it blank", { optional: true })
  if (isRefusal(grossKg)) return grossKg
  const tareKg = kilograms(input, "tareKg", "Give the tare in whole kilograms, or leave it blank", { optional: true })
  if (isRefusal(tareKg)) return tareKg
  if ((grossKg === undefined) !== (tareKg === undefined)) return refusal("tareKg", "Give the gross and the tare together, or neither")
  if (grossKg !== undefined && tareKg !== undefined && netKg !== grossKg - tareKg) return refusal("netKg", "The net is the gross less the tare")
  const currency = text(input, "currency") || "DKK"
  const haulCostMinor = cost(input, "haulCost", currency)
  if (isRefusal(haulCostMinor)) return haulCostMinor
  const disposalCostMinor = cost(input, "disposalCost", currency)
  if (isRefusal(disposalCostMinor)) return disposalCostMinor
  const outboundTicket = optional(text(input, "outboundTicket"))
  const note = optional(text(input, "note"))
  return {
    projectId,
    toStationId,
    wasteFractionId,
    ...(vehicleId === undefined ? {} : { vehicleId }),
    ...(serviceProviderId === undefined ? {} : { serviceProviderId }),
    ...(plate === undefined ? {} : { vehicleRegistration: plate }),
    departedAt,
    netKg: netKg!,
    ...(grossKg === undefined ? {} : { grossKg, tareKg }),
    ...(outboundTicket === undefined ? {} : { outboundTicket }),
    ...(haulCostMinor === undefined ? {} : { haulCostMinor }),
    ...(disposalCostMinor === undefined ? {} : { disposalCostMinor }),
    ...(note === undefined ? {} : { note }),
  }
}

/** The load a command names, by its server id: the dialog carries it as the API wrote it. */
function loadOf(input: CommandInput): string | LocalRefusal {
  const id = text(input, "loadId")
  return id === "" ? refusal("loadId", "Pick a load") : id
}

export function receiveLoadBody(input: CommandInput) {
  const loadId = loadOf(input)
  if (isRefusal(loadId)) return loadId
  const receivingTicket = text(input, "receivingTicket")
  if (receivingTicket === "") return refusal("receivingTicket", "Give the receiving site's ticket number")
  const receivedNetKg = kilograms(input, "receivedNetKg", "Give the receiving site's net in whole kilograms")
  if (isRefusal(receivedNetKg)) return receivedNetKg
  const receivedAt = instant(input, "receivedAt", "Give when the receiving site weighed it")
  if (isRefusal(receivedAt)) return receivedAt
  return { loadId, body: { receivingTicket, receivedNetKg: receivedNetKg!, receivedAt } }
}

export function reasonBody(required: boolean) {
  return (input: CommandInput) => {
    const loadId = loadOf(input)
    if (isRefusal(loadId)) return loadId
    const note = text(input, "note")
    if (required && note === "") return refusal("note", SAY_WHY)
    return { loadId, body: note === "" ? {} : { note } }
  }
}

/** A load command: the station is the row; the load and its body ride in the action's input. */
const loadAction = (verb: "receive" | "reconcile" | "dispute" | "cancel", toBody: RecordAction<OutboundLoad>["toBody"], refused: string): RecordAction<OutboundLoad> => ({
  toBody,
  run: (client, _stationId, body) => {
    const { loadId, body: payload } = body as { loadId: string; body: unknown }
    return post<OutboundLoad>(client, `/outbound-loads/${loadId}/${verb}`, payload).then((answer) => answer.body)
  },
  refused: () => refused,
})

export const HAUL_OUT_ACTIONS: Readonly<Record<string, RecordAction<unknown>>> = {
  [ADJUST_STOCK]: {
    toBody: adjustStockBody,
    run: (client, stationId, body) => post(client, `/unloading-stations/${stationId}/adjustments`, body).then((answer) => answer.body),
    refused: (record) => `The stock of ${record.name} was not adjusted`,
  },
  [SEND_LOAD]: {
    toBody: sendLoadBody,
    // The station the load leaves is the row the action is about.
    run: (client, stationId, body) => post<OutboundLoad>(client, "/outbound-loads", { ...(body as object), fromStationId: stationId }).then((answer) => answer.body),
    refused: (record) => `No load was sent from ${record.name}`,
  },
  [RECEIVE_LOAD]: loadAction("receive", receiveLoadBody, "The receipt was not recorded") as RecordAction<unknown>,
  [RECONCILE_LOAD]: loadAction("reconcile", reasonBody(false), "The load was not reconciled") as RecordAction<unknown>,
  [DISPUTE_LOAD]: loadAction("dispute", reasonBody(true), "The load was not disputed") as RecordAction<unknown>,
  [CANCEL_LOAD]: loadAction("cancel", reasonBody(true), "The load was not cancelled") as RecordAction<unknown>,
}

/** Sends one of the station's actions through the store; the row stays as it is. */
export function actOnStation(sendAction: SendAction, recordId: string, name: string, input: CommandInput): Promise<ActionOutcome> {
  return sendAction(STATIONS_MODULE.workspaceId, STATIONS_MODULE.moduleId, recordId, name, input)
}

/** What the station holds, by project and fraction. */
export function stationStock(client: Parameters<typeof get>[0], serverId: string): Promise<MaterialStockRow[]> {
  return get<MaterialStock>(client, `/unloading-stations/${serverId}/stock`).then((answer) => answer.rows)
}

/** The loads that left the station, newest first. */
export function stationLoads(client: Parameters<typeof get>[0], serverId: string): Promise<OutboundLoad[]> {
  return listAll<OutboundLoad>(client, "/outbound-loads", { fromStationId: serverId }).then((loads) => [...loads].reverse())
}

/** Whole kilograms as a person reads them: 18,400 kg. */
export const kg = (value: number): string => `${String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} kg`

/** A stock row as its line reads: "6,000 kg on hand · in 27,500 kg · out 20,000 kg · adjusted -1,500 kg". */
export function stockLine(row: Pick<MaterialStockRow, "inKg" | "outKg" | "adjustedKg" | "onHandKg" | "rejectedKg">): string {
  return [`${kg(row.onHandKg)} on hand`, `in ${kg(row.inKg)}`, `out ${kg(row.outKg)}`, ...(row.adjustedKg === 0 ? [] : [`adjusted ${kg(row.adjustedKg)}`]), ...(row.rejectedKg === 0 ? [] : [`${kg(row.rejectedKg)} under a rejected weight`])].join(" · ")
}

/** A load as its line reads: "AB 12 345 · 20,000 kg · received 19,200 kg (-4%)". */
export function loadLine(load: Pick<OutboundLoad, "vehicleRegistration" | "netKg" | "status" | "receipt">): string {
  const receipt = load.receipt === null ? [] : [`${load.receipt.ticket}: ${kg(load.receipt.netKg)} (${load.receipt.deviationPercent > 0 ? "+" : ""}${load.receipt.deviationPercent}%${load.receipt.withinTolerance ? "" : ", beyond the tolerance"})`]
  return [load.vehicleRegistration, kg(load.netKg), load.status, ...receipt].join(" · ")
}
