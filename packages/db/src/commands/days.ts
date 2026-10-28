// An instant as the day it falls on, on a project's clock (Issue #101,
// slice 6; lifted here from `apps/api/src/routes/days.ts` with the commands
// the worker runs, Issue #112 part B). The licence rule of
// @waste/domain/resources/licence judges a driver on a `YYYY-MM-DD` day and
// refuses anything else, an instant included, because an instant sorts after
// the day it falls on and would read a licence as expired on its last valid
// day. What a process holds is an instant — an allocation's `plannedTo`, the
// request's or the job's clock for "today", a ticket's `closedAt` — and the
// day it falls on depends on where the project is: `2026-09-05T22:30Z` is
// still the 5th in London and already the 6th in Copenhagen. So the day is
// rendered in the project's timezone (`project.timezone`, an IANA name the
// contracts checked), through `Intl.DateTimeFormat`, whose parts are
// assembled here rather than trusted as a locale's own spelling.
//
// A timezone that is not one is a RangeError from Intl and stays one: the
// contracts hold `project.timezone` to an IANA name on the way in, so a bad
// value here is a bug and not a client's, and becomes the server's 500 or the
// job's failure.
//
// A window is half-open, `plannedTo` the first instant out of it, so the day
// a window ends on is not the day `plannedTo` falls on: a window ending at
// midnight in Copenhagen ends on the day before, and a driver whose licence
// runs out that day is still meant to be driving inside it. `lastDayInside`
// renders the last instant inside the window — a millisecond before the end,
// the wire's precision — and is what the allocation's licence rule is handed.

/** The `YYYY-MM-DD` day `instant` falls on in `timeZone`. */
export function dayInTimezone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant)
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((candidate) => candidate.type === type)
    if (found === undefined) throw new Error(`dayInTimezone: Intl gave no ${type} for ${instant.toISOString()} in ${timeZone}`)
    return found.value
  }
  return `${part("year").padStart(4, "0")}-${part("month").padStart(2, "0")}-${part("day").padStart(2, "0")}`
}

/** The `YYYY-MM-DD` day the last instant inside a half-open window ending at `end` falls on in `timeZone`: a millisecond before `end`. */
export function lastDayInside(end: Date, timeZone: string): string {
  return dayInTimezone(new Date(end.getTime() - 1), timeZone)
}

/** How far `timeZone`'s clock runs ahead of UTC at `instant`, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(instant))
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((candidate) => candidate.type === type)?.value)
  const asUtc = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"))
  return asUtc - Math.floor(instant / 1000) * 1000
}

/**
 * The instant a time of a project's day falls at (O8 of #290): `seconds`
 * after midnight of `day` on `timeZone`'s clock, where a Plan's departure and
 * a stop's window are spelled. The offset is the one in force at that time of
 * that day, so a summer morning is summer time on the day the clocks change;
 * a time the change skips is read in the offset before it.
 */
export function instantOnDay(day: string, seconds: number, timeZone: string): Date {
  const local = Date.parse(`${day}T00:00:00Z`) + seconds * 1000
  const first = local - offsetAt(local, timeZone)
  return new Date(local - offsetAt(first, timeZone))
}
