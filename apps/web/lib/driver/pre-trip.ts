// The Driver App's pre-trip check (O13 of #290): what the check form holds —
// each item of the vehicle type's checklist passed unless the driver marks it
// a defect, with what was seen, and the odometer and the engine hours where
// the driver reads them — and the `pre-trip-check` body it becomes. Whether
// the answers hold against the list is the door's to say (ADR-0004): the form
// answers every item it was given, and a list the office changed meanwhile
// comes back as the command's rejection on the route.
import type { DriverVehicle } from "@waste/contracts/driver-commands"

import type { PilotBody, PilotCommandKind } from "./commands"
import type { QueueEntry } from "./command-queue"

/** One item as the form holds it: a defect or not, and what the driver saw as typed. */
export type CheckMark = { defect: boolean; note: string }

/** The form's state: the marks by item id, and the readings as typed. */
export type CheckForm = { marks: Readonly<Record<string, CheckMark>>; odometerKm: string; engineHours: string }

/** A whole reading as typed, or undefined for none: blank, a fraction, or below zero is no reading. */
export function wholeReading(value: string): number | undefined {
  const parsed = Number(value)
  return value.trim() !== "" && Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

/** The body of the check of a vehicle: every item of its checklist answered, in the list's order, and the readings given. */
export function preTripBody(vehicle: Pick<DriverVehicle, "id" | "checklist">, form: CheckForm): PilotBody<"pre-trip-check"> {
  const odometerKm = wholeReading(form.odometerKm)
  const engineHours = wholeReading(form.engineHours)
  return {
    vehicleId: vehicle.id,
    items: vehicle.checklist.map((item) => {
      const mark = form.marks[item.id]
      const note = mark?.note.trim() ?? ""
      return { itemId: item.id, passed: mark?.defect !== true, ...(mark?.defect === true && note !== "" ? { note } : {}) }
    }),
    ...(odometerKm === undefined ? {} : { odometerKm }),
    ...(engineHours === undefined ? {} : { engineHours }),
  }
}

/** What the confirm says the check will do: nothing found, or the defects and whether one takes the vehicle off the road. */
export function checkOutcome(vehicle: Pick<DriverVehicle, "label" | "checklist">, form: Pick<CheckForm, "marks">): string {
  const defects = vehicle.checklist.filter((item) => form.marks[item.id]?.defect === true)
  if (defects.length === 0) return `Every item passed: ${vehicle.label} is fit to drive.`
  const count = defects.length === 1 ? "One defect" : `${defects.length} defects`
  return defects.some((item) => item.critical) ? `${count}, one of them critical: ${vehicle.label} goes to maintenance and the office is told.` : `${count}: the office is told, and ${vehicle.label} stays in service.`
}

const CHECK: PilotCommandKind = "pre-trip-check"

/** Whether a check of the vehicle for the route waits in the queue: the form shows it sending, not a second check. */
export function checkWaiting(waiting: readonly QueueEntry[], routeId: string, vehicleId: string): boolean {
  return waiting.some((entry) => entry.command.routeId === routeId && entry.command.kind === CHECK && (entry.command.body as { vehicleId?: unknown }).vehicleId === vehicleId)
}
