// The scale house's rules (M16a of #293, #404). A ticket is weighed in at its
// gross and out at its tare, from a second pass or from the register, and its
// net is the difference, which must be more than nothing. The load is split
// into lines, each a fraction and the municipality it came from (the
// kommunekode, four digits, as a Property spells it), and the lines sum to the
// net exactly: the split is how much of what came from where, never an
// estimate beside the weighing. A fraction and an origin are named once.
//
// A registered tare is found by the vehicle's plate, its trailer's and the
// container it carries, each as the match reads a plate (`plateKey`), and only
// by all three: a lorry's tare is not its tare with a skip on.
import { plateKey } from "../execution/weighbridge"
import { FOUR_DIGITS_PATTERN } from "../registry/address"

/** The lines one ticket may be split into. */
export const SCALE_TICKET_LINES_MAX = 20

/** A ticket's net from its two weighings, null where the tare is not less than the gross. */
export function netOf(grossKg: number, tareKg: number): number | null {
  const net = grossKg - tareKg
  return net > 0 ? net : null
}

/** One line of a ticket's split, as the rule reads it. */
export type ScaleTicketLineDraft = { wasteFractionId: string; originMunicipality: string | null; netKg: number }

/** What is wrong with a split, the line it is on where it is one line's. */
export type LinesIssue = { kind: "no-lines" } | { kind: "repeated"; index: number } | { kind: "bad-origin"; index: number } | { kind: "sum"; sum: number; netKg: number }

const municipality = new RegExp(FOUR_DIGITS_PATTERN)

/** The first thing wrong with a ticket's lines against its net, or null where they hold. */
export function linesIssue(lines: readonly ScaleTicketLineDraft[], netKg: number): LinesIssue | null {
  if (lines.length === 0) return { kind: "no-lines" }
  const seen = new Set<string>()
  for (const [index, line] of lines.entries()) {
    if (line.originMunicipality !== null && !municipality.test(line.originMunicipality)) return { kind: "bad-origin", index }
    const key = `${line.wasteFractionId} ${line.originMunicipality ?? ""}`
    if (seen.has(key)) return { kind: "repeated", index }
    seen.add(key)
  }
  const sum = lines.reduce((total, line) => total + line.netKg, 0)
  return sum === netKg ? null : { kind: "sum", sum, netKg }
}

/** A plate, a trailer's plate or a container's reference as the register keys it, null for none. */
export const tareKeyOf = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null
  const key = plateKey(value)
  return key === "" ? null : key
}

/** What a registered tare is found by. */
export type TareKey = { plate: string; trailerPlate: string | null; containerRef: string | null }

/** The registered tare of exactly this vehicle, trailer and container, by their keys; undefined where none is registered. */
export function registeredTare<T extends TareKey>(register: readonly T[], vehicle: { plate: string; trailerPlate: string | null; containerRef: string | null }): T | undefined {
  const plate = tareKeyOf(vehicle.plate)
  const trailerPlate = tareKeyOf(vehicle.trailerPlate)
  const containerRef = tareKeyOf(vehicle.containerRef)
  return register.find((entry) => tareKeyOf(entry.plate) === plate && tareKeyOf(entry.trailerPlate) === trailerPlate && tareKeyOf(entry.containerRef) === containerRef)
}
