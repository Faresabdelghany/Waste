// Time windows and shifts between the wire and the row (O14 of #290): a
// window is one member on the wire and two `time` columns in the database, a
// shift one member and five. A body's member absent leaves the columns alone,
// null clears them all, and a value writes every column, so a window or a
// shift is always written whole and never left half another's. A read spells
// Postgres's `HH:MM:SS` as the wire's `HH:MM`.
import type { DriverShift, TimeWindow } from "@waste/contracts/shifts"
import { shiftOf } from "@waste/db/commands/stop-timing"

export { shiftOf }

/** The two columns of a stored window as the wire's, or null where they hold none. */
export const serviceWindowOf = (row: { serviceWindowStart: string | null; serviceWindowEnd: string | null }): TimeWindow | null =>
  row.serviceWindowStart === null || row.serviceWindowEnd === null ? null : { from: row.serviceWindowStart.slice(0, 5), to: row.serviceWindowEnd.slice(0, 5) }

/** A body's service window as the columns it writes: none where the body left it out. */
export function serviceWindowValues(window: TimeWindow | null | undefined): { serviceWindowStart?: string | null; serviceWindowEnd?: string | null } {
  if (window === undefined) return {}
  return { serviceWindowStart: window?.from ?? null, serviceWindowEnd: window?.to ?? null }
}

/** A body's shift as the five columns it writes: none where the body left it out. */
export function shiftValues(shift: DriverShift | null | undefined): {
  shiftStart?: string | null
  shiftEnd?: string | null
  breakMinutes?: number | null
  breakWindowStart?: string | null
  breakWindowEnd?: string | null
} {
  if (shift === undefined) return {}
  return {
    shiftStart: shift?.from ?? null,
    shiftEnd: shift?.to ?? null,
    breakMinutes: shift?.breakMinutes ?? null,
    breakWindowStart: shift?.breakWindow?.from ?? null,
    breakWindowEnd: shift?.breakWindow?.to ?? null,
  }
}
