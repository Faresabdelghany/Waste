// When a driver or a vehicle is not there, on the Pilot (O6 of #290): a
// driver's absences and a vehicle's unavailability, read and written from the
// row's details in Fleet. The periods are not rows of the store — nothing
// lists them but their driver or vehicle — so they are read through the
// client beside the row (`useRowHistory`), and recorded or removed as the
// row's actions (adapter.ts, `actions`), which answer the period, never the
// row, through the typed wrappers below. The wire shapes are the contracts'
// (`@waste/contracts/availability`), imported as types.
//
// A form spells a period by its last day away, the wire by its first day back
// (`firstDayOut`, planning.ts), a blank last day being a return not known
// yet. What refuses a period over the work already planned is never this: the
// API records it whatever is planned on its days, and refuses instead the
// commands that name the driver or the vehicle afresh.
import type { DriverAbsence, VehicleUnavailability } from "@waste/contracts/availability"
import { periodPhrase } from "@waste/domain/resources/availability"
import { DRIVER_ABSENCE_REASONS, VEHICLE_UNAVAILABILITY_REASONS } from "@waste/domain/resources/vocabulary"
import { isIsoDate } from "@waste/domain/route-schemes/recurrence"

import { create, listAll, remove } from "../client"
import { said, statusLabel, type Client, type CommandInput, type LocalRefusal, type RecordAction } from "./adapter"
import { refusal } from "./places"
import { firstDayOut } from "./planning"
import type { ActionOutcome, SendAction } from "./server-records"

/** The two modules whose rows the periods belong to; spelled here, since fleet.ts imports this module. */
const DRIVERS = { workspaceId: "fleet", moduleId: "drivers" } as const
const VEHICLES = { workspaceId: "fleet", moduleId: "vehicles" } as const

export const RECORD_ABSENCE = "record-absence"
export const REMOVE_ABSENCE = "remove-absence"
export const RECORD_UNAVAILABILITY = "record-unavailability"
export const REMOVE_UNAVAILABILITY = "remove-unavailability"

/** A period as a row's details read it: a driver's absence or a vehicle's unavailability alike. */
export type AwayPeriod = { id: string; validFrom: string; validTo: string | null; reason: string; note: string | null }

/** What the record form hands the action: the first day away, the last (blank while not known), why, and a note. */
export type AwayInput = { validFrom: string; lastDay: string; reason: string; note: string }

/** What the last day is told when it comes before the first. */
export const LAST_DAY_ON_OR_AFTER = "The last day away is on or after the first"

/** The body of a period's create, from the form, or a refusal naming the field. `reasons` are the wire's tokens. */
export function periodBody(input: CommandInput, reasons: readonly string[]): { validFrom: string; validTo: string | null; reason: string; note?: string } | LocalRefusal {
  const validFrom = said(input, "validFrom")
  if (validFrom === undefined || !isIsoDate(validFrom)) return refusal("validFrom", "Give the first day away")
  const lastDay = said(input, "lastDay")
  if (lastDay !== undefined && !isIsoDate(lastDay)) return refusal("lastDay", "Give the last day away as a date, or leave it blank while it is not known")
  if (lastDay !== undefined && lastDay < validFrom) return refusal("lastDay", LAST_DAY_ON_OR_AFTER)
  const reason = said(input, "reason")
  if (reason === undefined || !reasons.includes(reason)) return refusal("reason", `Say why: ${reasons.map(statusLabel).join(", ")}`)
  const note = said(input, "note")
  return { validFrom, validTo: lastDay === undefined ? null : firstDayOut(lastDay), reason, ...(note === undefined ? {} : { note }) }
}

/** The period a removal names, by its server id. */
function removalBody(input: CommandInput): { periodId: string } | LocalRefusal {
  const periodId = said(input, "periodId")
  return periodId === undefined ? refusal("periodId", "Name the period to remove") : { periodId }
}

const periodIdOf = (body: unknown): string => (body as { periodId: string }).periodId

/** The periods earliest first: the order a person reads days in. */
const byFirstDay = <P extends AwayPeriod>(periods: P[]): P[] => [...periods].sort((a, b) => a.validFrom.localeCompare(b.validFrom) || a.id.localeCompare(b.id))

/** A driver's absences, by the driver's server id. */
export function driverAbsences(client: Client, serverId: string): Promise<DriverAbsence[]> {
  return listAll<DriverAbsence>(client, "/driver-absences", { driverId: serverId }).then(byFirstDay)
}

/** A vehicle's or a trailer's periods out of use, by its server id. */
export function vehicleUnavailability(client: Client, serverId: string): Promise<VehicleUnavailability[]> {
  return listAll<VehicleUnavailability>(client, "/vehicle-unavailability", { vehicleId: serverId }).then(byFirstDay)
}

/** A driver's two actions: record an absence, which answers it, and remove one, which answers nothing. */
export const DRIVER_AVAILABILITY_ACTIONS: Readonly<Record<string, RecordAction<unknown>>> = {
  [RECORD_ABSENCE]: {
    toBody: (input) => periodBody(input, DRIVER_ABSENCE_REASONS),
    run: (client, serverId, body) => create<DriverAbsence>(client, "/driver-absences", { ...(body as object), driverId: serverId }).then((created) => created.body),
    refused: (record) => `The absence of ${record.name} was not recorded`,
  },
  [REMOVE_ABSENCE]: {
    toBody: removalBody,
    run: (client, _serverId, body) => remove(client, `/driver-absences/${periodIdOf(body)}`).then(() => null),
    refused: (record) => `The absence of ${record.name} was not removed`,
  },
}

/** A vehicle's two actions, as a driver's. */
export const VEHICLE_AVAILABILITY_ACTIONS: Readonly<Record<string, RecordAction<unknown>>> = {
  [RECORD_UNAVAILABILITY]: {
    toBody: (input) => periodBody(input, VEHICLE_UNAVAILABILITY_REASONS),
    run: (client, serverId, body) => create<VehicleUnavailability>(client, "/vehicle-unavailability", { ...(body as object), vehicleId: serverId }).then((created) => created.body),
    refused: (record) => `The time ${record.name} is out of use was not recorded`,
  },
  [REMOVE_UNAVAILABILITY]: {
    toBody: removalBody,
    run: (client, _serverId, body) => remove(client, `/vehicle-unavailability/${periodIdOf(body)}`).then(() => null),
    refused: (record) => `The time ${record.name} is out of use was not removed`,
  },
}

/** Records a driver's absence through the store's `sendAction`; the driver's row stays as it is. */
export function recordDriverAbsence(sendAction: SendAction, recordId: string, input: AwayInput): Promise<ActionOutcome<DriverAbsence>> {
  return sendAction(DRIVERS.workspaceId, DRIVERS.moduleId, recordId, RECORD_ABSENCE, input) as Promise<ActionOutcome<DriverAbsence>>
}

/** Removes one of a driver's absences, by its server id. */
export function removeDriverAbsence(sendAction: SendAction, recordId: string, periodId: string): Promise<ActionOutcome<null>> {
  return sendAction(DRIVERS.workspaceId, DRIVERS.moduleId, recordId, REMOVE_ABSENCE, { periodId }) as Promise<ActionOutcome<null>>
}

/** Records when a vehicle is out of use through the store's `sendAction`; the vehicle's row stays as it is. */
export function recordVehicleUnavailability(sendAction: SendAction, recordId: string, input: AwayInput): Promise<ActionOutcome<VehicleUnavailability>> {
  return sendAction(VEHICLES.workspaceId, VEHICLES.moduleId, recordId, RECORD_UNAVAILABILITY, input) as Promise<ActionOutcome<VehicleUnavailability>>
}

/** Removes one of a vehicle's periods out of use, by its server id. */
export function removeVehicleUnavailability(sendAction: SendAction, recordId: string, periodId: string): Promise<ActionOutcome<null>> {
  return sendAction(VEHICLES.workspaceId, VEHICLES.moduleId, recordId, REMOVE_UNAVAILABILITY, { periodId }) as Promise<ActionOutcome<null>>
}

/** A period as its line reads: "Mon 12 Oct – Wed 14 Oct · Holiday · Autumn break", "From Mon 2 Nov · Leave". */
export function awayLine(period: AwayPeriod): string {
  const phrase = periodPhrase(period)
  return [`${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`, statusLabel(period.reason), period.note].filter((part) => part !== null && part !== "").join(" · ")
}
