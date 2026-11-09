// A project's clock (Issue #181) as the web reads it: the day an instant falls
// on, the wall-clock time a form spells (`YYYY-MM-DDTHH:mm`, a datetime-local
// input's value) read as an instant in the project's timezone, and an instant
// shown back on that clock — 05:30 in Copenhagen is 03:30Z in summer and
// 04:30Z in winter, whatever the browser's timezone. The arithmetic is the
// domain's (@waste/domain/clock); what is the web's is the fallback: a project
// the store does not hold, or a zone Intl does not know, reads on the
// browser's clock rather than throwing.
import { dayInTimezone, instantOnDay, type WallClock, wallClockIn as wallClockOf } from "@waste/domain/clock"
import { formatDayMonth } from "@waste/domain/days"

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

/** A timezone Intl knows, or undefined, so a project's unknown zone falls back on the browser's clock rather than throwing. */
function knownZone(timezone: string | undefined): string | undefined {
  if (!timezone) return undefined
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone })
    return timezone
  } catch {
    return undefined
  }
}

const pad = (value: number) => String(value).padStart(2, "0")

/** The day as the browser's calendar has it. */
const localDay = (now: Date): string => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

/**
 * The day `now` falls on in a project's timezone, `YYYY-MM-DD`: the day a
 * period is read against, a version read as in force on; the browser's own
 * day for a project without one, or one Intl does not know.
 */
export function dayIn(now: Date, timezone: string | undefined): string {
  if (timezone) {
    try {
      return dayInTimezone(now, timezone)
    } catch {
      // A timezone Intl does not know: the browser's day below.
    }
  }
  return localDay(now)
}

/** The wall clock an instant reads on the project's clock, or on the browser's where the zone is not one. */
function wallOn(instant: string, timezone: string | undefined): WallClock {
  const date = new Date(instant)
  const zone = knownZone(timezone)
  if (zone !== undefined) return wallClockOf(date, zone)
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds() }
}

const dayOfWall = (wall: WallClock): string => `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`
const timeOfWall = (wall: WallClock): string => `${pad(wall.hour)}:${pad(wall.minute)}`

/** The form's wall-clock time (`YYYY-MM-DDTHH:mm`) an instant reads on the project's clock. */
export function wallClockIn(instant: string, timezone: string | undefined): string {
  const wall = wallOn(instant, timezone)
  return `${dayOfWall(wall)}T${timeOfWall(wall)}`
}

/** The instant a form's wall-clock time is on the project's clock; an instant with its own offset stands as it is; undefined for text that is neither. */
export function instantOn(value: string, timezone: string | undefined): string | undefined {
  const match = WALL_CLOCK.exec(value)
  if (match === null) {
    const instant = new Date(value)
    return /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) && !Number.isNaN(instant.getTime()) ? instant.toISOString() : undefined
  }
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0))
  const zone = knownZone(timezone)
  if (zone === undefined) return new Date(year, month - 1, day, hour, minute, second).toISOString()
  const onDay = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10)
  return instantOnDay(onDay, hour * 3600 + minute * 60 + second, zone).toISOString()
}

/** An instant as a person reads it on the project's clock: `2026-10-01 05:30`. */
export const shownOn = (instant: string, timezone: string | undefined): string => wallClockIn(instant, timezone).replace("T", " ")

/** An instant as a list reads it on the project's clock, its day and time without the year: `24 Oct, 04:32` (#255). */
export function dayAndTimeOn(instant: string, timezone: string | undefined): string {
  const wall = wallOn(instant, timezone)
  return `${formatDayMonth(dayOfWall(wall))}, ${timeOfWall(wall)}`
}

/** The time of day an instant reads on the project's clock: `04:32` (#255). */
export const timeOn = (instant: string, timezone: string | undefined): string => timeOfWall(wallOn(instant, timezone))
