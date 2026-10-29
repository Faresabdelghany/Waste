// A vehicle's pre-trip checks and defects on the Pilot (O13 of #290), read
// and resolved from the vehicle's details in Fleet. Like its periods out of
// use (availability.ts), they are not rows of the store — nothing lists them
// but their vehicle — so they are read through the client beside the row
// (`useRowHistory`), and a defect is resolved as the row's action, which
// answers the defect, never the row. The wire shapes are the contracts'
// (`@waste/contracts/pre-trip`), imported as types.
//
// Resolving a defect leaves the vehicle's status as it is: a vehicle a
// critical defect took off the road is set active again by its own edit.
import type { PreTripCheck, VehicleDefect } from "@waste/contracts/pre-trip"

import { command, listAll } from "../client"
import { said, type Client, type CommandInput, type LocalRefusal, type RecordAction } from "./adapter"
import { refusal } from "./places"
import type { ActionOutcome, SendAction } from "./server-records"

/** The module whose rows the defects belong to; spelled here, since fleet.ts imports this module. */
const VEHICLES = { workspaceId: "fleet", moduleId: "vehicles" } as const

export const RESOLVE_DEFECT = "resolve-defect"

/** A vehicle's defects, open first, then by when they were found, newest first. */
export function vehicleDefects(client: Client, serverId: string): Promise<VehicleDefect[]> {
  return listAll<VehicleDefect>(client, "/vehicle-defects", { vehicleId: serverId }).then(defectsInOrder)
}

/** Open before resolved, and within each the newest found first: the order the office works them in. */
export const defectsInOrder = (defects: VehicleDefect[]): VehicleDefect[] => [...defects].sort((a, b) => (a.status === b.status ? b.foundAt.localeCompare(a.foundAt) || b.id.localeCompare(a.id) : a.status === "open" ? -1 : 1))

/** A vehicle's checks, newest first. */
export function vehicleChecks(client: Client, serverId: string): Promise<PreTripCheck[]> {
  return listAll<PreTripCheck>(client, "/pre-trip-checks", { vehicleId: serverId }).then((checks) => [...checks].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id)))
}

/** The defect a resolve names by its server id, and what was done where the office says. */
function resolveBody(input: CommandInput): { defectId: string; note?: string } | LocalRefusal {
  const defectId = said(input, "defectId")
  if (defectId === undefined) return refusal("defectId", "Name the defect to resolve")
  const note = said(input, "note")
  return note === undefined ? { defectId } : { defectId, note }
}

/** A vehicle's one defect action: resolve one, which answers the defect. */
export const VEHICLE_DEFECT_ACTIONS: Readonly<Record<string, RecordAction<unknown>>> = {
  [RESOLVE_DEFECT]: {
    toBody: resolveBody,
    run: (client, _serverId, body) => {
      const { defectId, note } = body as { defectId: string; note?: string }
      return command<VehicleDefect>(client, `/vehicle-defects/${defectId}/resolve`, note === undefined ? {} : { note })
    },
    refused: (record) => `The defect on ${record.name} was not resolved`,
  },
}

/** Resolves one of a vehicle's defects through the store's `sendAction`; the vehicle's row stays as it is. */
export function resolveVehicleDefect(sendAction: SendAction, recordId: string, defectId: string, note: string): Promise<ActionOutcome<VehicleDefect>> {
  return sendAction(VEHICLES.workspaceId, VEHICLES.moduleId, recordId, RESOLVE_DEFECT, { defectId, note }) as Promise<ActionOutcome<VehicleDefect>>
}

/** A defect as its line reads: "Brakes · critical · Pulls to the left". */
export function defectLine(defect: Pick<VehicleDefect, "label" | "critical" | "note">): string {
  return [defect.label, defect.critical ? "critical" : null, defect.note].filter((part) => part !== null && part !== "").join(" · ")
}

/** A check as its line reads: "No defects · 182,400 km", "2 defects · 6,120 h". */
export function checkLine(check: Pick<PreTripCheck, "defectCount" | "odometerKm" | "engineHours">): string {
  const found = check.defectCount === 0 ? "No defects" : check.defectCount === 1 ? "1 defect" : `${check.defectCount} defects`
  const grouped = (value: number) => value.toLocaleString("en-GB")
  return [found, check.odometerKm === null ? null : `${grouped(check.odometerKm)} km`, check.engineHours === null ? null : `${grouped(check.engineHours)} h`].filter((part) => part !== null).join(" · ")
}
