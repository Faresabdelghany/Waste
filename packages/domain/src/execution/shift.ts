// Time windows, shifts and breaks (O14 of #290). A stop is served inside a
// window of the day: its property's access hours and its agreement's promise,
// each optional, the stop's window being where the two overlap. A driver
// works one shift a day, from a time to a later one on the same day, with at
// most one break of so many minutes, taken anywhere in the shift or inside a
// window of its own. Every time is a time of day on the project's clock,
// `HH:MM`, read against the route's operating date where it is used.
//
// The optimiser is sent the windows as hard ones and the break as the
// driver's (packages/routing), on one timeline of seconds from the operating
// date's midnight; the shift's end is never sent as a bound, so a route too
// long for its shift is still planned, and told so: the over-shift verdict
// (`routeShift`) reads the route's start, the active Plan's drive and the
// waiting its windows made, the stop time and the break against the shift.

/** A break's minutes: the bounds the database and the wire hold it to. */
export const BREAK_MINUTES = { min: 1, max: 240 } as const

const DAY_SECONDS = 86_400

/** A window of the day, `HH:MM` to a later `HH:MM`. */
export type TimeWindow = { from: string; to: string }

/** A driver's working day: the shift and its one break, where it has one. */
export type DriverShift = {
  from: string
  to: string
  /** The break's length, or null for a shift without one. */
  breakMinutes: number | null
  /** Where in the day the break is taken; null is anywhere in the shift. Given only with `breakMinutes`. */
  breakWindow: TimeWindow | null
}

export const WINDOW_CLOSES_AFTER_IT_OPENS = "A window closes after it opens, on the same day"
export const SHIFT_ENDS_AFTER_IT_STARTS = "A shift ends after it starts, on the same day"
export const BREAK_WINDOW_NEEDS_MINUTES = "Give the break's minutes with its window"
export const BREAK_WITHIN_SHIFT = "The break's window lies within the shift"
export const BREAK_FITS = "The break's minutes fit inside its window and the shift"

/** Seconds from midnight of a time of day, `HH:MM` or Postgres's `HH:MM:SS`. */
export function secondsOfDay(time: string): number {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(time)
  if (match === null) throw new Error(`not a time of day: ${time}`)
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0)
}

/** A time of day as `HH:MM` from seconds since midnight, within the day. */
export function timeOfDay(seconds: number): string {
  const within = ((Math.floor(seconds / 60) * 60) % DAY_SECONDS + DAY_SECONDS) % DAY_SECONDS
  const hours = Math.floor(within / 3600)
  const minutes = Math.floor((within % 3600) / 60)
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`
}

/** Whether a window closes after it opens. */
export const windowIsOrdered = (window: TimeWindow): boolean => secondsOfDay(window.to) > secondsOfDay(window.from)

/** What is wrong with a shift, in the sentence the wire answers with, and the member it is about; null for a shift that holds. */
export function shiftProblem(shift: DriverShift): { sentence: string; path: "to" | "breakMinutes" | "breakWindow" } | null {
  const from = secondsOfDay(shift.from)
  const to = secondsOfDay(shift.to)
  if (to <= from) return { sentence: SHIFT_ENDS_AFTER_IT_STARTS, path: "to" }
  if (shift.breakWindow !== null) {
    if (shift.breakMinutes === null) return { sentence: BREAK_WINDOW_NEEDS_MINUTES, path: "breakMinutes" }
    if (!windowIsOrdered(shift.breakWindow)) return { sentence: WINDOW_CLOSES_AFTER_IT_OPENS, path: "breakWindow" }
    if (secondsOfDay(shift.breakWindow.from) < from || secondsOfDay(shift.breakWindow.to) > to) return { sentence: BREAK_WITHIN_SHIFT, path: "breakWindow" }
  }
  if (shift.breakMinutes !== null) {
    const room = shift.breakWindow === null ? to - from : secondsOfDay(shift.breakWindow.to) - secondsOfDay(shift.breakWindow.from)
    if (shift.breakMinutes * 60 > room) return { sentence: BREAK_FITS, path: "breakMinutes" }
  }
  return null
}

/**
 * A stop's window: where the windows that bound it overlap — its property's
 * access hours, its agreement's promise — null where none does, `disjoint`
 * where they do not overlap at all, so no time of the day serves the stop.
 */
export function stopWindow(windows: readonly (TimeWindow | null)[]): TimeWindow | null | "disjoint" {
  const given = windows.filter((window): window is TimeWindow => window !== null)
  if (given.length === 0) return null
  const from = Math.max(...given.map((window) => secondsOfDay(window.from)))
  const to = Math.min(...given.map((window) => secondsOfDay(window.to)))
  return to > from ? { from: timeOfDay(from), to: timeOfDay(to) } : "disjoint"
}

/** The seconds of the day a window spans, as the optimiser reads it. */
export const windowSeconds = (window: TimeWindow): [number, number] => [secondsOfDay(window.from), secondsOfDay(window.to)]

/** When a route leaves: its planned start, or its driver's shift's start without one; null where neither says. */
export function departureOf(plannedStartTime: string | null, shift: DriverShift | null): string | null {
  if (plannedStartTime !== null) return timeOfDay(secondsOfDay(plannedStartTime))
  return shift === null ? null : shift.from
}

/** What the over-shift verdict reads of a route. */
export type RouteShiftInput = {
  /** The planned driver's shift, or null. */
  shift: DriverShift | null
  plannedStartTime: string | null
  /** The active Plan's drive, or null where the route has none measured. */
  driveSeconds: number | null
  /** The time its active Plan's windows made the driver wait, or null where the Plan says nothing of it. */
  waitingSeconds: number | null
  /** Seconds at the stops still planned (`routeWorkload`). */
  stopSeconds: number
}

/** A route's day against its driver's shift. */
export type RouteShift = {
  /** The planned driver's shift, or null. */
  shift: DriverShift | null
  /** When the route leaves: the planned start, the shift's start without one; null where neither says. */
  startsAt: string | null
  /** The working time it plans: the drive, the waiting, the stop time and the break; null without a measured Plan. */
  workSeconds: number | null
  /** How far the route runs outside the shift — starting before it or ending after it — 0 within it; null without a shift or a measured Plan. */
  overShiftSeconds: number | null
}

/** The over-shift verdict: the route's planned day — leaving at its start, working its drive, waiting, stops and break — against its driver's shift. */
export function routeShift(input: RouteShiftInput): RouteShift {
  const { shift } = input
  const startsAt = departureOf(input.plannedStartTime, shift)
  if (input.driveSeconds === null) return { shift, startsAt, workSeconds: null, overShiftSeconds: null }
  const breakSeconds = (shift?.breakMinutes ?? 0) * 60
  const workSeconds = input.driveSeconds + (input.waitingSeconds ?? 0) + input.stopSeconds + breakSeconds
  if (shift === null || startsAt === null) return { shift, startsAt, workSeconds, overShiftSeconds: null }
  const start = secondsOfDay(startsAt)
  const early = Math.max(0, secondsOfDay(shift.from) - start)
  const late = Math.max(0, start + workSeconds - secondsOfDay(shift.to))
  return { shift, startsAt, workSeconds, overShiftSeconds: early + late }
}
