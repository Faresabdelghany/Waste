"use client"

// Scheme detail as a dedicated full page (issue #29): Details · Routes ·
// Stops · Collection Calendar tabs, replacing the generic record side sheet for Route Schemes.
// Every displayed value is read from the canonical scheme record and the live
// related records at render time — never from stale display copies. Rule
// matches are a preview of containers; Stops exist only once routes are
// generated (D9).

import Link from "next/link"
import { useRouter } from "next/navigation"
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

import {
  applyBusinessFilters,
  businessFilterChips,
  emptyBusinessFilters,
  removeBusinessFilterValue,
  type BusinessFilters,
  type FilterValueReaders,
} from "@/lib/data/business-filters"
import type {
  BusinessRecord,
  ModuleDefinition,
} from "@/lib/data/business-modules"
import { PLANNING_AREAS_MODULE } from "@/lib/data/planning-areas"
import {
  calendarFromRecord,
  type CollectionCalendar,
} from "@/lib/route-schemes/calendar"
import {
  lastGeneratedAt,
  routeDeviationNote,
  schemeGeneratedRoutes,
  schemePlannedStartTime,
  schemeVersionOf,
  stringValueOf,
} from "@/lib/route-schemes/generation"
import {
  schemeCanGenerateRoutes,
  schemeFuturePlanningStopped,
  schemeLiveValidation,
  type SchemeRelatedRecords,
} from "@/lib/route-schemes/lifecycle"
import { schemeGroupPlans } from "@/lib/route-schemes/groups"
import { stopRuleSummary } from "@/lib/route-schemes/matching"
import { isPlanAheadEnabled, setPlanAhead } from "@/lib/route-schemes/plan-ahead"
import { schemeAreaName } from "@/lib/route-schemes/scheme-list"
import {
  SCHEME_ROUTE_FILTER_READERS,
  SCHEME_STOP_FILTER_READERS,
  routeWasteFractionsLabel,
  schemeStopContainerLabel,
  schemeStopContainerType,
  withRouteWasteFractions,
  withStopServiceDate,
} from "@/lib/route-schemes/scheme-tabs"
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
import { ChipOverflow } from "@/components/chip-overflow"
import { Breadcrumbs } from "@/components/projects/Breadcrumbs"
import { StatRow } from "@/components/projects/StatRow"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { BusinessFilterPopover } from "@/components/wastehero/business-filter-popover"
import { useBusinessRecordStore } from "@/components/wastehero/business-record-store"
import {
  NoMatchingRecords,
  statusClasses,
} from "@/components/wastehero/business-record-views"
import { RecordSearchInput } from "@/components/wastehero/record-search-input"
import { useModuleRecords } from "@/components/wastehero/scheme-route-map"

const GENERATED_AT_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
})

/** The date a generated route operates on (D17). */
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
  onEditGroups,
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
  /** Opens the collection groups editor (D36); absent hides the action. */
  onEditGroups?: () => void
  /** Hides every mutation control, e.g. for view-only roles. */
  readOnly?: boolean
}) {
  const { upsertRecord } = useBusinessRecordStore()
  const schemes = useModuleRecords("route-studio", "schemes")
  const allRoutes = useModuleRecords("route-studio", "routes")
  const allPickups = useModuleRecords("route-studio", "pickups")
  const calendarRecords = useModuleRecords("plan", "calendars")
  const areas = useModuleRecords(PLANNING_AREAS_MODULE.workspaceId, PLANNING_AREAS_MODULE.moduleId)
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

  // The scheme's generated routes, ordered by the date they operate on (D17).
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
  const schemePickups = useMemo(
    () => allPickups.filter((pickup) => stringValueOf(pickup, "schemeId") === record.id),
    [allPickups, record.id],
  )
  const schemeStops = useMemo(
    () =>
      schemePickups
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
    [routesById, schemePickups],
  )

  const calendarId = stringValue(values, "calendarId")
  const calendarRecord = calendarId
    ? calendarRecords.find((candidate) => candidate.id === calendarId)
    : undefined
  const calendar = calendarFromRecord(calendarRecord)

  const togglePlanAhead = () => {
    const enabled = !planAheadOn
    // Persist against the stored record, not the derived display record —
    // the status/context seams (issues #25/#30) are render-time and must
    // never be frozen into the store.
    const stored = schemes.find((candidate) => candidate.id === record.id) ?? record
    upsertRecord("route-studio", "schemes", setPlanAhead(stored, enabled))
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
                {onEditGroups && (
                  <DropdownMenuItem onSelect={onEditGroups}>
                    <PencilSimple className="h-4 w-4" />
                    Edit collection groups
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
            onEditGroups={onEditGroups}
          />
        </TabsContent>
        <TabsContent value="routes" className="mt-0 min-h-0 flex-1 overflow-y-auto">
          <SchemeRoutesTab
            routes={schemeRoutes}
            pickups={schemePickups}
            generationBlocked={!canGenerate}
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
  onEditGroups,
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
  onEditGroups?: () => void
}) {
  const serviceProviders = useModuleRecords("service-providers", "service-providers")
  const facts = record.facts ?? {}
  const recurrence = recurrenceFromValues(values)
  const serviceDays = serviceDaysFromValues(values)

  // Canonical reads with legacy-fact fallbacks (D28i): structured
  // submittedValues and live related records first; the stored display fact
  // only where a legacy record has no structured value at all. Area
  // resolution is the shared list/detail policy (issue #30).
  const areaName = schemeAreaName(record, areas)
  const effectiveFrom = stringValue(values, "effectiveFrom")
  // D16: display "—" for legacy schemes without a planned start time —
  // never invent a default. Resolved through the same helper generation
  // uses (issue #32) so the page and the engine cannot disagree.
  const plannedStartTime = schemePlannedStartTime(record) ?? "—"

  // Collection groups (D33): the record's groups — implicit for the legacy
  // single-assignment shape, explicit when stored — resolved per day against
  // the live containers through the same seam generation reads.
  const { groups, resolution } = schemeGroupPlans(record, serviceDays, containers)
  const groupVehicleName = (group: (typeof groups)[number]) =>
    vehicles.find((vehicle) => vehicle.id === group.vehicleId)?.name ??
    group.vehicleName ??
    "Not assigned"
  const groupDriverName = (group: (typeof groups)[number]) =>
    drivers.find((driver) => driver.id === group.driverId)?.name ??
    group.driverName ??
    "Not assigned"
  const groupProviderName = (group: (typeof groups)[number]) =>
    serviceProviders.find((provider) => provider.id === group.serviceProviderId)?.name ??
    group.serviceProviderName ??
    (facts.Hauler ?? facts["Service provider"] ?? "In-house")
  const groupPlans = (group: (typeof groups)[number]) =>
    resolution.plans.filter((plan) => plan.groupId === group.id)

  // Edit-save reconciliation aftermath (issue #33, SPEC G): a Draft with
  // generation evidence had its future refreshable routes cancelled by the
  // invalidating save — explain why future planning stopped and that a valid
  // save re-creates them.
  const futurePlanningStopped = schemeFuturePlanningStopped(record)
  const futurePlanningStoppedNote =
    "Future planning stopped when this scheme became invalid: its future planned routes were cancelled but kept as records, and a valid save re-creates them automatically."

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
                {futurePlanningStopped && (
                  <p className="mt-2 text-xs text-red-700/90 dark:text-red-300/90">
                    {futurePlanningStoppedNote}
                  </p>
                )}
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
                  Save the scheme via Edit to validate it — a valid save
                  reconciles its future routes automatically; generation stays
                  off until then.
                </p>
                {futurePlanningStopped && (
                  <p className="mt-1 text-xs text-amber-800/90 dark:text-amber-300/90">
                    {futurePlanningStoppedNote}
                  </p>
                )}
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

        <DetailCard
          title={`Collection groups (${groups.length})`}
          className="md:col-span-2 xl:col-span-2"
        >
          {onEditGroups && (
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="sm" onClick={onEditGroups}>
                <PencilSimple className="h-4 w-4" />
                Edit collection groups
              </Button>
            </div>
          )}
          <div className="divide-y divide-border/60">
            {groups.map((group) => {
              const plans = groupPlans(group)
              const stopCounts =
                plans.length > 0
                  ? plans
                      .map(
                        (plan) =>
                          `${SERVICE_DAY_SHORT_LABELS[plan.day]} ${plan.containerIds.length}`,
                      )
                      .join(" · ")
                  : "No service days"
              const claimed = plans.reduce((sum, plan) => sum + plan.claimedByOthers.length, 0)
              const pickedNames = group.containerIds.map(
                (id) => containers.find((candidate) => candidate.id === id)?.name ?? id,
              )
              return (
                <div key={group.id} className="space-y-1 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-foreground">
                      {group.implicit && groups.length === 1 ? "Planned assignment" : group.name}
                    </p>
                    <span className="text-xs text-muted-foreground">
                      {group.days.map((day) => SERVICE_DAY_SHORT_LABELS[day]).join(", ") ||
                        "No days"}
                    </span>
                    <Badge variant="outline" className="rounded-full text-[11px]">
                      {group.stopSource === "rule" ? "Matched by rule" : "Picked containers"}
                    </Badge>
                  </div>
                  <StatRow label="Vehicle" value={groupVehicleName(group)} />
                  <StatRow label="Driver" value={groupDriverName(group)} />
                  <StatRow label="Service provider" value={groupProviderName(group)} />
                  {group.stopSource === "rule" ? (
                    <StatRow
                      label="Stop rule"
                      value={`${stopRuleSummary({
                        fractions: group.fractions,
                        ...(group.ruleVehicleType ? { vehicleType: group.ruleVehicleType } : {}),
                      })} — ${stopCounts} currently matched${
                        claimed > 0 ? ` · ${claimed} left to other groups on shared days` : ""
                      }`}
                    />
                  ) : (
                    <StatRow
                      label="Picked containers"
                      value={`${pickedNames.length}${
                        pickedNames.length > 0
                          ? ` — ${pickedNames.slice(0, 4).join(", ")}${
                              pickedNames.length > 4 ? ` and ${pickedNames.length - 4} more` : ""
                            }`
                          : ""
                      }`}
                    />
                  )}
                </div>
              )
            })}
          </div>
          {facts["Departure depot"] && (
            <StatRow label="Departure depot" value={facts["Departure depot"]} />
          )}
          {facts["Unloading station"] && (
            <StatRow label="Unloading station" value={facts["Unloading station"]} />
          )}
          <p className="text-xs text-muted-foreground">
            One route is generated per group per day it runs on, starting from
            the group&apos;s planned assignment — dispatcher overrides stay on the
            route. Rule matches are a preview; Stops exist only on generated
            routes.
          </p>
        </DetailCard>
      </div>
    </div>
  )
}

/* ------------------------------- Tab toolbar ------------------------------ */

/**
 * The workspace record toolbar — search, the shared Filter popover, removable
 * chips — so the Routes and Stops tabs filter exactly like every other table.
 * `readers` is the tab's reader set: the popover's options and the tab's row
 * matching read one function per category.
 */
function SchemeTabToolbar({
  query,
  onQueryChange,
  placeholder,
  records,
  filters,
  onFiltersChange,
  readers,
}: {
  query: string
  onQueryChange: (query: string) => void
  placeholder: string
  records: BusinessRecord[]
  filters: BusinessFilters
  onFiltersChange: (filters: BusinessFilters) => void
  readers: FilterValueReaders
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-1 flex-wrap items-center gap-2 min-w-[260px]">
        <RecordSearchInput
          value={query}
          onChange={onQueryChange}
          placeholder={placeholder}
        />
        <BusinessFilterPopover
          records={records}
          value={filters}
          onChange={onFiltersChange}
          readers={readers}
        />
      </div>
      <ChipOverflow
        chips={businessFilterChips(filters)}
        onRemove={(key, value) =>
          onFiltersChange(removeBusinessFilterValue(filters, key, value))
        }
        maxVisible={4}
      />
    </div>
  )
}

/** "12 records" / "3 of 12 records" — the workspace record-count line. */
function recordCountLabel(shown: number, total: number) {
  return shown === total ? `${total} records` : `${shown} of ${total} records`
}

function routeDetailsHref(routeId: string) {
  return `/route-studio?module=routes&record=${routeId}`
}

/** The workspace's clickable-row contract: button role, keyboard activation, hover. */
function recordRowProps(label: string, onOpen: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": `Open ${label}`,
    className:
      "cursor-pointer hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset",
    onClick: onOpen,
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        onOpen()
      }
    },
  }
}

/* -------------------------------- Routes tab ------------------------------ */

function SchemeRoutesTab({
  routes,
  pickups,
  generationBlocked,
}: {
  routes: readonly BusinessRecord[]
  /** The scheme's generated Stops — a route's waste fractions derive from them. */
  pickups: readonly BusinessRecord[]
  /** Generation cannot run right now — blocking issues or unsaved Draft. */
  generationBlocked: boolean
}) {
  const router = useRouter()
  const [query, setQuery] = useState("")
  const [filters, setFilters] = useState<BusinessFilters>(emptyBusinessFilters)

  // Render-time projection only (never persisted): each route carries the
  // fractions its planned Stops serve so the table cell, the popover's
  // options and the row matching read one value.
  const rows = useMemo(
    () => routes.map((route) => withRouteWasteFractions(route, pickups)),
    [pickups, routes],
  )
  const filtered = useMemo(
    () => applyBusinessFilters(rows, filters, SCHEME_ROUTE_FILTER_READERS, query),
    [filters, query, rows],
  )
  const { page, setPage, pageCount, pageRows, totalCount } =
    useTablePagination(filtered)
  const generatedStamp = lastGeneratedAt(routes)

  return (
    <div className="space-y-4 p-4">
      <SchemeTabToolbar
        query={query}
        onQueryChange={(next) => {
          setQuery(next)
          setPage(1)
        }}
        placeholder="Search routes"
        records={rows}
        filters={filters}
        onFiltersChange={(next) => {
          setFilters(next)
          setPage(1)
        }}
        readers={SCHEME_ROUTE_FILTER_READERS}
      />

      <section className="overflow-hidden rounded-xl border border-border/60">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
          <p className="text-xs text-muted-foreground">
            {recordCountLabel(filtered.length, rows.length)}
          </p>
          {generatedStamp && (
            <p className="text-xs text-muted-foreground">
              Last generated {GENERATED_AT_FORMAT.format(new Date(generatedStamp))}
            </p>
          )}
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Service date</TableHead>
                <TableHead>Route ID</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Stops</TableHead>
                <TableHead>Waste fraction</TableHead>
                <TableHead>Vehicle</TableHead>
                <TableHead>Driver</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 && rows.length > 0 ? (
                <TableRow>
                  <TableCell colSpan={7}>
                    <NoMatchingRecords />
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-52 text-center">
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
                  // The shared deviation seam (issue #26) — never raw facts reads.
                  const deviationNote = routeDeviationNote(route)
                  return (
                    <TableRow
                      key={route.id}
                      {...recordRowProps(route.name, () =>
                        router.push(routeDetailsHref(route.id)),
                      )}
                    >
                      <TableCell className="min-w-[180px]">
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-foreground">
                            {operatingDate ? formatServiceDate(operatingDate) : "—"}
                          </p>
                          {deviationNote && (
                            <p className="max-w-[340px] truncate text-xs text-amber-700 dark:text-amber-400">
                              {deviationNote}
                            </p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-foreground">
                        {route.name}
                      </TableCell>
                      <TableCell>
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
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {route.facts.Stops ?? "0"}
                      </TableCell>
                      <TableCell className="min-w-[140px] text-sm text-muted-foreground">
                        {routeWasteFractionsLabel(route) ?? "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {route.facts.Vehicle ?? "Unassigned"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
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
      </section>
    </div>
  )
}

/* -------------------------------- Stops tab ------------------------------- */

type SchemeStopRow = {
  pickup: BusinessRecord
  route: BusinessRecord | undefined
  /** The operating date of the stop's route. */
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
  const router = useRouter()
  const [query, setQuery] = useState("")
  const [filters, setFilters] = useState<BusinessFilters>(emptyBusinessFilters)

  // Render-time projection only (never persisted): each Stop carries its
  // route's operating date so the Service date filter reads it like any fact.
  const pickups = useMemo(
    () => stops.map((stop) => withStopServiceDate(stop.pickup, stop.date)),
    [stops],
  )
  const filtered = useMemo(() => {
    const kept = new Set(
      applyBusinessFilters(pickups, filters, SCHEME_STOP_FILTER_READERS, query).map(
        (pickup) => pickup.id,
      ),
    )
    return stops.filter((stop) => kept.has(stop.pickup.id))
  }, [filters, pickups, query, stops])
  const { page, setPage, pageCount, pageRows, totalCount } =
    useTablePagination(filtered)

  // A Stop opens the dated route it belongs to — the Route details page owns
  // stop-level work.
  const stopRouteId = (stop: SchemeStopRow) =>
    stop.route?.id ?? stringValueOf(stop.pickup, "routeId")

  return (
    <div className="space-y-4 p-4">
      <SchemeTabToolbar
        query={query}
        onQueryChange={(next) => {
          setQuery(next)
          setPage(1)
        }}
        placeholder="Search stops"
        records={pickups}
        filters={filters}
        onFiltersChange={(next) => {
          setFilters(next)
          setPage(1)
        }}
        readers={SCHEME_STOP_FILTER_READERS}
      />

      <section className="overflow-hidden rounded-xl border border-border/60">
        <div className="border-b border-border px-4 py-2">
          <p className="text-xs text-muted-foreground">
            {recordCountLabel(filtered.length, stops.length)}
          </p>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>Service date / Route</TableHead>
                <TableHead>#</TableHead>
                <TableHead>Container</TableHead>
                <TableHead>Container ID</TableHead>
                <TableHead>Container type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Waste fraction</TableHead>
                <TableHead>Driver</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 && stops.length > 0 ? (
                <TableRow>
                  <TableCell colSpan={8}>
                    <NoMatchingRecords />
                  </TableCell>
                </TableRow>
              ) : stops.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="h-52 text-center">
                    <MapPin className="mx-auto h-6 w-6 text-muted-foreground" />
                    {generationBlocked ? (
                      <>
                        <p className="mt-2 text-sm font-medium">
                          Route generation is blocked by scheme validation
                        </p>
                        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                          Stops are created with generated routes. Resolve the
                          blocking issues via Edit on the Details tab first.
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="mt-2 text-sm font-medium">No Stops yet</p>
                        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                          Stops are created when routes are generated — rule
                          matches on the Details tab are a preview, never Stops.
                        </p>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                pageRows.map((stop) => {
                  const { pickup, date } = stop
                  const routeId = stopRouteId(stop)
                  return (
                    <TableRow
                      key={pickup.id}
                      {...(routeId
                        ? recordRowProps(pickup.facts.Route ?? "route", () =>
                            router.push(routeDetailsHref(routeId)),
                          )
                        : {})}
                    >
                      <TableCell className="min-w-[200px]">
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-foreground">
                            {date ? formatServiceDate(date) : "—"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {pickup.facts.Route ?? "—"}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm tabular-nums text-muted-foreground">
                        {pickup.facts.Stop ?? "—"}
                      </TableCell>
                      <TableCell className="min-w-[180px] text-sm text-foreground">
                        {schemeStopContainerLabel(pickup) ?? "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {pickup.facts["Container ID"] ?? "—"}
                      </TableCell>
                      <TableCell className="min-w-[160px] text-sm text-muted-foreground">
                        {schemeStopContainerType(pickup) ?? "—"}
                      </TableCell>
                      <TableCell>
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
                      <TableCell className="min-w-[130px] text-sm text-muted-foreground">
                        {pickup.facts["Waste fraction"] ?? "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {pickup.facts.Driver ?? "—"}
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
      </section>
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
              Holiday and non-working dates are skipped at generation.
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
