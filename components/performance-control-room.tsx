"use client"

import { useMemo, useRef, useState, type ReactNode } from "react"
import { format, subDays } from "date-fns"
import {
  ArrowUp,
  Buildings,
  CalendarBlank,
  CaretLeft,
  CaretRight,
  CaretUpDown,
  CheckCircle,
  DownloadSimple,
  Funnel,
  Info,
  WarningCircle,
} from "@phosphor-icons/react/dist/ssr"
import {
  Bar,
  ComposedChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts"

import { SidebarTrigger } from "@/components/ui/sidebar"
import { Breadcrumbs } from "@/components/projects/Breadcrumbs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  PERFORMANCE_REFERENCE_DATE,
  ROUTE_PERFORMANCE_ROWS,
  THROUGHPUT_SERIES,
  type PerformancePortfolioSummary,
  type RouteHealthStatus,
  type RoutePerformanceRow,
  type ThroughputPoint,
} from "@/lib/data/performance-dashboard"
import { cn } from "@/lib/utils"

type RangeId = "7d" | "30d" | "90d"
type Cadence = "daily" | "weekly"
type SortKey =
  | "route"
  | "area"
  | "type"
  | "onTime"
  | "stops"
  | "proof"
  | "exceptions"
  | "sla"
  | "status"

const RANGE_OPTIONS: Array<{ value: RangeId; label: string; days: number }> = [
  { value: "7d", label: "Last 7 days", days: 7 },
  { value: "30d", label: "Last 30 days", days: 30 },
  { value: "90d", label: "Last 90 days", days: 90 },
]

const STATUS_ORDER: Record<RouteHealthStatus, number> = {
  "At risk": 0,
  Monitor: 1,
  "On track": 2,
}

const IMPACT_BY_STATUS: Record<RouteHealthStatus, "High" | "Medium" | "Low"> = {
  "At risk": "High",
  Monitor: "Medium",
  "On track": "Low",
}

const PRIORITY_ATTENTION_IDS = [
  "RC-1042",
  "RC-1048",
  "RC-1033",
  "RC-1051",
  "RC-1022",
  "RC-1055",
]

const PORTFOLIO_SUMMARY: PerformancePortfolioSummary = {
  onTimePercent: 86,
  onTimeRoutes: 31,
  totalRoutes: 36,
  completed: 4612,
  planned: 5148,
  proof: 4236,
  exceptions: 23,
  exceptionRouteCount: 11,
}

type ScopeOption = { value: string; label: string }

const DEFAULT_SCOPE_OPTIONS: ScopeOption[] = [
  { value: "copenhagen", label: "Copenhagen Central" },
  { value: "all", label: "All operating projects" },
]

type HideableTableColumn = "proof" | "exceptions" | "trend"

type PerformanceControlRoomProps = {
  breadcrumbLabel?: string
  subtitle?: string
  scopeOptions?: ScopeOption[]
  rows?: RoutePerformanceRow[]
  series?: ThroughputPoint[]
  summary?: PerformancePortfolioSummary
  priorityAttentionIds?: string[]
  hideTableColumns?: readonly HideableTableColumn[]
  /** When set, clicking a route opens it here instead of filtering in place. */
  onRouteOpen?: (routeId: string) => void
}

const numberFormatter = new Intl.NumberFormat("en-US")

function getStatusClasses(status: RouteHealthStatus) {
  if (status === "At risk") return "border-rose-500/20 bg-rose-500/10 text-rose-500"
  if (status === "Monitor") return "border-amber-500/20 bg-amber-500/10 text-amber-500"
  return "border-emerald-500/20 bg-emerald-500/10 text-emerald-500"
}

function getStatusColor(status: RouteHealthStatus) {
  if (status === "At risk") return "var(--color-rose-500)"
  if (status === "Monitor") return "var(--color-amber-500)"
  return "var(--color-emerald-500)"
}

function KpiItem({
  label,
  value,
  helper,
  trend,
  trendLabel,
  tone,
  icon,
}: {
  label: string
  value: string
  helper: string
  trend: string
  trendLabel: string
  tone: "positive" | "negative" | "warning"
  icon: ReactNode
}) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-500"
      : tone === "negative"
        ? "text-rose-500"
        : "text-amber-500"

  return (
    <div className="relative min-w-0 px-4 py-4 xl:px-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
                aria-label={`About ${label}`}
              >
                <Info className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-60 text-xs">
              {helper}
            </TooltipContent>
          </Tooltip>
        </div>
        <span className={cn("shrink-0", toneClass)}>{icon}</span>
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{value}</p>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">{helper}</p>
      <div className={cn("mt-2 flex items-center gap-1 text-[11px] font-medium", toneClass)}>
        <ArrowUp className="h-3 w-3" />
        <span>{trend}</span>
        <span className="truncate font-normal text-muted-foreground">{trendLabel}</span>
      </div>
    </div>
  )
}

function TrendSparkline({ row }: { row: RoutePerformanceRow }) {
  const data = row.trend.map((value, index) => ({ index, value }))

  return (
    <div className="h-7 w-20" aria-label={`${row.id} SLA trend`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <Line
            type="monotone"
            dataKey="value"
            stroke={getStatusColor(row.status)}
            strokeWidth={1.75}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function SortButton({
  label,
  sortKey,
  activeKey,
  onSort,
}: {
  label: string
  sortKey: SortKey
  activeKey: SortKey
  onSort: (key: SortKey) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap font-medium transition-colors hover:text-foreground",
        activeKey === sortKey ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {label}
      <CaretUpDown className="h-3 w-3" />
    </button>
  )
}

function proofPercent(row: RoutePerformanceRow) {
  return Math.round((row.proofComplete / row.stopsCompleted) * 100)
}

function completionPercent(row: RoutePerformanceRow) {
  return Math.round((row.stopsCompleted / row.stopsPlanned) * 100)
}

export function PerformanceControlRoom({
  breadcrumbLabel = "Route performance",
  subtitle = "Operational delivery and service health",
  scopeOptions = DEFAULT_SCOPE_OPTIONS,
  rows = ROUTE_PERFORMANCE_ROWS,
  series = THROUGHPUT_SERIES,
  summary = PORTFOLIO_SUMMARY,
  priorityAttentionIds = PRIORITY_ATTENTION_IDS,
  hideTableColumns = [],
  onRouteOpen,
}: PerformanceControlRoomProps) {
  const [scope, setScope] = useState(scopeOptions[0]?.value ?? "copenhagen")
  const [rangeId, setRangeId] = useState<RangeId>("30d")
  const [cadence, setCadence] = useState<Cadence>("daily")
  const [selectedRouteId, setSelectedRouteId] = useState("all")
  const [selectedStatus, setSelectedStatus] = useState<"all" | RouteHealthStatus>("all")
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({
    key: "sla",
    direction: "asc",
  })
  const [page, setPage] = useState(1)
  const tableSectionRef = useRef<HTMLDivElement>(null)

  const selectedRoute = useMemo(
    () => rows.find((route) => route.id === selectedRouteId) ?? null,
    [rows, selectedRouteId],
  )

  const range = RANGE_OPTIONS.find((option) => option.value === rangeId) ?? RANGE_OPTIONS[1]
  const rangeStart = subDays(PERFORMANCE_REFERENCE_DATE, range.days - 1)
  const previousRangeStart = subDays(rangeStart, range.days)
  const previousRangeEnd = subDays(rangeStart, 1)

  const chartData = useMemo(() => {
    const current = series
    const expanded =
      rangeId === "90d"
        ? [-60, -30, 0].flatMap((dayOffset, groupIndex) =>
            current.map((point, index) => ({
              ...point,
              date: new Date(
                point.date.getFullYear(),
                point.date.getMonth(),
                point.date.getDate() + dayOffset,
              ),
              completed: Math.round(point.completed * (0.93 + groupIndex * 0.035)),
              previous: Math.round(point.previous * (0.92 + groupIndex * 0.04)),
              key: `${groupIndex}-${index}`,
            })),
          )
        : rangeId === "7d"
          ? current.slice(-7).map((point, index) => ({ ...point, key: `week-${index}` }))
          : current.map((point, index) => ({ ...point, key: `month-${index}` }))

    if (cadence === "daily") {
      return expanded.map((point) => ({
        ...point,
        label: format(point.date, "MMM d"),
      }))
    }

    const buckets: Array<{ label: string; completed: number; previous: number; key: string }> = []
    expanded.forEach((point, index) => {
      const bucketIndex = Math.floor(index / 7)
      if (!buckets[bucketIndex]) {
        buckets[bucketIndex] = {
          label: format(point.date, "MMM d"),
          completed: 0,
          previous: 0,
          key: `bucket-${bucketIndex}`,
        }
      }
      buckets[bucketIndex].completed += point.completed
      buckets[bucketIndex].previous += point.previous
    })
    return buckets
  }, [cadence, rangeId, series])

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (selectedRouteId !== "all" && row.id !== selectedRouteId) return false
      if (selectedStatus !== "all" && row.status !== selectedStatus) return false
      return true
    })
  }, [rows, selectedRouteId, selectedStatus])

  const sortedRows = useMemo(() => {
    const rows = [...filteredRows]
    const multiplier = sort.direction === "asc" ? 1 : -1

    rows.sort((a, b) => {
      const values: Record<SortKey, [string | number, string | number]> = {
        route: [a.id, b.id],
        area: [a.area, b.area],
        type: [a.serviceType, b.serviceType],
        onTime: [a.onTimePercent, b.onTimePercent],
        stops: [a.stopsCompleted, b.stopsCompleted],
        proof: [proofPercent(a), proofPercent(b)],
        exceptions: [a.exceptions, b.exceptions],
        sla: [a.slaPercent, b.slaPercent],
        status: [STATUS_ORDER[a.status], STATUS_ORDER[b.status]],
      }
      const [left, right] = values[sort.key]
      if (typeof left === "number" && typeof right === "number") return (left - right) * multiplier
      return String(left).localeCompare(String(right)) * multiplier
    })

    return rows
  }, [filteredRows, sort])

  const pageSize = 5
  const pageCount = Math.max(1, Math.ceil(sortedRows.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const visibleRows = sortedRows.slice((safePage - 1) * pageSize, safePage * pageSize)

  const riskRows = useMemo(
    () =>
      rows
        .filter((row) => row.status !== "On track")
        .sort(
          (a, b) =>
            priorityAttentionIds.indexOf(a.id) - priorityAttentionIds.indexOf(b.id),
        )
        .slice(0, 5),
    [rows, priorityAttentionIds],
  )

  const kpis = selectedRoute
    ? [
        {
          label: "On-time performance",
          value: `${selectedRoute.onTimePercent}%`,
          helper: `${selectedRoute.id} · ${selectedRoute.name}`,
          trend: selectedRoute.status === "At risk" ? "6pp" : "2pp",
          trendLabel: "vs previous period",
          tone: selectedRoute.status === "At risk" ? ("negative" as const) : ("positive" as const),
          icon:
            selectedRoute.status === "At risk" ? (
              <WarningCircle className="h-4 w-4" weight="fill" />
            ) : (
              <CheckCircle className="h-4 w-4" weight="fill" />
            ),
        },
        {
          label: "Completed stops",
          value: numberFormatter.format(selectedRoute.stopsCompleted),
          helper: `of ${numberFormatter.format(selectedRoute.stopsPlanned)} planned stops`,
          trend: "7.4%",
          trendLabel: "vs previous period",
          tone: "positive" as const,
          icon: <CheckCircle className="h-4 w-4" weight="fill" />,
        },
        {
          label: "Open exceptions",
          value: String(selectedRoute.exceptions),
          helper: selectedRoute.issueDetail,
          trend: selectedRoute.exceptions > 3 ? "28%" : "8%",
          trendLabel: "vs previous period",
          tone: selectedRoute.exceptions > 3 ? ("negative" as const) : ("warning" as const),
          icon: <WarningCircle className="h-4 w-4" weight="fill" />,
        },
        {
          label: "Proof complete",
          value: `${proofPercent(selectedRoute)}%`,
          helper: `${numberFormatter.format(selectedRoute.proofComplete)} of ${numberFormatter.format(selectedRoute.stopsCompleted)} stops`,
          trend: "2pp",
          trendLabel: "vs previous period",
          tone: proofPercent(selectedRoute) >= 92 ? ("positive" as const) : ("warning" as const),
          icon: <CalendarBlank className="h-4 w-4" />,
        },
      ]
    : [
        {
          label: "On-time routes",
          value: `${summary.onTimePercent}%`,
          helper: `${summary.onTimeRoutes} of ${summary.totalRoutes} routes`,
          trend: "6pp",
          trendLabel: `vs ${format(previousRangeStart, "MMM d")} – ${format(previousRangeEnd, "MMM d")}`,
          tone: "positive" as const,
          icon: <CheckCircle className="h-4 w-4" weight="fill" />,
        },
        {
          label: "Completed stops",
          value: numberFormatter.format(summary.completed),
          helper: `of ${numberFormatter.format(summary.planned)} planned stops`,
          trend: "7.4%",
          trendLabel: `vs ${format(previousRangeStart, "MMM d")} – ${format(previousRangeEnd, "MMM d")}`,
          tone: "positive" as const,
          icon: <CheckCircle className="h-4 w-4" weight="fill" />,
        },
        {
          label: "Open exceptions",
          value: String(summary.exceptions),
          helper: `across ${summary.exceptionRouteCount} routes`,
          trend: "28%",
          trendLabel: `vs ${format(previousRangeStart, "MMM d")} – ${format(previousRangeEnd, "MMM d")}`,
          tone: "negative" as const,
          icon: <WarningCircle className="h-4 w-4" weight="fill" />,
        },
        {
          label: "Proof complete",
          value: `${Math.round((summary.proof / summary.completed) * 100)}%`,
          helper: `${numberFormatter.format(summary.proof)} of ${numberFormatter.format(summary.completed)} stops`,
          trend: "2pp",
          trendLabel: `vs ${format(previousRangeStart, "MMM d")} – ${format(previousRangeEnd, "MMM d")}`,
          tone: "warning" as const,
          icon: <CalendarBlank className="h-4 w-4" />,
        },
      ]

  const activeFilterCount = Number(selectedRouteId !== "all") + Number(selectedStatus !== "all")

  const handleSort = (key: SortKey) => {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }))
    setPage(1)
  }

  const focusRoute = (routeId: string) => {
    setSelectedRouteId(routeId)
    setSelectedStatus("all")
    setPage(1)
    window.requestAnimationFrame(() => {
      tableSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    })
  }

  const openRoute = onRouteOpen ?? focusRoute

  const showProof = !hideTableColumns.includes("proof")
  const showExceptions = !hideTableColumns.includes("exceptions")
  const showTrend = !hideTableColumns.includes("trend")
  const tableColumnCount = 8 + Number(showProof) + Number(showExceptions) + Number(showTrend)

  const exportCsv = () => {
    const header = [
      "Route",
      "Name",
      "Area",
      "Type",
      "On-time %",
      "Stops completed",
      "Stops planned",
      "Proof %",
      "Exceptions",
      "SLA %",
      "Status",
    ]
    const rows = sortedRows.map((row) => [
      row.id,
      row.name,
      row.area,
      row.serviceType,
      row.onTimePercent,
      row.stopsCompleted,
      row.stopsPlanned,
      proofPercent(row),
      row.exceptions,
      row.slaPercent,
      row.status,
    ])
    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
      .join("\n")
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = `wastehero-route-performance-${format(PERFORMANCE_REFERENCE_DATE, "yyyy-MM-dd")}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="m-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-sidebar bg-background">
      <header className="shrink-0 border-b border-border/70">
        <div className="flex min-h-14 items-center justify-between gap-3 border-b border-border/70 px-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-3">
            <SidebarTrigger className="h-8 w-8 shrink-0 rounded-md text-muted-foreground hover:bg-accent" />
            <div className="min-w-0">
              <Breadcrumbs items={[{ label: breadcrumbLabel }]} />
              <p className="hidden text-[11px] text-muted-foreground sm:block">{subtitle}</p>
            </div>
          </div>
          <Button variant="outline" size="sm" className="h-8 gap-2 bg-transparent" onClick={exportCsv}>
            <DownloadSimple className="h-4 w-4" />
            <span className="hidden sm:inline">Export</span>
          </Button>
        </div>

        <div className="flex flex-col gap-2.5 px-3 py-3 sm:px-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger className="h-8 w-[196px] bg-transparent text-xs">
                <Buildings className="mr-2 h-4 w-4 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {scopeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={rangeId} onValueChange={(value) => setRangeId(value as RangeId)}>
              <SelectTrigger className="h-8 w-[150px] bg-transparent text-xs">
                <CalendarBlank className="mr-2 h-4 w-4 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-2 bg-transparent text-xs">
                  <Funnel className="h-4 w-4" />
                  Filters
                  {activeFilterCount > 0 && (
                    <Badge className="h-5 min-w-5 rounded-full border-0 px-1.5 text-[10px]">{activeFilterCount}</Badge>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 space-y-4 rounded-lg p-4">
                <div className="space-y-2">
                  <p className="text-xs font-medium text-foreground">Route</p>
                  <Select
                    value={selectedRouteId}
                    onValueChange={(value) => {
                      setSelectedRouteId(value)
                      setPage(1)
                    }}
                  >
                    <SelectTrigger className="h-9 w-full bg-transparent text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All routes</SelectItem>
                      {rows.map((route) => (
                        <SelectItem key={route.id} value={route.id}>
                          {route.id} · {route.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-medium text-foreground">Health</p>
                  <Select
                    value={selectedStatus}
                    onValueChange={(value) => {
                      setSelectedStatus(value as "all" | RouteHealthStatus)
                      setPage(1)
                    }}
                  >
                    <SelectTrigger className="h-9 w-full bg-transparent text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All health states</SelectItem>
                      <SelectItem value="At risk">At risk</SelectItem>
                      <SelectItem value="Monitor">Monitor</SelectItem>
                      <SelectItem value="On track">On track</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-full text-xs"
                  onClick={() => {
                    setSelectedRouteId("all")
                    setSelectedStatus("all")
                    setPage(1)
                  }}
                >
                  Clear filters
                </Button>
              </PopoverContent>
            </Popover>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            <span>Fresh 2 min ago</span>
            <span aria-hidden>·</span>
            <span>{format(rangeStart, "MMM d")} – {format(PERFORMANCE_REFERENCE_DATE, "MMM d, yyyy")}</span>
          </div>
        </div>
      </header>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <section className="grid border-b border-border/70 sm:grid-cols-2 xl:grid-cols-4 xl:divide-x xl:divide-border/70">
          {kpis.map((kpi, index) => (
            <div
              key={kpi.label}
              className={cn(
                "border-b border-border/70 sm:[&:nth-child(odd)]:border-r xl:border-b-0 xl:[&:nth-child(odd)]:border-r-0",
                index > 1 && "sm:border-b-0",
              )}
            >
              <KpiItem {...kpi} />
            </div>
          ))}
        </section>

        <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.95fr)] lg:p-4">
          <section className="min-w-0 rounded-lg border border-border/70 bg-card/55">
            <div className="flex items-start justify-between gap-3 border-b border-border/70 px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Route throughput</h2>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Completed stops per {cadence === "daily" ? "day" : "week"}</p>
              </div>
              <div className="flex items-center gap-3">
                <div className="hidden items-center gap-3 text-[10px] text-muted-foreground sm:flex">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-sm bg-primary" />
                    This period
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-px w-4 border-t border-dashed border-muted-foreground" />
                    Previous period
                  </span>
                </div>
                <Select value={cadence} onValueChange={(value) => setCadence(value as Cadence)}>
                  <SelectTrigger className="h-7 w-[88px] bg-transparent text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="h-[250px] px-2 pb-2 pt-3 sm:px-3">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.65} />
                  <XAxis
                    dataKey="label"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                    interval={Math.max(0, Math.ceil(chartData.length / 6) - 1)}
                    minTickGap={12}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                    width={36}
                  />
                  <ChartTooltip
                    cursor={{ fill: "var(--accent)", opacity: 0.35 }}
                    contentStyle={{
                      background: "var(--popover)",
                      color: "var(--popover-foreground)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Bar
                    dataKey="completed"
                    name="This period"
                    fill="var(--primary)"
                    fillOpacity={0.78}
                    radius={[3, 3, 0, 0]}
                    maxBarSize={28}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="previous"
                    name="Previous period"
                    stroke="var(--muted-foreground)"
                    strokeWidth={1.35}
                    strokeDasharray="5 4"
                    dot={false}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="min-w-0 overflow-hidden rounded-lg border border-border/70 bg-card/55">
            <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Routes needing attention</h2>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Highest operational impact</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedRouteId("all")
                  setSelectedStatus("all")
                  setPage(1)
                  tableSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
                }}
                className="text-[11px] font-medium text-primary hover:underline"
              >
                View all
              </button>
            </div>
            <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_70px_20px] gap-2 border-b border-border/70 px-4 py-2 text-[10px] font-medium text-muted-foreground">
              <span>Route</span>
              <span>Issue</span>
              <span>Impact</span>
              <span className="sr-only">Open</span>
            </div>
            <div className="divide-y divide-border/70">
              {riskRows.map((row) => {
                const impact = IMPACT_BY_STATUS[row.status]
                return (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => openRoute(row.id)}
                    className="grid w-full grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_70px_20px] items-center gap-2 px-4 py-1.5 text-left transition-colors hover:bg-accent/55 focus-visible:bg-accent focus-visible:outline-none"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: getStatusColor(row.status) }}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-foreground">{row.id}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">{row.name}</span>
                      </span>
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[11px] text-foreground">{row.issue}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">{row.issueDetail}</span>
                    </span>
                    <Badge
                      variant="outline"
                      className={cn(
                        "h-5 w-fit rounded px-1.5 text-[10px] font-medium",
                        impact === "High"
                          ? "border-rose-500/20 bg-rose-500/10 text-rose-500"
                          : impact === "Medium"
                            ? "border-amber-500/20 bg-amber-500/10 text-amber-500"
                            : "border-border bg-muted text-muted-foreground",
                      )}
                    >
                      {impact}
                    </Badge>
                    <CaretRight className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                )
              })}
            </div>
          </section>
        </div>

        <section ref={tableSectionRef} className="scroll-mt-4 px-3 pb-3 lg:px-4 lg:pb-4">
          <div className="overflow-hidden rounded-lg border border-border/70 bg-card/55">
            <div className="flex flex-col gap-2 border-b border-border/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Route health</h2>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {showProof && showExceptions
                    ? "Service delivery, proof, exceptions, and SLA performance"
                    : "Service delivery and SLA performance"}
                </p>
              </div>
              <p className="text-[11px] text-muted-foreground">Showing {sortedRows.length} of {summary.totalRoutes} routes</p>
            </div>

            <div className="overflow-x-auto">
              <table className={cn("w-full border-collapse text-left", showTrend && showProof && showExceptions ? "min-w-[1080px]" : "min-w-[840px]")}>
                <thead>
                  <tr className="border-b border-border/70 text-[10px]">
                    <th className="px-4 py-2.5"><SortButton label="Route" sortKey="route" activeKey={sort.key} onSort={handleSort} /></th>
                    <th className="px-3 py-2.5"><SortButton label="Area" sortKey="area" activeKey={sort.key} onSort={handleSort} /></th>
                    <th className="px-3 py-2.5"><SortButton label="Type" sortKey="type" activeKey={sort.key} onSort={handleSort} /></th>
                    <th className="px-3 py-2.5"><SortButton label="On-time %" sortKey="onTime" activeKey={sort.key} onSort={handleSort} /></th>
                    <th className="px-3 py-2.5"><SortButton label="Stops" sortKey="stops" activeKey={sort.key} onSort={handleSort} /></th>
                    {showProof && (
                      <th className="px-3 py-2.5"><SortButton label="Proof %" sortKey="proof" activeKey={sort.key} onSort={handleSort} /></th>
                    )}
                    {showExceptions && (
                      <th className="px-3 py-2.5"><SortButton label="Exceptions" sortKey="exceptions" activeKey={sort.key} onSort={handleSort} /></th>
                    )}
                    <th className="px-3 py-2.5"><SortButton label="SLA" sortKey="sla" activeKey={sort.key} onSort={handleSort} /></th>
                    <th className="px-3 py-2.5"><SortButton label="Status" sortKey="status" activeKey={sort.key} onSort={handleSort} /></th>
                    {showTrend && <th className="px-3 py-2.5 text-muted-foreground">Trend</th>}
                    <th className="w-8 px-2 py-2.5"><span className="sr-only">Open</span></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.length === 0 ? (
                    <tr>
                      <td colSpan={tableColumnCount} className="px-4 py-10 text-center text-xs text-muted-foreground">
                        No routes match the selected filters.
                      </td>
                    </tr>
                  ) : (
                    visibleRows.map((row) => {
                      const proof = proofPercent(row)
                      const completion = completionPercent(row)
                      return (
                        <tr
                          key={row.id}
                          onClick={onRouteOpen ? () => onRouteOpen(row.id) : undefined}
                          className={cn(
                            "border-b border-border/60 text-xs last:border-b-0 hover:bg-accent/35",
                            onRouteOpen && "cursor-pointer",
                          )}
                        >
                          <td className="px-4 py-2">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation()
                                openRoute(row.id)
                              }}
                              className="flex min-w-0 items-center gap-2 text-left"
                            >
                              <span
                                className="h-2 w-2 shrink-0 rounded-full border-2 border-current bg-transparent"
                                style={{ color: getStatusColor(row.status) }}
                              />
                              <span className="min-w-0">
                                <span className="block font-medium text-foreground">{row.id}</span>
                                <span className="block max-w-36 truncate text-[10px] text-muted-foreground">{row.name}</span>
                              </span>
                            </button>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{row.area}</td>
                          <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{row.serviceType}</td>
                          <td className={cn("px-3 py-2 font-medium", row.onTimePercent < 70 ? "text-rose-500" : row.onTimePercent < 85 ? "text-amber-500" : "text-emerald-500")}>
                            {row.onTimePercent}%
                          </td>
                          <td className="px-3 py-2">
                            <span className="font-medium text-foreground">{row.stopsCompleted}</span>
                            <span className="text-muted-foreground"> / {row.stopsPlanned}</span>
                            <span className="ml-1 text-[10px] text-muted-foreground">({completion}%)</span>
                          </td>
                          {showProof && (
                            <td className={cn("px-3 py-2 font-medium", proof < 80 ? "text-rose-500" : proof < 92 ? "text-amber-500" : "text-emerald-500")}>
                              {proof}%
                            </td>
                          )}
                          {showExceptions && <td className="px-3 py-2 text-foreground">{row.exceptions}</td>}
                          <td className={cn("px-3 py-2 font-medium", row.slaPercent < 70 ? "text-rose-500" : row.slaPercent < 85 ? "text-amber-500" : "text-emerald-500")}>
                            {row.slaPercent}%
                          </td>
                          <td className="px-3 py-2">
                            <Badge variant="outline" className={cn("h-5 whitespace-nowrap rounded px-1.5 text-[10px] font-medium", getStatusClasses(row.status))}>
                              {row.status}
                            </Badge>
                          </td>
                          {showTrend && <td className="px-3 py-2"><TrendSparkline row={row} /></td>}
                          <td className="px-2 py-2">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation()
                                openRoute(row.id)
                              }}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                              aria-label={`View ${row.id}`}
                            >
                              <CaretRight className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between border-t border-border/70 px-4 py-2.5">
              <p className="text-[10px] text-muted-foreground">
                {sortedRows.length === 0
                  ? "No matching routes"
                  : `Showing ${(safePage - 1) * pageSize + 1}–${Math.min(safePage * pageSize, sortedRows.length)} of ${sortedRows.length}`}
              </p>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={safePage <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  <CaretLeft className="h-3.5 w-3.5" />
                  <span className="sr-only">Previous page</span>
                </Button>
                {Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNumber) => (
                  <Button
                    key={pageNumber}
                    variant={safePage === pageNumber ? "default" : "ghost"}
                    size="icon"
                    className="h-7 w-7 text-xs"
                    onClick={() => setPage(pageNumber)}
                  >
                    {pageNumber}
                  </Button>
                ))}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={safePage >= pageCount}
                  onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                >
                  <CaretRight className="h-3.5 w-3.5" />
                  <span className="sr-only">Next page</span>
                </Button>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}
