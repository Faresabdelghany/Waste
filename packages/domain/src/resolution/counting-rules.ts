// Counting rules (#547 of #544): a rule counts the completed emptyings at each
// Property over a calendar period — a month, a quarter or a year — optionally
// of one waste fraction or one container type, and opens one ticket of a
// chosen type, waiting with a chosen team, when a property's count reaches
// the rule's limit. A property gets at most one ticket per rule and period,
// and the ticket records the rule, the period and the count that raised it.
// A rule never charges: its ticket names the property alone, no agreement
// and no stop, so Finance finds nothing to bill on its completion.
//
// An emptying is a completed stop whose service is `empty`, at a property (a
// shared collection point is nobody's property), counted in the period its
// route's service date lies in — the day billing counts it on, so a
// holiday-shifted collection counts where its invoice line does.
//
// Periods are half-open (ADR-0005): `from` is the first day in, `to` the
// first day out. The rule that says which period a day is in is spelled
// once, here: the worker asks it for the period it counts over, and the
// simulation hands the periods it cuts its window into to the statement, so
// no `date_trunc` restates it in SQL. Pure string arithmetic over calendar
// days, which have no clock.
import { addDays, isIsoDate } from "../route-schemes/recurrence"
import type { CountingPeriod } from "./vocabulary"

/** The highest limit a rule may set: a daily collection over a year is 366, and nothing counts higher. */
export const COUNTING_LIMIT_MAX = 1000

/** The longest window a simulation looks back over, before it is widened to whole periods: three years. */
export const SIMULATION_DAYS_MAX = 1096

/** The most tickets a simulation lists, the earliest first; the total counts them all. */
export const SIMULATION_TICKETS_SHOWN = 500

/** A span of days, half-open: `from` the first day in, `to` the first day out. */
export type CountingWindow = { from: string; to: string }

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const

const requireDay = (day: string, caller: string): void => {
  if (!isIsoDate(day)) throw new Error(`${caller}: "${day}" is not a YYYY-MM-DD day`)
}

/** The first day of the month a number of months after `year`-`month` (1-based), as a day. */
function firstOfMonth(year: number, month: number, after: number): string {
  const index = year * 12 + (month - 1) + after
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}-01`
}

/** The period `day` lies in: its month, its calendar quarter (January, April, July, October) or its year, from its first day to the first day after it. */
export function periodOf(day: string, period: CountingPeriod): CountingWindow {
  requireDay(day, "periodOf")
  const year = Number(day.slice(0, 4))
  const month = Number(day.slice(5, 7))
  switch (period) {
    case "month":
      return { from: firstOfMonth(year, month, 0), to: firstOfMonth(year, month, 1) }
    case "quarter": {
      const first = month - ((month - 1) % 3)
      return { from: firstOfMonth(year, first, 0), to: firstOfMonth(year, first, 3) }
    }
    case "year":
      return { from: firstOfMonth(year, 1, 0), to: firstOfMonth(year, 1, 12) }
  }
}

/** A period by the name a person reads it by: `March 2026`, `Q1 2026`, `2026`. */
export function periodName(from: string, period: CountingPeriod): string {
  requireDay(from, "periodName")
  const year = from.slice(0, 4)
  const month = Number(from.slice(5, 7))
  switch (period) {
    case "month":
      return `${MONTH_NAMES[month - 1]} ${year}`
    case "quarter":
      return `Q${Math.floor((month - 1) / 3) + 1} ${year}`
    case "year":
      return year
  }
}

/** The window widened to whole periods: from the first day of `from`'s period to the first day after the period of the window's last day. */
export function wholePeriods(window: CountingWindow, period: CountingPeriod): CountingWindow {
  requireDay(window.from, "wholePeriods")
  requireDay(window.to, "wholePeriods")
  if (window.to <= window.from) throw new Error(`wholePeriods: ${window.from}..${window.to} holds no day`)
  return { from: periodOf(window.from, period).from, to: periodOf(addDays(window.to, -1), period).to }
}

/** The periods a window of whole periods is cut into, in order. */
export function periodsOver(window: CountingWindow, period: CountingPeriod): CountingWindow[] {
  const periods: CountingWindow[] = []
  let from = periodOf(window.from, period).from
  while (from < window.to) {
    const next = periodOf(from, period)
    periods.push(next)
    from = next.to
  }
  return periods
}

/** How many days a window holds; zero for one that runs backwards. */
export function windowDays(window: CountingWindow): number {
  return Math.max(0, Math.round((Date.parse(`${window.to}T00:00:00Z`) - Date.parse(`${window.from}T00:00:00Z`)) / 86_400_000))
}

/** What a simulation's window that will not do is told; undefined for one that will. */
export function simulationWindowIssue(window: CountingWindow): string | undefined {
  if (window.to <= window.from) return "The window ends before it starts; `to` is the first day not counted"
  if (windowDays(window) > SIMULATION_DAYS_MAX) return `A simulation looks back at most ${SIMULATION_DAYS_MAX} days`
  return undefined
}

/** What a rule counts, as a person reads it: `completed emptyings`, of a fraction and in a container type where it names them; `emptying` for a count of one. */
export function countedWhat(names: { wasteFraction: string | null; containerType: string | null }, count?: number): string {
  return [count === 1 ? "completed emptying" : "completed emptyings", ...(names.wasteFraction === null ? [] : [`of ${names.wasteFraction}`]), ...(names.containerType === null ? [] : [`in ${names.containerType} containers`])].join(" ")
}

/**
 * The ticket a rule opens, as it reads: the rule's name as its subject, and
 * a description saying what was counted, over which period and against which
 * limit, so a person reading the ticket needs no other page.
 */
export function countingTicketText(
  rule: { name: string; limit: number; period: CountingPeriod },
  counted: { count: number; periodFrom: string },
  names: { wasteFraction: string | null; containerType: string | null },
): { subject: string; description: string } {
  return {
    subject: rule.name,
    description: `${counted.count} ${countedWhat(names, counted.count)} at this property in ${periodName(counted.periodFrom, rule.period)} reached the counting rule "${rule.name}", whose limit is ${rule.limit} a ${rule.period}.`,
  }
}
