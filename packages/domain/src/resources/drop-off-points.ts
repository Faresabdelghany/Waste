// When a Drop-off Point is open (Issue #293, M3): its weekly hours, the
// exceptions the office dates, and the project's holidays, read as one rule
// for the office's form and the public map alike.
//
// A day's opening, first rule that speaks:
//   an exception   its own window, or closed all day where it gives none, with
//                  its note;
//   a holiday      closed, named, where the point closes on holidays — the
//                  project's holiday list as generation reads it
//                  (planning/generation.ts `holidayListOf`), never a copy;
//   open always    all day (a bring bank on a street);
//   the week       the weekday's windows, earliest first; none is closed.
//
// Times are `HH:MM` on the project's clock, a window opening before it closes
// on the same day: a recycling centre has no overnight hours. Several windows
// a day are allowed (a lunch break), never overlapping.
import type { HolidayList } from "../route-schemes/occurrences"
import { addDays, serviceDayOf, type ServiceDay } from "../route-schemes/recurrence"
import type { DropOffPointStatus } from "./vocabulary"

/** The status a point is on the public map in; a draft is the office's alone and a closed one is kept for the record. */
export const ON_THE_MAP: DropOffPointStatus = "active"

/** One opening window on a day. */
export type OpeningWindow = { opensAt: string; closesAt: string }

/** A weekday's window. */
export type WeeklyWindow = OpeningWindow & { weekday: ServiceDay }

/** A dated exception: its window, or both times null for closed all day. */
export type OpeningException = { date: string; opensAt: string | null; closesAt: string | null; note: string | null }

/** What a point's opening is read from. */
export type DropOffOpening = {
  openAlways: boolean
  closedOnHolidays: boolean
  hours: readonly WeeklyWindow[]
  exceptions: readonly OpeningException[]
}

/** One date's opening: its windows, or open all day, and why it is not the usual. */
export type OpeningDay = { date: string; windows: OpeningWindow[]; allDay: boolean; note: string | null }

const byOpening = (a: OpeningWindow, b: OpeningWindow) => a.opensAt.localeCompare(b.opensAt)

/** The point's opening on each of `days` dates from `from`, by the rules above. */
export function openingDaysOf(opening: DropOffOpening, { from, days }: { from: string; days: number }, holidays: HolidayList): OpeningDay[] {
  const exceptions = new Map(opening.exceptions.map((exception) => [exception.date, exception]))
  return Array.from({ length: days }, (_, index) => {
    const date = addDays(from, index)
    const exception = exceptions.get(date)
    if (exception !== undefined) {
      const windows = exception.opensAt === null || exception.closesAt === null ? [] : [{ opensAt: exception.opensAt, closesAt: exception.closesAt }]
      return { date, windows, allDay: false, note: exception.note }
    }
    const holiday = holidays.get(date)
    if (holiday !== undefined && opening.closedOnHolidays) return { date, windows: [], allDay: false, note: holiday }
    if (opening.openAlways) return { date, windows: [], allDay: true, note: null }
    const weekday = serviceDayOf(date)
    const windows = opening.hours
      .filter((window) => window.weekday === weekday)
      .map(({ opensAt, closesAt }) => ({ opensAt, closesAt }))
      .sort(byOpening)
    return { date, windows, allDay: false, note: null }
  })
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/

const capitalised = (day: string) => `${day.charAt(0).toUpperCase()}${day.slice(1)}`

/** What is wrong with a window, in a sentence's tail; null when nothing is. */
function windowIssue({ opensAt, closesAt }: OpeningWindow): string | null {
  if (!CLOCK.test(opensAt) || !CLOCK.test(closesAt)) return `a time is HH:MM on the clock (${opensAt}–${closesAt})`
  if (opensAt >= closesAt) return `a window must open before it closes (${opensAt}–${closesAt})`
  return null
}

/** What is wrong with a point's weekly hours, one sentence each; empty when nothing is. */
export function hoursIssues(hours: readonly WeeklyWindow[]): string[] {
  const issues: string[] = []
  for (const window of hours) {
    const issue = windowIssue(window)
    if (issue !== null) issues.push(`${capitalised(window.weekday)}: ${issue}`)
  }
  if (issues.length > 0) return issues
  const byWeekday = new Map<ServiceDay, WeeklyWindow[]>()
  for (const window of hours) {
    const found = byWeekday.get(window.weekday)
    if (found === undefined) byWeekday.set(window.weekday, [window])
    else found.push(window)
  }
  for (const [weekday, windows] of byWeekday) {
    const sorted = [...windows].sort(byOpening)
    for (let index = 1; index < sorted.length; index++) {
      const before = sorted[index - 1]!
      const after = sorted[index]!
      if (after.opensAt < before.closesAt) issues.push(`${capitalised(weekday)}: ${before.opensAt}–${before.closesAt} and ${after.opensAt}–${after.closesAt} overlap`)
    }
  }
  return issues
}

/** What is wrong with a point's exceptions, one sentence each; empty when nothing is. */
export function exceptionIssues(exceptions: readonly OpeningException[]): string[] {
  const issues: string[] = []
  const seen = new Set<string>()
  for (const exception of exceptions) {
    if ((exception.opensAt === null) !== (exception.closesAt === null)) issues.push(`${exception.date}: give both times, or neither for closed all day`)
    else if (exception.opensAt !== null && exception.closesAt !== null) {
      const issue = windowIssue({ opensAt: exception.opensAt, closesAt: exception.closesAt })
      if (issue !== null) issues.push(`${exception.date}: ${issue}`)
    }
    if (seen.has(exception.date)) issues.push(`${exception.date}: one exception a date`)
    seen.add(exception.date)
  }
  return issues
}
