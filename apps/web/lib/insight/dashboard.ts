// The Dashboard on the Pilot (#292, #291 slice 27, #290 O12): what the
// screen reads off the four reports, kept out of the components so it is
// tested without a browser. The reports count rows that exist and the
// domain says what a count means (@waste/domain/insight/readings); this
// module says how a person reads them — the period picker's windows, each
// against the period just before it, a change told in points for a rate and
// in percent for a count, a rate of nothing shown as a dash and never as
// 0 %, kilograms as tonnes once they are tonnes, and the tonnage report
// rolled up by fraction, station or period with the CSV of what is shown.
//
// "Today" is the project's day where the store holds the project's timezone,
// else the browser's (`projectToday`, lib/data/route-schemes.ts), and the
// window ends on it: the last 7 days are today and the six before. The period
// a change is told against is as long and just before it; a series cut by the
// week is told against the period whole weeks before, so its weeks are cut on
// the same weekdays and set beside each other like for like.
import type { Rate, ReportInterval, ServiceInterval, ServiceReport, ServiceScheme, TonnageReport, TonnageRow } from "@waste/contracts/reports"
import { windowDays } from "@waste/domain/insight/intervals"
import { addDays } from "@waste/domain/route-schemes/recurrence"

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

/** The window of a preset that ends today: today and the days before it. */
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

/** A change against the previous period, and whether it is good news: up for a collection rate, down for missed pickups, neither for tonnage. */
export type Change = { text: string; direction: "up" | "down" | "flat"; tone: "positive" | "negative" | "neutral" }

/** Which way is good news for a measure: up, down, or neither (`null`), as for a tonnage, whose change is only a change. */
export type GoodNews = boolean | null

const toneOf = (direction: Change["direction"], upIsGood: GoodNews): Change["tone"] =>
  direction === "flat" || upIsGood === null ? "neutral" : (direction === "up") === upIsGood ? "positive" : "negative"

/** A count's change in percent, under a whole percent "<1%", and from none "from 0"; none without the period before. The direction is the counts', never the rounding's. */
export function countChange(current: number, previous: number | undefined, upIsGood: GoodNews): Change | null {
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

/** A rate as a person reads it: a whole percent, or a dash for a rate of nothing. */
export function percentOf(rate: Rate): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`
}

const counts = new Intl.NumberFormat("en")
const tonnes = new Intl.NumberFormat("en", { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const days = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" })

/** A count with its thousands separated. */
export const countOf = (value: number): string => counts.format(value)

/** A count and its noun, the noun plural but for one: "1 unload", "3 unloads". */
export const countedOf = (value: number, noun: string): string => `${countOf(value)} ${value === 1 ? noun : `${noun}s`}`

/** Kilograms as a person reads a load: in tonnes with one decimal from a tonne up, in kilograms below. */
export function weightOf(kg: number): string {
  return kg >= 1000 ? `${tonnes.format(kg / 1000)} t` : `${counts.format(kg)} kg`
}

/** A day as an axis and a table read it: `Oct 5`. */
export function dayLabel(day: string): string {
  return days.format(new Date(`${day}T00:00:00Z`))
}

/** An interval as a table reads it: its one day, or its first and last. */
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

/** The modules a role grants `view` on, as `/me` answers them. */
export function viewedModules(grants: readonly { moduleKey: string; actions: readonly string[] }[] | undefined): Set<string> {
  return new Set((grants ?? []).filter((grant) => grant.actions.includes("view")).map((grant) => grant.moduleKey))
}

/** The Dashboard's two tabs, Improve's two modules, each read under its own grant. */
export const DASHBOARD_TABS = [
  { id: "performance", label: "Performance", moduleKey: "improve.performance" },
  { id: "analytics", label: "Analytics", moduleKey: "improve.analytics" },
] as const

export type DashboardTabId = (typeof DASHBOARD_TABS)[number]["id"]

/** The revenue report's grant: the invoices', not Improve's. */
export const REVENUE_MODULE = "commercial.invoices"

/** The scheme table's columns, as the screen and its CSV read them. */
export const SCHEME_COLUMNS = ["Route scheme", "Project", "Routes", "Started", "On time", "Late", "Pickups due", "Completed", "Missed", "Open", "Collection rate", "On-time rate"] as const

/** What a project's ad-hoc routes (#111) are called in the scheme table: they have no scheme, so no scheme's name. */
export const AD_HOC_ROUTES = "Ad-hoc routes"

/** A scheme row's name: its scheme's, or `AD_HOC_ROUTES` for a project's ad-hoc routes. */
export const schemeNameOf = (scheme: Pick<ServiceScheme, "name">): string => scheme.name ?? AD_HOC_ROUTES

/** A scheme row's key: its scheme, or the project whose ad-hoc routes it counts. */
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

/** The schemes, the ones missing the most pickups first, then by name. */
export function schemesByAttention(report: ServiceReport): ServiceScheme[] {
  return [...report.schemes].sort((a, b) => b.pickups.missed - a.pickups.missed || schemeNameOf(a).localeCompare(schemeNameOf(b)))
}

/** How the tonnage report's rows are rolled up: one row per fraction, per station, per interval, or the report's own rows. */
export const TONNAGE_GROUPINGS = [
  { id: "fraction", label: "By fraction" },
  { id: "station", label: "By station" },
  { id: "interval", label: "By period" },
  { id: "all", label: "Every row" },
] as const

export type TonnageGrouping = (typeof TONNAGE_GROUPINGS)[number]["id"]

/** A rolled-up row: what it is a row of, and its weights. */
export type TonnageLine = {
  key: string
  /** The interval, where the grouping keeps it. */
  period: DayWindow | null
  projectId: string | null
  fraction: string | null
  station: string | null
  netKg: number
  approvedKg: number
  capturedKg: number
  unloads: number
  rejectedKg: number
  rejectedUnloads: number
}

const keyOf = (row: TonnageRow, grouping: TonnageGrouping): string => {
  switch (grouping) {
    case "fraction":
      return row.wasteFractionId
    case "station":
      return row.unloadingStationId
    case "interval":
      return row.from
    case "all":
      return [row.from, row.projectId, row.wasteFractionId, row.unloadingStationId].join("|")
  }
}

/** The report's unload rows rolled up by the grouping: by fraction and by station heaviest first, by period in order, every row as the report orders them. */
export function tonnageLines(report: Pick<TonnageReport, "unloads">, grouping: TonnageGrouping): TonnageLine[] {
  const lines = new Map<string, TonnageLine>()
  for (const row of report.unloads) {
    const key = keyOf(row, grouping)
    const line = lines.get(key) ?? {
      key,
      period: grouping === "interval" || grouping === "all" ? { from: row.from, to: row.to } : null,
      projectId: grouping === "all" ? row.projectId : null,
      fraction: grouping === "fraction" || grouping === "all" ? row.wasteFractionName : null,
      station: grouping === "station" || grouping === "all" ? row.unloadingStationName : null,
      netKg: 0,
      approvedKg: 0,
      capturedKg: 0,
      unloads: 0,
      rejectedKg: 0,
      rejectedUnloads: 0,
    }
    line.netKg += row.netKg
    line.approvedKg += row.approvedKg
    line.capturedKg += row.capturedKg
    line.unloads += row.unloads
    line.rejectedKg += row.rejectedKg
    line.rejectedUnloads += row.rejectedUnloads
    lines.set(key, line)
  }
  const rolled = [...lines.values()]
  if (grouping === "fraction" || grouping === "station") return rolled.sort((a, b) => b.netKg - a.netKg || (a.fraction ?? a.station ?? "").localeCompare(b.fraction ?? b.station ?? ""))
  return rolled
}

/** The label a rolled-up row is read by on a chart: its fraction, its station or its period. */
export function tonnageLabelOf(line: TonnageLine): string {
  return line.fraction ?? line.station ?? (line.period === null ? "" : intervalLabel(line.period))
}

/** The CSV of the rolled-up rows as shown: the columns the grouping keeps, then the weights in kilograms. */
export function tonnageCsvOf(lines: readonly TonnageLine[], grouping: TonnageGrouping, projectName: (id: string) => string): { header: string[]; rows: CsvCell[][] } {
  const keys: { header: string; cell: (line: TonnageLine) => CsvCell }[] = []
  if (grouping === "interval" || grouping === "all") keys.push({ header: "From", cell: (line) => line.period?.from }, { header: "To", cell: (line) => line.period?.to })
  if (grouping === "all") keys.push({ header: "Project", cell: (line) => (line.projectId === null ? "" : projectName(line.projectId)) })
  if (grouping === "fraction" || grouping === "all") keys.push({ header: "Waste fraction", cell: (line) => line.fraction })
  if (grouping === "station" || grouping === "all") keys.push({ header: "Unloading station", cell: (line) => line.station })
  const weights: { header: string; cell: (line: TonnageLine) => CsvCell }[] = [
    { header: "Net kg", cell: (line) => line.netKg },
    { header: "Approved kg", cell: (line) => line.approvedKg },
    { header: "Not reviewed kg", cell: (line) => line.capturedKg },
    { header: "Unloads", cell: (line) => line.unloads },
    { header: "Rejected kg", cell: (line) => line.rejectedKg },
    { header: "Rejected unloads", cell: (line) => line.rejectedUnloads },
  ]
  const columns = [...keys, ...weights]
  return { header: columns.map((column) => column.header), rows: lines.map((line) => columns.map((column) => column.cell(line))) }
}
