// How a report's window of days is cut into its series (#292, C26 and O12).
// A window is two `YYYY-MM-DD` days, both inclusive — the route and pickup
// lists' window (`from`/`to` over the operating date) — and a series is the
// window cut into days, ISO weeks (Monday to Sunday, the project's working
// week starting where `serviceDayOf` starts it) or calendar months, the first
// and the last interval clipped to the window, so every interval's days lie
// inside it and the series' counts add up to the window's.
//
// The statements count by day and this module folds the days into intervals,
// so the rule that says which interval a day is in is spelled once, here,
// and never as a `date_trunc` beside it in SQL. Pure string arithmetic over
// UTC midnights, like finance/periods.ts: a calendar day has no clock.
import { SERVICE_DAYS } from "../planning/vocabulary"
import { addDays, isIsoDate, serviceDayOf } from "../route-schemes/recurrence"
import type { ReportInterval } from "./vocabulary"

/** A span of days, both inclusive. */
export type DayInterval = { from: string; to: string }

const requireDay = (day: string, caller: string): void => {
  if (!isIsoDate(day)) throw new Error(`${caller}: "${day}" is not a YYYY-MM-DD day`)
}

/** The first day of the interval `day` falls in: the day itself, the Monday of its ISO week, the first of its month. */
export function intervalStart(day: string, interval: ReportInterval): string {
  requireDay(day, "intervalStart")
  switch (interval) {
    case "day":
      return day
    case "week":
      return addDays(day, -SERVICE_DAYS.indexOf(serviceDayOf(day)))
    case "month":
      return `${day.slice(0, 7)}-01`
  }
}

/** The last day of the interval that starts on `start`: the day itself, the Sunday after it, the last of its month. */
function intervalEnd(start: string, interval: ReportInterval): string {
  switch (interval) {
    case "day":
      return start
    case "week":
      return addDays(start, 6)
    case "month": {
      const [year, month] = start.split("-").map(Number)
      return `${start.slice(0, 7)}-${String(daysInMonth(year, month)).padStart(2, "0")}`
    }
  }
}

/** How many days a month of the Gregorian calendar has: by arithmetic, since `Date.UTC` reads a year below 100 as 1900 and more. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/** How many days a window spans, both ends inclusive; zero for a window that runs backwards. */
export function windowDays(window: DayInterval): number {
  requireDay(window.from, "windowDays")
  requireDay(window.to, "windowDays")
  return Math.max(0, Math.round((Date.parse(`${window.to}T00:00:00Z`) - Date.parse(`${window.from}T00:00:00Z`)) / 86_400_000) + 1)
}

/**
 * The intervals a window is cut into, in order: every interval the window
 * touches, the first starting on `from` and the last ending on `to` where the
 * window cuts them. Empty for a window that runs backwards.
 */
export function intervalsOver(window: DayInterval, interval: ReportInterval): DayInterval[] {
  requireDay(window.from, "intervalsOver")
  requireDay(window.to, "intervalsOver")
  const intervals: DayInterval[] = []
  if (window.to < window.from) return intervals
  let start = intervalStart(window.from, interval)
  while (start <= window.to) {
    const end = intervalEnd(start, interval)
    intervals.push({ from: start < window.from ? window.from : start, to: end > window.to ? window.to : end })
    start = addDays(end, 1)
  }
  return intervals
}

/**
 * The interval of a window's series that `day` is counted in, as
 * `intervalsOver` spells it: clipped to the window. A day outside the window
 * is in none of its intervals, and asking is a caller's error.
 */
export function intervalOf(day: string, window: DayInterval, interval: ReportInterval): DayInterval {
  requireDay(day, "intervalOf")
  if (day < window.from || day > window.to) throw new Error(`intervalOf: ${day} is outside ${window.from}..${window.to}`)
  const start = intervalStart(day, interval)
  const end = intervalEnd(start, interval)
  return { from: start < window.from ? window.from : start, to: end > window.to ? window.to : end }
}
