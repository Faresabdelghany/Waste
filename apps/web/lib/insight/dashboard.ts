// The Dashboard on the Pilot (#292, #291 slice 27): what the screen reads
// off the two reports, kept out of the components so it is tested without a
// browser. The reports count rows that exist and the domain says what a
// count means (@waste/domain/insight/readings); this module says how a
// person reads them — the period picker's windows, each against the period
// just before it, a change told in points for a rate and in percent for a
// count, a rate of nothing shown as a dash and never as 0 %, and the Route
// Schemes' rows with the CSV of what is shown.
//
// "Today" is the project's day where the store holds the project's timezone,
// else the browser's (`dayIn`, lib/format/clock.ts), and the
// window ends on it: the last 7 days are today and the six before. The period
// a change is told against is as long and just before it; a series cut by the
// week is told against the period whole weeks before, so its weeks are cut on
// the same weekdays and set beside each other like for like.
import type { Rate, ReportInterval, ServiceInterval, ServiceReport, ServiceScheme } from "@waste/contracts/reports"
import type { ModuleKey } from "@waste/domain/access/modules"
import { windowDays } from "@waste/domain/insight/intervals"
import { addDays } from "@waste/domain/days"

import type { CsvCell } from "@/lib/data/csv"

/** The period picker's presets, finest series first: a week and a month by the day, a quarter by the week. */
export const DASHBOARD_RANGES = [
  { id: "7d", label: "Last 7 days", days: 7, interval: "day" },
  { id: "30d", label: "Last 30 days", days: 30, interval: "day" },
  { id: "90d", label: "Last 90 days", days: 90, interval: "week" },
] as const satisfies readonly { id: string; label: string; days: number; interval: ReportInterval }[]

export type DashboardRange = (typeof DASHBOARD_RANGES)[number]
export type DashboardRangeId = DashboardRange["id"]

/** The preset the Dashboard opens on. */
export const DEFAULT_RANGE: DashboardRangeId = "30d"

export const rangeOf = (id: DashboardRangeId): DashboardRange => DASHBOARD_RANGES.find((range) => range.id === id) ?? DASHBOARD_RANGES[1]

/** Two days, both inclusive. */
export type DayWindow = { from: string; to: string }

export function windowEnding(today: string, days: number): DayWindow {
  return { from: addDays(today, -(days - 1)), to: today }
}

/**
 * The window a change is told against: as long as this one, ending the day
 * before it starts — or, for a series cut by the week, as long and whole
 * weeks before, so the two are cut into weeks on the same weekdays and each
 * week sits beside a week of as many days.
 */
export function previousWindow(window: DayWindow, interval: ReportInterval = "day"): DayWindow {
  const days = windowDays(window)
  const back = interval === "week" ? Math.ceil(days / 7) * 7 : days
  return { from: addDays(window.from, -back), to: addDays(window.to, -back) }
}

/** A change against the previous period, and whether it is good news: up for a collection rate, down for missed pickups. */
export type Change = { text: string; direction: "up" | "down" | "flat"; tone: "positive" | "negative" | "neutral" }

const toneOf = (direction: Change["direction"], upIsGood: boolean): Change["tone"] => (direction === "flat" ? "neutral" : (direction === "up") === upIsGood ? "positive" : "negative")

/** A count's change in percent, under a whole percent "<1%", and from none "from 0"; none without the period before. The direction is the counts', never the rounding's. */
export function countChange(current: number, previous: number | undefined, upIsGood: boolean): Change | null {
  if (previous === undefined) return null
  const direction = current > previous ? "up" : current < previous ? "down" : "flat"
  if (direction === "flat") return { text: "0%", direction, tone: "neutral" }
  if (previous === 0) return { text: "from 0", direction, tone: toneOf(direction, upIsGood) }
  const percent = Math.round((Math.abs(current - previous) / previous) * 100)
  return { text: percent === 0 ? "<1%" : `${percent}%`, direction, tone: toneOf(direction, upIsGood) }
}

/** A rate's change in percentage points, under a whole point "<1 pp"; none where either period has no rate. The direction is the rates', never the rounding's. */
export function rateChange(current: Rate, previous: Rate | undefined, upIsGood: boolean): Change | null {
  if (current === null || previous === null || previous === undefined) return null
  const direction = current > previous ? "up" : current < previous ? "down" : "flat"
  if (direction === "flat") return { text: "0 pp", direction, tone: "neutral" }
  const points = Math.round(Math.abs(current - previous) * 100)
  return { text: points === 0 ? "<1 pp" : `${points} pp`, direction, tone: toneOf(direction, upIsGood) }
}

export function percentOf(rate: Rate): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`
}

const days = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" })

function dayLabel(day: string): string {
  return days.format(new Date(`${day}T00:00:00Z`))
}

export function intervalLabel(span: DayWindow): string {
  return span.from === span.to ? dayLabel(span.from) : `${dayLabel(span.from)} – ${dayLabel(span.to)}`
}

/** One column of the throughput chart: the pickups collected in an interval, and in the matching interval of the period before. */
export type ThroughputPoint = { key: string; label: string; completed: number; missed: number; previous: number | null }

/** The series of the period, each interval beside the one in the same place of the period before (`previousWindow` cuts the two alike; none where that period was cut into fewer). */
export function throughputOf(current: readonly ServiceInterval[], previous: readonly ServiceInterval[] | undefined): ThroughputPoint[] {
  return current.map((span, index) => ({
    key: span.from,
    label: dayLabel(span.from),
    completed: span.pickups.completed,
    missed: span.pickups.missed,
    previous: previous?.[index]?.pickups.completed ?? null,
  }))
}

/** Improve's Performance: the module the Dashboard is read under. */
export const PERFORMANCE_MODULE: ModuleKey = "improve.performance"

/** The scheme table's columns, as the screen and its CSV read them. */
export const SCHEME_COLUMNS = ["Route scheme", "Project", "Routes", "Started", "On time", "Late", "Pickups due", "Completed", "Missed", "Open", "Collection rate", "On-time rate"] as const

/** What a project's ad-hoc routes (#111) are called in the scheme table: they have no scheme, so no scheme's name. */
export const AD_HOC_ROUTES = "Ad-hoc routes"

export const schemeNameOf = (scheme: Pick<ServiceScheme, "name">): string => scheme.name ?? AD_HOC_ROUTES

export const schemeKeyOf = (scheme: Pick<ServiceScheme, "routeSchemeId" | "projectId">): string => scheme.routeSchemeId ?? `ad-hoc|${scheme.projectId}`

/** One scheme's row of the table, by `SCHEME_COLUMNS`. */
export function schemeRowOf(scheme: ServiceScheme, projectName: (id: string) => string): CsvCell[] {
  return [
    schemeNameOf(scheme),
    projectName(scheme.projectId),
    scheme.routes.total,
    scheme.routes.started,
    scheme.routes.onTime,
    scheme.routes.late,
    scheme.pickups.due,
    scheme.pickups.completed,
    scheme.pickups.missed,
    scheme.pickups.open,
    percentOf(scheme.rates.collection),
    percentOf(scheme.rates.onTime),
  ]
}

export function schemesByAttention(report: ServiceReport): ServiceScheme[] {
  return [...report.schemes].sort((a, b) => b.pickups.missed - a.pickups.missed || schemeNameOf(a).localeCompare(schemeNameOf(b)))
}
