// The project's clock: an instant as the day and the time it reads in a
// project's timezone, and a time of a project's day back as an instant. A
// rule judges on a `YYYY-MM-DD` day and never on an instant, because an
// instant sorts after the day it falls on and would read a licence as expired
// on its last valid day; and the day an instant falls on depends on where the
// project is: `2026-09-05T22:30Z` is still the 5th in London and already the
// 6th in Copenhagen. The timezone is `project.timezone`, an IANA name the
// contracts checked, read through `Intl.DateTimeFormat`, whose parts are
// assembled here rather than trusted as a locale's own spelling.
//
// A timezone that is not one is a RangeError from Intl and stays one: the
// contracts hold `project.timezone` to an IANA name on the way in, so a bad
// value here is a bug and not a client's. A reader that has to answer for an
// unknown zone (the web, on a project it has not read) catches it itself.
//
// A window is half-open, its end the first instant out of it, so the day a
// window ends on is not the day its end falls on: a window ending at midnight
// in Copenhagen ends on the day before, and a driver whose licence runs out
// that day is still meant to be driving inside it. `lastDayInside` renders the
// last instant inside the window, a millisecond before the end, the wire's
// precision.

/** What a window of instants whose end comes before its start is told. */
export const OCCURRED_WINDOW_ORDERED = "to is the end of the window, so it comes on or after from"

/** Whether a window of instants, both ends in, runs forward: its end on or after its start. A half-given window is not judged. */
export const instantWindowOrdered = (window: { from?: string; to?: string }): boolean => window.from === undefined || window.to === undefined || Date.parse(window.to) >= Date.parse(window.from)

/** A wall clock's reading, every part a whole number. */
export type WallClock = { year: number; month: number; day: number; hour: number; minute: number; second: number }

const pad = (value: number, width = 2): string => String(value).padStart(width, "0")

// Building a formatter is the costly part, and a read renders hundreds of rows against a handful of projects.
const formatters = new Map<string, Intl.DateTimeFormat>()
function wallFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

export function wallClockIn(instant: Date, timeZone: string): WallClock {
  const parts = wallFormatter(timeZone).formatToParts(instant)
  const part = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((candidate) => candidate.type === type)
    if (found === undefined) throw new Error(`wallClockIn: Intl gave no ${type} for ${instant.toISOString()} in ${timeZone}`)
    return Number(found.value)
  }
  return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour"), minute: part("minute"), second: part("second") }
}

export function dayInTimezone(instant: Date, timeZone: string): string {
  const wall = wallClockIn(instant, timeZone)
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`
}

/** The time of day `instant` reads in `timeZone`, to the minute: `06:00`. */
export function timeInTimezone(instant: Date, timeZone: string): string {
  const wall = wallClockIn(instant, timeZone)
  return `${pad(wall.hour)}:${pad(wall.minute)}`
}

/** The `YYYY-MM-DD` day the last instant inside a half-open window ending at `end` falls on in `timeZone`: a millisecond before `end`. */
export function lastDayInside(end: Date, timeZone: string): string {
  return dayInTimezone(new Date(end.getTime() - 1), timeZone)
}

/** How far `timeZone`'s clock runs ahead of UTC at `instant`, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const wall = wallClockIn(new Date(instant), timeZone)
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  return asUtc - Math.floor(instant / 1000) * 1000
}

const DAY_MS = 86_400_000

/**
 * The instant a time of a project's day falls at: `seconds` after midnight of
 * `day` on `timeZone`'s clock, where a Plan's departure and a stop's window
 * are spelled. The offset is the one in force at that time of that day, so a
 * summer morning is summer time on the day the clocks change; a time the
 * change skips is read in the offset before it, and a time it repeats in the
 * offset after it — Postgres's reading of `timestamp at time zone`, which
 * `instantOnClock` (@waste/db/query/project-clock) spells.
 */
export function instantOnDay(day: string, seconds: number, timeZone: string): Date {
  const local = Date.parse(`${day}T00:00:00Z`) + seconds * 1000
  // A clock changes at most once a day, so the offsets a day either side are the two this time can be read in.
  const before = offsetAt(local - DAY_MS, timeZone)
  const after = offsetAt(local + DAY_MS, timeZone)
  const readsAs = (offset: number) => offsetAt(local - offset, timeZone) === offset
  // Read in the offset after where it holds (every time but a skipped one), else the offset before (the hour the clocks skip).
  return new Date(local - (readsAs(after) ? after : before))
}
