"use client"

// Plan Ahead auto-run (spec FR-11, ticket #8): when Route Studio loads, the
// next 7 days of routes are generated or refreshed for every scheme whose
// Plan Ahead toggle is on — same engine and idempotency rules as the manual
// Generate routes dialog, so repeated visits never duplicate. Renders
// nothing; mounted by BusinessWorkspace for the route-studio workspace.

import { useEffect, useRef } from "react"
import { toast } from "sonner"

import {
  useBusinessRecordStore,
  useBusinessRecordsHydrated,
} from "@/components/wastehero/business-record-store"
import { useModuleRecords } from "@/components/wastehero/scheme-route-map"
import { runPlanAhead } from "@/lib/route-schemes/plan-ahead"
import { todayIso } from "@/lib/route-schemes/recurrence"

export function SchemePlanAheadRunner({ actorName }: { actorName: string }) {
  const hydrated = useBusinessRecordsHydrated()
  const schemes = useModuleRecords("route-studio", "schemes")
  const existingRoutes = useModuleRecords("route-studio", "routes")
  const existingPickups = useModuleRecords("route-studio", "pickups")
  const calendarRecords = useModuleRecords("plan", "calendars")
  const containers = useModuleRecords("resources", "containers")
  const { upsertRecord } = useBusinessRecordStore()

  // Once per mount: the run's own upserts re-notify every store subscriber,
  // and an unguarded effect would replay the (idempotent, but not write-free)
  // refresh loop forever.
  const hasRun = useRef(false)

  useEffect(() => {
    if (!hydrated || hasRun.current) return
    hasRun.current = true
    const {
      routes,
      pickups,
      schemes: schemeStamps,
      summary,
    } = runPlanAhead({
      schemes,
      today: todayIso(),
      existingRoutes,
      existingPickups,
      calendarRecords,
      containers,
      actorName: `Plan Ahead (${actorName})`,
      generatedAt: new Date().toISOString(),
    })
    for (const route of routes) upsertRecord("route-studio", "routes", route)
    for (const pickup of pickups) upsertRecord("route-studio", "pickups", pickup)
    // First-generation lifecycle stamps (issue #25): Validated → Scheduled
    // plus the persisted marker. Only unrecorded schemes come back, so this
    // cannot re-write (and re-loop) on later visits.
    for (const scheme of schemeStamps) {
      upsertRecord("route-studio", "schemes", scheme)
    }
    // Quiet refreshes stay quiet — a toast on every visit would be noise.
    if (summary.created > 0 || summary.cancelled > 0) {
      toast.info("Plan Ahead generated routes", {
        description: [
          `${summary.created} created`,
          ...(summary.refreshed > 0 ? [`${summary.refreshed} refreshed`] : []),
          ...(summary.cancelled > 0 ? [`${summary.cancelled} cancelled`] : []),
          ...(summary.calendarSkipped > 0
            ? [`${summary.calendarSkipped} calendar-skipped`]
            : []),
          `${summary.schemes} scheme${summary.schemes === 1 ? "" : "s"}`,
        ].join(" · "),
      })
    }
  }, [
    actorName,
    calendarRecords,
    containers,
    existingPickups,
    existingRoutes,
    hydrated,
    schemes,
    upsertRecord,
  ])

  return null
}
