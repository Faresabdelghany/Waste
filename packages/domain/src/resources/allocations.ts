// A Vehicle Allocation's window (Issue #101): the instants a vehicle is
// reserved from and to, the end strictly after the start, and the window a
// list asks over, both ends given or neither. An allocation is created
// planned or confirmed; released is the command's alone.
import { count } from "../text"
import type { AllocationStatus } from "./vocabulary"

/** The statuses only a command reaches: a create never names them. */
export const COMMAND_ONLY_STATUSES = ["released"] as const satisfies readonly AllocationStatus[]

/** What a backwards or empty window is told, at the end, the bound a caller can move. */
export const WINDOW_ENDS_AFTER_IT_STARTS = "plannedTo is the instant the reservation ends, so it comes after plannedFrom"

/** The end comes after the start, strictly; a half-seen pair is not judged. */
export function windowOrdered(value: { plannedFrom?: string; plannedTo?: string }): boolean {
  if (value.plannedFrom === undefined || value.plannedTo === undefined) return true
  return Date.parse(value.plannedTo) > Date.parse(value.plannedFrom)
}

/** What a query giving one end of the overlapping window is told, at the other. */
export const BOTH_ENDS_OF_THE_WINDOW = "Give both overlappingFrom and overlappingTo or neither"

/** What a query whose overlapping window runs backwards is told. */
export const OVERLAPPING_WINDOW_ORDERED = "overlappingTo is the end of the window, so it comes after overlappingFrom"

/** What taking a row out of service under live allocations is refused with: "2 live allocations name this vehicle; release them first". */
export const liveAllocationsName =
  (what: "vehicle" | "driver") =>
  (rows: number): string =>
    `${count(rows, "live allocation")} ${rows === 1 ? "names" : "name"} this ${what}; release ${rows === 1 ? "it" : "them"} first`
