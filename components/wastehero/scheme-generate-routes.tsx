"use client"

// Generate routes action for Route Schemes (spec FR-6–FR-10, ticket #7):
// pick a window (default next 7 days), preview every planned upsert (create /
// refresh / leave untouched / cancel) with stops, assignment, and deviation
// notes, then confirm. Confirmation writes the dated Routes and their Pickups
// through the shared record store under the canonical Route Studio keys, so
// the results are visible in Route Studio → Routes / Pickups.
// Also renders the scheme detail's generated-route list (FR-13, ticket #9).

import Link from "next/link"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useBusinessRecordStore } from "@/components/wastehero/business-record-store"
import { statusClasses } from "@/components/wastehero/business-record-views"
import { useModuleRecords } from "@/components/wastehero/scheme-route-map"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { calendarFromRecord } from "@/lib/route-schemes/calendar"
import {
  applySchemeGeneration,
  approvedDeviationsFromRecords,
  lastGeneratedAt,
  planSchemeGeneration,
  schemeGeneratedRoutes,
  stringValueOf,
  type PlannedRouteAction,
} from "@/lib/route-schemes/generation"
import {
  recordSchemeGeneration,
  schemeCanGenerateRoutes,
  schemeGenerationRecorded,
} from "@/lib/route-schemes/lifecycle"
import {
  SERVICE_DAY_SHORT_LABELS,
  addDays,
  formatServiceDate,
  serviceDayOf,
  todayIso,
} from "@/lib/route-schemes/recurrence"
import { cn } from "@/lib/utils"

const ACTION_LABELS: Record<PlannedRouteAction, string> = {
  create: "Create",
  refresh: "Refresh",
  skip: "Untouched",
  cancel: "Cancel",
  omit: "Skipped",
}

const ACTION_BADGE_CLASSES: Record<PlannedRouteAction, string> = {
  create:
    "bg-teal-50 text-teal-700 border-transparent dark:bg-teal-500/15 dark:text-teal-100",
  refresh:
    "bg-blue-50 text-blue-700 border-transparent dark:bg-blue-500/15 dark:text-blue-100",
  skip: "border-transparent bg-muted text-muted-foreground",
  cancel:
    "bg-red-50 text-red-700 border-transparent dark:bg-red-500/15 dark:text-red-100",
  omit: "bg-amber-50 text-amber-700 border-transparent dark:bg-amber-500/15 dark:text-amber-100",
}

export function SchemeGenerateRoutesDialog({
  scheme,
  actorName,
  onClose,
}: {
  scheme: BusinessRecord | null
  actorName: string
  onClose: () => void
}) {
  // Default window: the next 7 days, starting tomorrow (today's routes are
  // already operating — same convention as the recurrence preview).
  const [fromDate, setFromDate] = useState(() => addDays(todayIso(), 1))
  const [toDate, setToDate] = useState(() => addDays(todayIso(), 7))

  const existingRoutes = useModuleRecords("route-studio", "routes")
  const existingPickups = useModuleRecords("route-studio", "pickups")
  const deviationRecords = useModuleRecords("plan", "collection-deviations")
  const calendarRecords = useModuleRecords("plan", "calendars")
  const containers = useModuleRecords("resources", "containers")
  const { upsertRecord } = useBusinessRecordStore()

  // The whole result is deterministic per (scheme, window, stored records),
  // so the preview and the confirm write the exact same records.
  const generation = useMemo(() => {
    if (!scheme || !fromDate || !toDate || toDate < fromDate) return null
    const calendarId = stringValueOf(scheme, "calendarId")
    const calendar = calendarId
      ? calendarFromRecord(
          calendarRecords.find((record) => record.id === calendarId),
        )
      : null
    const plan = planSchemeGeneration({
      scheme,
      window: { from: fromDate, to: toDate },
      existingRoutes,
      deviations: approvedDeviationsFromRecords(deviationRecords),
      // Rule-mode schemes (issue #19) resolve their stop-matching rules
      // against the live container records at plan time.
      containers,
      calendar,
    })
    if (!plan) return null
    return {
      plan,
      result: applySchemeGeneration({
        plan,
        existingPickups,
        containers,
        actorName,
      }),
    }
  }, [
    scheme,
    fromDate,
    toDate,
    existingRoutes,
    existingPickups,
    deviationRecords,
    calendarRecords,
    containers,
    actorName,
  ])

  const routesById = new Map(
    generation?.result.routes.map((route) => [route.id, route]) ?? [],
  )
  const writes = generation
    ? generation.result.summary.created +
      generation.result.summary.refreshed +
      generation.result.summary.cancelled
    : 0

  const confirm = () => {
    if (!generation || !scheme) return
    // Same plan the preview showed, re-applied with the confirm-time stamp
    // (deterministic inputs, so only generatedAt differs from the preview).
    const generatedAt = new Date().toISOString()
    const stamped = applySchemeGeneration({
      plan: generation.plan,
      existingPickups,
      containers,
      actorName,
      generatedAt,
    })
    for (const route of stamped.routes) {
      upsertRecord("route-studio", "routes", route)
    }
    for (const pickup of stamped.pickups) {
      upsertRecord("route-studio", "pickups", pickup)
    }
    // First successful generation → Scheduled (D25/issue #25): the persisted
    // marker the derived lifecycle status reads. Later runs never restamp.
    if (!schemeGenerationRecorded(scheme)) {
      upsertRecord(
        "route-studio",
        "schemes",
        recordSchemeGeneration(scheme, generatedAt),
      )
    }
    const { summary } = stamped
    toast.success(
      `${summary.created + summary.refreshed} route${
        summary.created + summary.refreshed === 1 ? "" : "s"
      } generated`,
      {
        description: [
          `${summary.created} created`,
          `${summary.refreshed} refreshed`,
          ...(summary.cancelled > 0 ? [`${summary.cancelled} cancelled`] : []),
          ...(summary.skipped > 0 ? [`${summary.skipped} left untouched`] : []),
          ...(summary.calendarSkipped > 0
            ? [`${summary.calendarSkipped} calendar-skipped`]
            : []),
          `${summary.pickups} pickups`,
        ].join(" · "),
      },
    )
    onClose()
  }

  return (
    <Dialog open={Boolean(scheme)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        {scheme && (
          <>
            <DialogHeader>
              <DialogTitle>Generate routes</DialogTitle>
              <DialogDescription>
                {scheme.name} · one dated Planned route per service day, one
                pickup per container in that day&apos;s plan. Re-running the
                same window updates instead of duplicating.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="generate-from">From</Label>
                <Input
                  id="generate-from"
                  type="date"
                  value={fromDate}
                  onChange={(event) => setFromDate(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="generate-to">To</Label>
                <Input
                  id="generate-to"
                  type="date"
                  value={toDate}
                  min={fromDate || undefined}
                  onChange={(event) => setToDate(event.target.value)}
                />
              </div>
            </div>

            <div className="max-h-72 overflow-y-auto rounded-xl border border-border/60">
              {!generation || generation.plan.routes.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {toDate && fromDate && toDate < fromDate
                    ? "The To date must be on or after the From date."
                    : "No service dates fall inside this window."}
                </p>
              ) : (
                <div className="divide-y divide-border/60">
                  {generation.plan.routes.map((planned) => {
                    const record = routesById.get(planned.routeId)
                    const deviationNote = record?.facts.Deviation
                    return (
                      <div
                        key={planned.routeId}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm"
                      >
                        <Badge
                          variant="outline"
                          className={cn(
                            "w-20 justify-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                            ACTION_BADGE_CLASSES[planned.action],
                          )}
                        >
                          {ACTION_LABELS[planned.action]}
                        </Badge>
                        <span className="w-24 font-medium">
                          {formatServiceDate(planned.actualDate)}
                        </span>
                        <span className="w-9 text-xs text-muted-foreground">
                          {SERVICE_DAY_SHORT_LABELS[planned.day]}
                        </span>
                        <span className="font-mono text-xs">{planned.routeName}</span>
                        {planned.action !== "cancel" && planned.action !== "omit" && (
                          <span className="text-xs text-muted-foreground">
                            {planned.containerIds.length} stop
                            {planned.containerIds.length === 1 ? "" : "s"}
                            {record
                              ? ` · ${record.facts.Driver ?? "Unassigned"} · ${record.facts.Vehicle ?? "Unassigned"}`
                              : ""}
                          </span>
                        )}
                        {planned.action === "skip" && planned.note && (
                          <span className="text-xs text-muted-foreground">
                            {planned.note}
                          </span>
                        )}
                        {planned.action === "omit" && planned.note && (
                          <span className="text-xs text-amber-700 dark:text-amber-400">
                            {planned.note} — create a Collection Deviation to
                            move this service
                          </span>
                        )}
                        {planned.action === "cancel" && (
                          <span className="text-xs text-red-600 dark:text-red-400">
                            {planned.note}
                          </span>
                        )}
                        {planned.action !== "cancel" &&
                          deviationNote &&
                          deviationNote !== "None" && (
                          <span className="basis-full pl-[92px] text-xs text-amber-700 dark:text-amber-400">
                            {deviationNote}
                          </span>
                        )}
                        {planned.calendarWarning && (
                          <span className="basis-full pl-[92px] text-xs text-amber-700 dark:text-amber-400">
                            {planned.calendarWarning}
                          </span>
                        )}
                        {planned.matchWarning && (
                          <span className="basis-full pl-[92px] text-xs text-amber-700 dark:text-amber-400">
                            {planned.matchWarning} — add matching containers or
                            adjust the scheme&apos;s stop rule
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {generation && (
              <p className="text-xs text-muted-foreground">
                Scheme version {generation.plan.schemeVersion} is pinned on every
                generated route. Ready, Active, Completed, and Cancelled routes
                are never touched. Holiday and non-working dates on the
                scheme&apos;s Collection Calendar are skipped unless an approved
                deviation moves them.
              </p>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={confirm} disabled={writes === 0}>
                {writes === 0
                  ? "Nothing to generate"
                  : `Confirm ${writes} route${writes === 1 ? "" : "s"}`}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/* -------------------- scheme detail route list (FR-13) -------------------- */

const GENERATED_AT_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
})

/** The date a listed route operates on — deviation-remapped when one applies. */
function routeDisplayDate(route: BusinessRecord): string | undefined {
  return stringValueOf(route, "actualDate") ?? stringValueOf(route, "serviceDate")
}

function GeneratedRouteRow({ route }: { route: BusinessRecord }) {
  const actualDate = routeDisplayDate(route)
  const stops = route.facts.Stops ?? "0"
  const isCancelled = route.status === "Cancelled"
  // Planned vs actual assignment stay distinct (FR-12): flag drift from what
  // generation last applied so overrides are visible from the scheme.
  const isOverridden =
    (stringValueOf(route, "appliedDriver") &&
      route.facts.Driver !== stringValueOf(route, "appliedDriver")) ||
    (stringValueOf(route, "appliedVehicle") &&
      route.facts.Vehicle !== stringValueOf(route, "appliedVehicle"))
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
      <span className="w-24 font-medium">
        {actualDate ? formatServiceDate(actualDate) : "—"}
      </span>
      <span className="w-9 text-xs text-muted-foreground">
        {actualDate ? SERVICE_DAY_SHORT_LABELS[serviceDayOf(actualDate)] : ""}
      </span>
      <Link
        href={`/route-studio?module=routes&record=${route.id}`}
        className="font-mono text-xs underline-offset-4 hover:underline"
      >
        {route.name}
      </Link>
      <Badge
        variant="outline"
        className={cn(
          "rounded-full px-2 py-0.5 text-[11px] font-medium",
          statusClasses(route.status),
        )}
      >
        {route.status}
      </Badge>
      <span className="text-xs text-muted-foreground">
        {route.facts.Driver ?? "Unassigned"} · {route.facts.Vehicle ?? "Unassigned"} ·{" "}
        {stops} stop{stops === "1" ? "" : "s"}
      </span>
      {isOverridden && (
        <span className="text-xs text-amber-700 dark:text-amber-400">
          Override
        </span>
      )}
      {isCancelled && route.facts.Deviation && (
        <span className="basis-full text-xs text-red-600 dark:text-red-400">
          {route.facts.Deviation}
        </span>
      )}
    </div>
  )
}

/**
 * The scheme detail's generated-route list (FR-13, ticket #9): upcoming and
 * past routes with date, status, assignment, and stop count, plus the newest
 * generation stamp. Reads the live Route Studio routes, so reassignments and
 * regenerations show without reopening the sheet.
 */
export function SchemeGeneratedRoutesSection({
  record,
}: {
  record: BusinessRecord
}) {
  const allRoutes = useModuleRecords("route-studio", "routes")
  const routes = schemeGeneratedRoutes(record.id, allRoutes)
  if (routes.length === 0 && !schemeCanGenerateRoutes(record, todayIso())) {
    return null
  }

  // Group and order by the operating date the rows display (deviation-remapped),
  // not the identity serviceDate — a remap across today must not file a future
  // route under Past.
  const today = todayIso()
  const byDisplayDate = routes
    .slice()
    .sort((a, b) =>
      (routeDisplayDate(a) ?? "").localeCompare(routeDisplayDate(b) ?? ""),
    )
  const isUpcoming = (route: BusinessRecord) =>
    (routeDisplayDate(route) ?? "") >= today
  const upcoming = byDisplayDate.filter(isUpcoming)
  // Most recent past date first — the reader scans backwards from today.
  const past = byDisplayDate.filter((route) => !isUpcoming(route)).reverse()
  const generatedStamp = lastGeneratedAt(routes)

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Generated routes</h3>
        {generatedStamp && (
          <span className="text-xs text-muted-foreground">
            Last generated {GENERATED_AT_FORMAT.format(new Date(generatedStamp))}
          </span>
        )}
      </div>
      {routes.length === 0 ? (
        <p className="rounded-xl border border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
          No routes generated yet. Use Generate routes or turn on Plan Ahead.
        </p>
      ) : (
        <div className="rounded-xl border border-border/60">
          {[
            { label: "Upcoming", rows: upcoming },
            { label: "Past", rows: past },
          ]
            .filter((group) => group.rows.length > 0)
            .map((group) => (
              <div key={group.label}>
                <p className="border-b border-border/60 bg-muted/40 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {group.label} · {group.rows.length}
                </p>
                <div className="divide-y divide-border/60">
                  {group.rows.map((route) => (
                    <GeneratedRouteRow key={route.id} route={route} />
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}
    </section>
  )
}
