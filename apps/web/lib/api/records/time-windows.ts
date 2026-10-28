// Time windows and shifts between the forms and the wire (O14 of #290). A
// window is two time fields on a form — a property's access hours, an
// agreement's promised window — and one member on the wire, both ends or
// neither; a driver's shift is five fields and one member, its break with it.
// Each goes out whole whenever any of its fields moved, so the server never
// holds half of one. The rules and their sentences are the domain's
// (@waste/domain/execution/shift), refused here at the field before the API
// would refuse the body.
import type { DriverShift, TimeWindow } from "@waste/contracts/shifts"
import { shiftProblem, WINDOW_CLOSES_AFTER_IT_OPENS, windowIsOrdered } from "@waste/domain/execution/shift"

import type { BusinessRecord } from "@/lib/data/business-modules"

import { isLocalRefusal, typed, type LocalRefusal } from "./adapter"
import { refusal } from "./places"

/** What a window with one end is told, at the end left blank. */
export const BOTH_ENDS_OR_NEITHER = "Give both ends of the window, or neither"

/** The form's keys a window is typed in. */
export type WindowKeys = { from: string; to: string }

const isTime = (value: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)

/** `07:00–12:00`: a window as a fact reads it. */
export const windowFact = (window: TimeWindow): string => `${window.from}–${window.to}`

/** A window as the form's two fields, blank for none. */
export const windowValues = (window: TimeWindow | null, keys: WindowKeys): Record<string, string> => ({ [keys.from]: window?.from ?? "", [keys.to]: window?.to ?? "" })

/** The window the form's two fields say: null where both are blank, a refusal at the field that is wrong. */
export function windowOf(record: BusinessRecord, keys: WindowKeys): TimeWindow | null | LocalRefusal {
  const from = typed(record, keys.from)
  const to = typed(record, keys.to)
  if (from === undefined && to === undefined) return null
  if (from === undefined) return refusal(keys.from, BOTH_ENDS_OR_NEITHER)
  if (to === undefined) return refusal(keys.to, BOTH_ENDS_OR_NEITHER)
  if (!isTime(from)) return refusal(keys.from, "A time of day is HH:MM")
  if (!isTime(to)) return refusal(keys.to, "A time of day is HH:MM")
  const window = { from, to }
  return windowIsOrdered(window) ? window : refusal(keys.to, WINDOW_CLOSES_AFTER_IT_OPENS)
}

/** The driver form's shift fields. */
export const SHIFT_KEYS = { from: "shiftStart", to: "shiftEnd", breakMinutes: "breakMinutes", breakFrom: "breakWindowStart", breakTo: "breakWindowEnd" } as const

/** `07:00–15:00 · 30 min break 11:00–12:30`: a shift as a fact reads it. */
export function shiftFact(shift: DriverShift): string {
  const hours = `${shift.from}–${shift.to}`
  if (shift.breakMinutes === null) return hours
  return `${hours} · ${shift.breakMinutes} min break${shift.breakWindow === null ? "" : ` ${windowFact(shift.breakWindow)}`}`
}

/** A shift as the driver form's fields, blank for none. */
export const shiftValues = (shift: DriverShift | null): Record<string, string> => ({
  ...windowValues(shift === null ? null : { from: shift.from, to: shift.to }, SHIFT_KEYS),
  [SHIFT_KEYS.breakMinutes]: shift?.breakMinutes === null || shift === null ? "" : String(shift.breakMinutes),
  ...windowValues(shift?.breakWindow ?? null, { from: SHIFT_KEYS.breakFrom, to: SHIFT_KEYS.breakTo }),
})

/** Where the domain's sentence about a shift is told on the form. */
const SHIFT_FIELD = { to: SHIFT_KEYS.to, breakMinutes: SHIFT_KEYS.breakMinutes, breakWindow: SHIFT_KEYS.breakTo } as const

/** The shift the driver form's fields say: null where the shift is blank, a refusal at the field that is wrong. */
export function shiftOf(record: BusinessRecord): DriverShift | null | LocalRefusal {
  const hours = windowOf(record, SHIFT_KEYS)
  const minutesText = typed(record, SHIFT_KEYS.breakMinutes)
  const breakWindow = windowOf(record, { from: SHIFT_KEYS.breakFrom, to: SHIFT_KEYS.breakTo })
  if (isLocalRefusal(hours)) return hours
  if (isLocalRefusal(breakWindow)) return breakWindow
  if (hours === null) return minutesText === undefined && breakWindow === null ? null : refusal(SHIFT_KEYS.from, "A break belongs to a shift: give the shift's hours")
  let breakMinutes: number | null = null
  if (minutesText !== undefined) {
    if (!/^\d+$/.test(minutesText) || Number(minutesText) < 1) return refusal(SHIFT_KEYS.breakMinutes, "A break is a whole number of minutes, 1 or more")
    breakMinutes = Number(minutesText)
  }
  const shift: DriverShift = { from: hours.from, to: hours.to, breakMinutes, breakWindow }
  const problem = shiftProblem(shift)
  return problem === null ? shift : refusal(SHIFT_FIELD[problem.path], problem.sentence)
}
