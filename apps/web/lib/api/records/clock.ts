// A project's clock (Issue #181): the wall-clock time a form spells
// (`YYYY-MM-DDTHH:mm`, a datetime-local input's value) read as an instant in
// the project's timezone, and an instant shown back on that clock — 05:30 in
// Copenhagen is 03:30Z in summer and 04:30Z in winter, whatever the browser's
// timezone. A project the store does not hold, or a zone Intl does not know,
// falls back on the browser's clock.
import type { BusinessRecord } from "@/lib/data/business-modules"

import { typed, type MappingContext } from "./adapter"

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

/** The wall clock an instant reads in a timezone, by its parts. */
function partsIn(instant: Date, timezone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(instant)
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((candidate) => candidate.type === type)?.value)
  return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour"), minute: part("minute"), second: part("second") }
}

/** How far a timezone's clock runs ahead of UTC at an instant, in milliseconds. */
function offsetAt(instantMs: number, timezone: string): number {
  const wall = partsIn(new Date(instantMs), timezone)
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(instantMs / 1000) * 1000
}

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

/** The form's wall-clock time (`YYYY-MM-DDTHH:mm`) an instant reads on the project's clock. */
export function wallClockIn(instant: string, timezone: string | undefined): string {
  const date = new Date(instant)
  const zone = knownZone(timezone)
  if (zone === undefined) return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
  const wall = partsIn(date, zone)
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`
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
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second)
  // Twice: the offset at the first guess may be the other side of a clock change.
  const first = asUtc - offsetAt(asUtc, zone)
  return new Date(asUtc - offsetAt(first, zone)).toISOString()
}

/** An instant as a person reads it on the project's clock: `2026-10-01 05:30`. */
export const shownOn = (instant: string, timezone: string | undefined): string => wallClockIn(instant, timezone).replace("T", " ")

/** The timezone of the project a record is in — its typed `projectId`, else its scope — from the organisation the store loaded; undefined when the store holds no such project. */
export function projectTimezoneOf(record: Pick<BusinessRecord, "submittedValues" | "projectIds">, context: MappingContext): string | undefined {
  const webId = typed(record, "projectId") ?? record.projectIds?.[0]
  const serverId = webId === undefined ? undefined : context.resolve.serverIdOf(webId)
  const project = serverId === undefined ? undefined : context.resolve.byServerId(serverId)
  return project === undefined ? undefined : typed(project, "timezone")
}
