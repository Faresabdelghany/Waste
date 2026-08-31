"use client"

// Scheme detail as a dedicated full page (issue #29; SPEC.md area E,
// DECISIONS.md D8/D9/D10/D17/D26/D28): Details · Routes · Stops · Collection
// Calendar tabs, replacing the generic record side sheet for Route Schemes.
// Every displayed value is read from the canonical scheme record and the live
// related records at render time — never from stale display copies. Rule
// matches are a preview of containers; Stops exist only once routes are
// generated (D9).

import Link from "next/link"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import {
  ArrowSquareOut,
  ArrowsClockwise,
  CalendarBlank,
  CalendarCheck,
  DotsThreeVertical,
  MapPin,
  PencilSimple,
  Trash,
  Warning,
} from "@phosphor-icons/react/dist/ssr"

import type {
  BusinessRecord,
  ModuleDefinition,
} from "@/lib/data/business-modules"
import {
  calendarFromRecord,
  type CollectionCalendar,
} from "@/lib/route-schemes/calendar"
import {
  approvedDeviationsFromRecords,
  lastGeneratedAt,
  routeDeviationInfo,
  schemeGeneratedRoutes,
  schemeVersionOf,
  stringValueOf,
  type ApprovedDeviation,
} from "@/lib/route-schemes/generation"
import {
  schemeCanGenerateRoutes,
  schemeLiveValidation,
  type SchemeRelatedRecords,
} from "@/lib/route-schemes/lifecycle"
import {
  effectiveDayRules,
  matchPlansFromValues,
  resolveStopMatches,
  splitList,
  stopRuleSummary,
  stopSelectionMode,
} from "@/lib/route-schemes/matching"
import { isPlanAheadEnabled, setPlanAhead } from "@/lib/route-schemes/plan-ahead"
import {
  SERVICE_DAY_SHORT_LABELS,
  formatServiceDate,
  recurrenceFromValues,
  recurrenceSentence,
  serviceDaysFromValues,
  todayIso,
} from "@/lib/route-schemes/recurrence"
import { stringValue } from "@/lib/route-schemes/validation"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  TablePagination,
  useTablePagination,
} from "@/components/ui/table-pagination"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Breadcrumbs } from "@/components/projects/Breadcrumbs"
import { StatRow } from "@/components/projects/StatRow"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { useBusinessRecordStore } from "@/components/wastehero/business-record-store"
import { statusClasses } from "@/components/wastehero/business-record-views"
import { useModuleRecords } from "@/components/wastehero/scheme-route-map"

const GENERATED_AT_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
})

/** The date a generated route operates on — deviation-remapped when one applies (D17). */
function routeOperatingDate(route: BusinessRecord): string | undefined {
  return stringValueOf(route, "actualDate") ?? stringValueOf(route, "serviceDate")
}

/** Live Attention overlay (D5/D20) — a warning condition, never a status value. */
function SchemeAttentionBadge({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) return null
  return (
    <Badge
      variant="outline"
      title={warnings.join("\n")}
      className="rounded-full border-transparent bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-100"
    >
      Attention
    </Badge>
  )
}

function DetailCard({
  title,
  children,
  className,
}: {
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      className={cn("rounded-xl border border-border/60 p-4", className)}
    >
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {title}
      </h3>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  )
}

/** "1 Jun 2026 → ongoing" — canonical effective period, open-ended aware (D23). */
function effectivePeriodLabel(
  effectiveFrom: string | undefined,
  effectiveTo: string | undefined,
): string {
  if (!effectiveFrom) return "—"
  const from = formatServiceDate(effectiveFrom)
  return effectiveTo ? `${from} → ${formatServiceDate(effectiveTo)}` : `${from} → ongoing`
}

/** The calendar's validity period, open sides spelled out. */
function calendarValidityLabel(calendar: CollectionCalendar | null): string {
  if (!calendar || (!calendar.validFrom && !calendar.validTo)) return "Open-ended"
  const from = calendar.validFrom
    ? formatServiceDate(calendar.validFrom)
    : "Open start"
  const to = calendar.validTo ? formatServiceDate(calendar.validTo) : "open-ended"
  return `${from} → ${to}`
}

export function SchemeDetailsPage({
  module,
  record,
  onBack,
  onEdit,
  onDelete,
  onGenerateRoutes,
  readOnly = false,
}: {
  module: ModuleDefinition
  /** The live scheme record with the derived lifecycle status applied. */
  record: BusinessRecord
  onBack: () => void
  /** Opens the existing prefilled edit flow; absent hides Edit. */
  onEdit?: () => void
  onDelete?: () => void
  /** Opens the Generate routes dialog; absent hides the action entirely. */
  onGenerateRoutes?: () => void
  /** Hides every mutation control, e.g. for view-only roles. */
  readOnly?: boolean
}) {
  const { upsertRecord } = useBusinessRecordStore()
  const schemes = useModuleRecords("route-studio", "schemes")
  const allRoutes = useModuleRecords("route-studio", "routes")
  const allPickups = useModuleRecords("route-studio", "pickups")
  const calendarRecords = useModuleRecords("plan", "calendars")
  const areas = useModuleRecords("plan", "areas")
  const deviationRecords = useModuleRecords("plan", "collection-deviations")
  const allocations = useModuleRecords("fleet", "vehicle-planning")
  const containers = useModuleRecords("resources", "containers")
  const vehicles = useModuleRecords("fleet", "vehicles")
  const drivers = useModuleRecords("fleet", "drivers")

  const today = todayIso()
  const values = record.submittedValues ?? {}
  const isDraft = record.status === "Draft"

  // Live validation (D20/D26): blocking issues drive the Draft callout and
  // the disabled Generate routes action; warnings drive the Attention badge.
  const validation = useMemo(() => {
    const related: SchemeRelatedRecords = {
      schemes,
      calendars: calendarRecords,
      allocations,
      containers,
      vehicles,
    }
    return schemeLiveValidation(record, related)
  }, [allocations, calendarRecords, containers, record, schemes, vehicles])
  // Blocking issues gate on LIVE validation (D26), not only the persisted
  // Draft status: a validated scheme whose environment drifted into blocking
  // issues must show them and lose Generate routes too. A Draft with no
  // structured recurrence has nothing to evaluate live — one fixed issue.
  const liveIssues = validation?.issues ?? []
  const blockingIssues =
    liveIssues.length > 0
      ? liveIssues
      : isDraft && !validation
        ? [
            "The scheme has no structured recurrence configuration — it cannot generate routes.",
          ]
        : []
  // A persisted Draft whose live validation is now clean still cannot
  // generate (D25: statuses are event-driven at save) — the Details tab
  // explains that a re-save via Edit validates it.
  const draftPendingResave = isDraft && Boolean(validation) && liveIssues.length === 0
  const attention = validation?.warnings ?? []

  const canGenerate =
    schemeCanGenerateRoutes(record, today) && blockingIssues.length === 0
  const planAheadOn = isPlanAheadEnabled(record)
  const approvedDeviations = useMemo(
    () => approvedDeviationsFromRecords(deviationRecords),
    [deviationRecords],
  )

  // The scheme's generated routes, ordered by the date they operate on —
  // the actual date including approved Collection Deviation moves (D17).
  const schemeRoutes = useMemo(
    () =>
      schemeGeneratedRoutes(record.id, allRoutes)
        .slice()
        .sort((a, b) =>
          (routeOperatingDate(a) ?? "").localeCompare(routeOperatingDate(b) ?? ""),
        ),
    [allRoutes, record.id],
  )
  const routesById = useMemo(
    () => new Map(schemeRoutes.map((route) => [route.id, route])),
    [schemeRoutes],
  )

  // Generated Stops (D9): the pickups written with the scheme's dated routes.
  // Empty before generation — rule matches are never presented as Stops.
  const schemeStops = useMemo(
    () =>
      allPickups
        .filter((pickup) => stringValueOf(pickup, "schemeId") === record.id)
        .map((pickup) => {
          const route = routesById.get(stringValueOf(pickup, "routeId") ?? "")
          return {
            pickup,
            route,
            date:
              (route ? routeOperatingDate(route) : undefined) ??
              stringValueOf(pickup, "serviceDate") ??
              "",
          }
        })
        .sort(
          (a, b) =>
            a.date.localeCompare(b.date) ||
            Number(a.pickup.facts.Stop ?? 0) - Number(b.pickup.facts.Stop ?? 0),
        ),
    [allPickups, record.id, routesById],
  )

  const calendarId = stringValue(values, "calendarId")
  const calendarRecord = calendarId
    ? calendarRecords.find((candidate) => candidate.id === calendarId)
    : undefined
  const calendar = calendarFromRecord(calendarRecord)

  const togglePlanAhead = () => {
    const enabled = !planAheadOn
    upsertRecord("route-studio", "schemes", setPlanAhead(record, enabled))
    toast.success(enabled ? "Plan Ahead turned on" : "Plan Ahead turned off", {
      description: enabled
        ? `${record.name} generates its next 7 days automatically when Route Studio loads.`
        : `${record.name} stops auto-generating; already-generated routes remain.`,
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-border">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-accent" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Breadcrumbs
                  items={[
                    { label: module.label, onClick: onBack },
                    { label: record.name },
                  ]}
                />
                <Badge
                  variant="outline"
                  className={cn(
                    "rounded-full text-[11px]",
                    statusClasses(record.status),
                  )}
                >
                  {record.status}
                </Badge>
                <SchemeAttentionBadge warnings={attention} />
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {record.context} · {record.id}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {onGenerateRoutes && (
              <Button
                size="sm"
                onClick={onGenerateRoutes}
                disabled={!canGenerate}
                title={
                  canGenerate
                    ? undefined
                    : draftPendingResave
                      ? "Save the scheme via Edit to validate it — generation is enabled once it validates."
                      : "Generation is blocked by scheme validation — resolve the blocking issues via Edit."
                }
              >
                <ArrowsClockwise className="h-4 w-4" />
                Generate routes
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  Actions
                  <DotsThreeVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-56">
                {onEdit && (
                  <DropdownMenuItem onSelect={onEdit}>
                    <PencilSimple className="h-4 w-4" />
                    Edit scheme
                  </DropdownMenuItem>
                )}
                {!readOnly && (
                  <DropdownMenuItem onSelect={togglePlanAhead}>
                    <CalendarCheck className="h-4 w-4" />
                    {planAheadOn ? "Turn off Plan Ahead" : "Turn on Plan Ahead"}
                  </DropdownMenuItem>
                )}
                {onDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={onDelete}
                    >
                      <Trash className="h-4 w-4" />
                      Delete scheme
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <Tabs defaultValue="details" className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-border/40 px-4 py-3">
          <div className="overflow-x-auto">
            <TabsList className="inline-flex h-8 rounded-full border border-border/50 bg-muted px-1 py-0.5 text-xs">
              {(
                [
                  ["details", "Details", null],
                  ["routes", "Routes", schemeRoutes.length],
                  ["stops", "Stops", schemeStops.length],
                  ["calendar", "Collection Calendar", null],
                ] as const
              ).map(([value, label, count]) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className="h-7 rounded-full px-3 text-xs data-[state=active]:bg-background data-[state=active]:text-foreground"
                >
                  {label}
                  {count !== null && (
                    <span className="ml-1.5 text-[10px] text-muted-foreground">
                      {count}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </div>

        <TabsContent value="details" className="mt-0 min-h-0 flex-1 overflow-y-auto">
          <SchemeDetailsTab
            record={record}
            values={values}
            areas={areas}
            containers={containers}
            vehicles={vehicles}
            drivers={drivers}
            calendarRecord={calendarRecord}
            calendar={calendar}
            planAheadOn={planAheadOn}
            blockingIssues={blockingIssues}
            draftPendingResave={draftPendingResave}
            onEdit={onEdit}
          />
        </TabsContent>
        <TabsContent value="routes" className="mt-0 min-h-0 flex-1 overflow-y-auto">
          <SchemeRoutesTab
            routes={schemeRoutes}
            generationBlocked={!canGenerate}
            deviations={approvedDeviations}
          />
        </TabsContent>
        <TabsContent value="stops" className="mt-0 min-h-0 flex-1 overflow-y-auto">
          <SchemeStopsTab stops={schemeStops} generationBlocked={!canGenerate} />
        </TabsContent>
        <TabsContent value="calendar" className="mt-0 min-h-0 flex-1 overflow-y-auto">
          <SchemeCalendarTab
            calendarId={calendarId}
            calendarRecord={calendarRecord}
            calendar={calendar}
            today={today}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/* ------------------------------- Details tab ------------------------------ */

function SchemeDetailsTab({
  record,
  values,
  areas,
  containers,
  vehicles,
  drivers,
  calendarRecord,
  calendar,
  planAheadOn,
  blockingIssues,
  draftPendingResave,
  onEdit,
}: {
  record: BusinessRecord
  values: NonNullable<BusinessRecord["submittedValues"]>
  areas: readonly BusinessRecord[]
  containers: readonly BusinessRecord[]
  vehicles: readonly BusinessRecord[]
  drivers: readonly BusinessRecord[]
  calendarRecord: BusinessRecord | undefined
  calendar: CollectionCalendar | null
  planAheadOn: boolean
  blockingIssues: readonly string[]
  /** Persisted Draft whose live validation is now clean — needs a re-save. */
  draftPendingResave: boolean
  onEdit?: () => void
}) {
  const facts = record.facts ?? {}
  const recurrence = recurrenceFromValues(values)
  const serviceDays = serviceDaysFromValues(values)

  // Canonical reads with legacy-fact fallbacks (D28i): structured
  // submittedValues and live related records first; the stored display fact
  // only where a legacy record has no structured value at all.
  const areaId = stringValue(values, "planningAreaId")
  const areaName =
    areas.find((area) => area.id === areaId)?.name ?? facts["Planning area"]
  const plannedVehicle =
    vehicles.find(
      (vehicle) => vehicle.id === stringValue(values, "plannedVehicleId"),
    )?.name ?? facts.Vehicle
  const plannedDriver =
    drivers.find(
      (driver) => driver.id === stringValue(values, "plannedDriverId"),
    )?.name ?? facts.Driver
  const effectiveFrom = stringValue(values, "effectiveFrom")
  // D16: display "—" for legacy schemes without a planned start time —
  // never invent a default.
  const plannedStartTime =
    stringValue(values, "plannedStartTime") ?? facts["Planned start"] ?? "—"

  const mode = stopSelectionMode(values)
  const matchPlans = matchPlansFromValues(values)
  const dayRules =
    mode === "rule" ? effectiveDayRules(serviceDays, matchPlans) : []
  const shownRules = matchPlans.sameAllDays ? dayRules.slice(0, 1) : dayRules
  const pickedContainerIds =
    mode === "manual" ? splitList(stringValue(values, "containerIds")) : []
  const pickedContainers = pickedContainerIds.map(
    (id) => containers.find((candidate) => candidate.id === id)?.name ?? id,
  )

  return (
    <div className="space-y-4 p-4">
      {blockingIssues.length > 0 && (
        <section className="rounded-xl border border-red-500/40 bg-red-500/10 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <Warning className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-red-700 dark:text-red-300">
                  Route generation is blocked by scheme validation
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-red-700/90 dark:text-red-300/90">
                  {blockingIssues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            </div>
            {onEdit && (
              <Button size="sm" variant="outline" onClick={onEdit}>
                <PencilSimple className="h-4 w-4" />
                Resolve via Edit
              </Button>
            )}
          </div>
        </section>
      )}

      {draftPendingResave && (
        <section className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <Warning className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                  Draft — configuration now passes validation
                </p>
                <p className="mt-1 text-xs text-amber-800/90 dark:text-amber-300/90">
                  Save the scheme via Edit to validate it; route generation
                  stays off until then.
                </p>
              </div>
            </div>
            {onEdit && (
              <Button size="sm" variant="outline" onClick={onEdit}>
                <PencilSimple className="h-4 w-4" />
                Resolve via Edit
              </Button>
            )}
          </div>
        </section>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <DetailCard title="Scheme & scope">
          <StatRow label="Scheme" value={record.name} />
          <StatRow label="Version" value={schemeVersionOf(record)} />
          {facts.Project && <StatRow label="Project" value={facts.Project} />}
          <StatRow label="Planning area" value={areaName ?? "—"} />
          <StatRow
            label="Effective period"
            value={
              effectiveFrom
                ? effectivePeriodLabel(
                    effectiveFrom,
                    stringValue(values, "effectiveTo"),
                  )
                : facts.Effective ?? "—"
            }
          />
          <StatRow label="Owner" value={record.owner} />
          <StatRow label="Plan Ahead" value={planAheadOn ? "On" : "Off"} />
        </DetailCard>

        <DetailCard title="Collection calendar">
          {calendarRecord ? (
            <>
              <StatRow label="Calendar" value={calendarRecord.name} />
              <StatRow label="Status" value={calendarRecord.status} />
              <StatRow label="Validity" value={calendarValidityLabel(calendar)} />
              <StatRow
                label="Holidays"
                value={String(calendar?.holidayDates.length ?? 0)}
              />
              <p className="text-xs text-muted-foreground">
                Shared calendar — owned in Plan, selected by this scheme. See
                the Collection Calendar tab.
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {stringValue(values, "calendarId")
                ? "The selected Collection Calendar record no longer exists."
                : facts["Collection calendar"]
                  ? `${facts["Collection calendar"]} (legacy label — no linked calendar record).`
                  : "No Collection Calendar selected — dates are only bounded by the effective period."}
            </p>
          )}
        </DetailCard>

        <DetailCard title="Recurrence">
          <StatRow
            label="Recurrence"
            value={
              recurrence ? recurrenceSentence(recurrence) : facts.Recurrence ?? "—"
            }
          />
          <StatRow
            label="Service days"
            value={
              serviceDays.length > 0
                ? serviceDays
                    .map((day) => SERVICE_DAY_SHORT_LABELS[day])
                    .join(", ")
                : "—"
            }
          />
          {recurrence?.frequency === "every-2-weeks" && (
            <StatRow
              label="Week rotation"
              value={
                recurrence.weekRotation
                  ? `${recurrence.weekRotation === "odd" ? "Odd" : "Even"} ISO weeks`
                  : "—"
              }
            />
          )}
          <StatRow label="Planned start time" value={plannedStartTime} />
        </DetailCard>

        <DetailCard title="Assignment">
          <StatRow label="Vehicle" value={plannedVehicle ?? "Not assigned"} />
          <StatRow label="Driver" value={plannedDriver ?? "Not assigned"} />
          <StatRow
            label="Hauler"
            value={facts.Hauler ?? facts.Contractor ?? "—"}
          />
          {facts["Departure depot"] && (
            <StatRow label="Departure depot" value={facts["Departure depot"]} />
          )}
          {facts["Unloading station"] && (
            <StatRow
              label="Unloading station"
              value={facts["Unloading station"]}
            />
          )}
          <p className="text-xs text-muted-foreground">
            Planned Assignment — generated routes start from these defaults;
            dispatcher overrides stay on the route.
          </p>
        </DetailCard>

        <DetailCard
          title="Containers & stop rule"
          className="md:col-span-2 xl:col-span-1"
        >
          <StatRow
            label="Stop selection"
            value={mode === "rule" ? "Matched by rule" : "Picked containers"}
          />
          {mode === "rule" ? (
            <>
              {shownRules.map(({ day, rule }) => {
                const matched = resolveStopMatches({
                  rule,
                  areaId,
                  projectIds: record.projectIds,
                  containers,
                }).matched.length
                return (
                  <StatRow
                    key={day}
                    label={
                      matchPlans.sameAllDays
                        ? "Rule (every service day)"
                        : `Rule (${SERVICE_DAY_SHORT_LABELS[day]})`
                    }
                    value={`${stopRuleSummary(rule)} — ${matched} container${
                      matched === 1 ? "" : "s"
                    } currently matched`}
                  />
                )
              })}
              <p className="text-xs text-muted-foreground">
                The rule resolves against live containers at every generation.
                Matches are a preview — Stops exist only on generated routes.
              </p>
            </>
          ) : (
            <>
              <StatRow
                label="Picked containers"
                value={String(pickedContainers.length)}
              />
              {pickedContainers.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {pickedContainers.slice(0, 4).join(", ")}
                  {pickedContainers.length > 4
                    ? ` and ${pickedContainers.length - 4} more`
                    : ""}
                </p>
              )}
            </>
          )}
        </DetailCard>
      </div>
    </div>
  )
}

/* -------------------------------- Routes tab ------------------------------ */

function SchemeRoutesTab({
  routes,
  generationBlocked,
  deviations,
}: {
  routes: readonly BusinessRecord[]
  /** Generation cannot run right now — blocking issues or unsaved Draft. */
  generationBlocked: boolean
  deviations: readonly ApprovedDeviation[]
}) {
  const { page, setPage, pageCount, pageRows, totalCount } =
    useTablePagination(routes)
  const generatedStamp = lastGeneratedAt(routes)

  return (
    <div className="p-4">
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5 text-xs text-muted-foreground">
          <span>
            {routes.length} generated route{routes.length === 1 ? "" : "s"}
          </span>
          {generatedStamp && (
            <span>
              Last generated {GENERATED_AT_FORMAT.format(new Date(generatedStamp))}
            </span>
          )}
        </div>
        <div className="overflow-x-auto">
          <Table className="min-w-[820px]">
            <TableHeader className="bg-muted/30">
              <TableRow className="hover:bg-transparent">
                {["Service date", "Route ID", "Status", "Stops", "Vehicle", "Driver"].map(
                  (head) => (
                    <TableHead
                      key={head}
                      className="text-xs font-medium text-muted-foreground"
                    >
                      {head}
                    </TableHead>
                  ),
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {routes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-52 text-center">
                    <ArrowsClockwise className="mx-auto h-6 w-6 text-muted-foreground" />
                    {generationBlocked ? (
                      <>
                        <p className="mt-2 text-sm font-medium">
                          Route generation is blocked by scheme validation
                        </p>
                        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                          See the Details tab for what blocks this scheme —
                          routes will generate once it validates.
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="mt-2 text-sm font-medium">
                          No routes generated yet
                        </p>
                        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                          Use Generate routes or turn on Plan Ahead to create
                          this scheme&apos;s dated routes.
                        </p>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                pageRows.map((route) => {
                  const operatingDate = routeOperatingDate(route)
                  // The shared deviation seam (issue #26): stamped note or a
                  // derived one for unstamped remaps — never raw facts reads.
                  const deviationNote = routeDeviationInfo(route, deviations)
                  return (
                    <TableRow key={route.id} className="hover:bg-muted/60">
                      <TableCell className="min-w-[180px] py-3">
                        <p className="text-sm font-medium">
                          {operatingDate ? formatServiceDate(operatingDate) : "—"}
                        </p>
                        {deviationNote && (
                          <p className="mt-0.5 max-w-56 truncate text-xs text-amber-700 dark:text-amber-400">
                            {deviationNote}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="py-3">
                        <Link
                          href={`/route-studio?module=routes&record=${route.id}`}
                          className="font-mono text-xs underline-offset-4 hover:underline"
                        >
                          {route.name}
                        </Link>
                      </TableCell>
                      <TableCell className="py-3">
                        <Badge
                          variant="outline"
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[11px] font-medium",
                            statusClasses(route.status),
                          )}
                        >
                          {route.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-3 text-sm">
                        {route.facts.Stops ?? "0"}
                      </TableCell>
                      <TableCell className="py-3 text-sm">
                        {route.facts.Vehicle ?? "Unassigned"}
                      </TableCell>
                      <TableCell className="py-3 text-sm">
                        {route.facts.Driver ?? "Unassigned"}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
        <TablePagination
          page={page}
          pageCount={pageCount}
          totalCount={totalCount}
          onPageChange={setPage}
        />
      </div>
    </div>
  )
}

/* -------------------------------- Stops tab ------------------------------- */

type SchemeStopRow = {
  pickup: BusinessRecord
  route: BusinessRecord | undefined
  /** The operating date of the stop's route (deviation-remapped). */
  date: string
}

function SchemeStopsTab({
  stops,
  generationBlocked,
}: {
  stops: readonly SchemeStopRow[]
  /** Generation cannot run right now — blocking issues or unsaved Draft. */
  generationBlocked: boolean
}) {
  const [routeFilter, setRouteFilter] = useState("all")
  const [dateFilter, setDateFilter] = useState("all")

  const routeOptions = useMemo(
    () =>
      [...new Set(stops.map((stop) => stop.pickup.facts.Route).filter(Boolean))] as string[],
    [stops],
  )
  const dateOptions = useMemo(
    () => [...new Set(stops.map((stop) => stop.date).filter(Boolean))],
    [stops],
  )
  const filtered = stops.filter(
    (stop) =>
      (routeFilter === "all" || stop.pickup.facts.Route === routeFilter) &&
      (dateFilter === "all" || stop.date === dateFilter),
  )
  const { page, setPage, pageCount, pageRows, totalCount } =
    useTablePagination(filtered)

  return (
    <div className="p-4">
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <span className="text-xs text-muted-foreground">
            {filtered.length} stop{filtered.length === 1 ? "" : "s"}
          </span>
          {stops.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Select value={routeFilter} onValueChange={(value) => {
                setRouteFilter(value)
                setPage(1)
              }}>
                <SelectTrigger className="h-8 w-40 text-xs">
                  <SelectValue placeholder="Route" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All routes</SelectItem>
                  {routeOptions.map((route) => (
                    <SelectItem key={route} value={route}>
                      {route}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={dateFilter} onValueChange={(value) => {
                setDateFilter(value)
                setPage(1)
              }}>
                <SelectTrigger className="h-8 w-44 text-xs">
                  <SelectValue placeholder="Service date" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All dates</SelectItem>
                  {dateOptions.map((date) => (
                    <SelectItem key={date} value={date}>
                      {formatServiceDate(date)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <div className="overflow-x-auto">
          <Table className="min-w-[820px]">
            <TableHeader className="bg-muted/30">
              <TableRow className="hover:bg-transparent">
                {["Service date / Route", "#", "Stop", "Service", "Status"].map(
                  (head) => (
                    <TableHead
                      key={head}
                      className="text-xs font-medium text-muted-foreground"
                    >
                      {head}
                    </TableHead>
                  ),
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-52 text-center">
                    <MapPin className="mx-auto h-6 w-6 text-muted-foreground" />
                    {generationBlocked && stops.length === 0 ? (
                      <>
                        <p className="mt-2 text-sm font-medium">
                          Route generation is blocked by scheme validation
                        </p>
                        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                          Stops are created with generated routes. Resolve the
                          blocking issues via Edit on the Details tab first.
                        </p>
                      </>
                    ) : stops.length === 0 ? (
                      <>
                        <p className="mt-2 text-sm font-medium">No Stops yet</p>
                        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                          Stops are created when routes are generated — rule
                          matches on the Details tab are a preview, never Stops.
                        </p>
                      </>
                    ) : (
                      <p className="mt-2 text-sm font-medium">
                        No stops match the current filters
                      </p>
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                pageRows.map(({ pickup, date }) => (
                  <TableRow key={pickup.id} className="hover:bg-muted/60">
                    <TableCell className="min-w-[200px] py-3">
                      <p className="text-sm font-medium">
                        {date ? formatServiceDate(date) : "—"}
                      </p>
                      <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                        {pickup.facts.Route ?? "—"}
                      </p>
                    </TableCell>
                    <TableCell className="py-3 text-sm tabular-nums">
                      {pickup.facts.Stop ?? "—"}
                    </TableCell>
                    <TableCell className="min-w-[220px] py-3">
                      <p className="text-sm font-medium">
                        {pickup.facts.Address?.split(",")[0] ?? pickup.name}
                      </p>
                      {pickup.facts["Container ID"] && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {pickup.facts["Container ID"]}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="py-3 text-sm">
                      {[
                        pickup.facts["Waste fraction"] ?? "Collection",
                        pickup.facts["Container Type"],
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </TableCell>
                    <TableCell className="py-3">
                      <Badge
                        variant="outline"
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[11px] font-medium",
                          statusClasses(pickup.status),
                        )}
                      >
                        {pickup.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <TablePagination
          page={page}
          pageCount={pageCount}
          totalCount={totalCount}
          onPageChange={setPage}
        />
      </div>
    </div>
  )
}

/* --------------------------- Collection Calendar tab ---------------------- */

function SchemeCalendarTab({
  calendarId,
  calendarRecord,
  calendar,
  today,
}: {
  calendarId: string | undefined
  calendarRecord: BusinessRecord | undefined
  calendar: CollectionCalendar | null
  today: string
}) {
  if (!calendarRecord) {
    return (
      <div className="flex h-full min-h-64 items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <CalendarBlank className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">
            {calendarId
              ? "The selected Collection Calendar record no longer exists"
              : "No Collection Calendar selected"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Select a shared calendar via Edit — the scheme uses it to decide
            which planned service dates are valid.
          </p>
        </div>
      </div>
    )
  }

  const upcomingHolidays =
    calendar?.holidayDates.filter((date) => date >= today) ?? []
  const pastHolidays =
    calendar?.holidayDates.filter((date) => date < today) ?? []

  return (
    <div className="space-y-4 p-4">
      <section className="rounded-xl border border-border/60 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">{calendarRecord.name}</h3>
              <Badge
                variant="outline"
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] font-medium",
                  statusClasses(calendarRecord.status),
                )}
              >
                {calendarRecord.status}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Read-only — this shared calendar is owned and edited in Plan. The
              scheme selects it and never redefines it.
            </p>
          </div>
          <Button size="sm" variant="outline" asChild>
            <Link href={`/plan?module=calendars&record=${calendarRecord.id}`}>
              <ArrowSquareOut className="h-4 w-4" />
              Open in Plan
            </Link>
          </Button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatRow
            label="Working days"
            value={
              calendar && calendar.workingDays.length > 0
                ? calendar.workingDays
                    .map((day) => SERVICE_DAY_SHORT_LABELS[day])
                    .join(", ")
                : "Unconstrained"
            }
          />
          <StatRow label="Validity" value={calendarValidityLabel(calendar)} />
          <StatRow
            label="Holidays"
            value={String(calendar?.holidayDates.length ?? 0)}
          />
          <StatRow label="Timezone" value={calendar?.timezone ?? "—"} />
        </div>
      </section>

      <section className="rounded-xl border border-border/60 p-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Holiday dates
        </h3>
        {calendar && calendar.holidayDates.length > 0 ? (
          <div className="mt-3 space-y-3">
            {upcomingHolidays.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {upcomingHolidays.map((date) => (
                  <Badge
                    key={date}
                    variant="outline"
                    className="rounded-full px-2 py-0.5 text-[11px] font-normal"
                  >
                    {formatServiceDate(date)}
                  </Badge>
                ))}
              </div>
            )}
            {pastHolidays.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {pastHolidays.map((date) => (
                  <Badge
                    key={date}
                    variant="outline"
                    className="rounded-full px-2 py-0.5 text-[11px] font-normal text-muted-foreground"
                  >
                    {formatServiceDate(date)}
                  </Badge>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Holiday and non-working dates are skipped at generation — moving
              service requires an approved Collection Deviation.
            </p>
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            No holiday dates on this calendar.
          </p>
        )}
      </section>
    </div>
  )
}
