"use client"

// Plan Ahead auto-run (spec FR-11, ticket #8): when Route Studio loads, the
// next 7 days of routes are generated or refreshed for every scheme whose
// Plan Ahead toggle is on — same engine and idempotency rules as the manual
// Generate routes dialog, so repeated visits never duplicate. Renders
// nothing; mounted by BusinessWorkspace for the route-studio workspace. On
// the Pilot it never runs: the API holds the schemes and the routes, and its
// nightly sweep is the plan-ahead run (slice 3 of #81).

import { useEffect, useRef } from "react"
import { toast } from "sonner"

import { useApiConfigured } from "@/components/waste/api-session-store"
import {
  useBusinessRecordStore,
  useBusinessRecordsHydrated,
} from "@/components/waste/business-record-store"
import { useModuleRecords } from "@/components/waste/scheme-route-map"
import { COLLECTION_CALENDARS_MODULE } from "@/lib/data/collection-calendars"
import { runPlanAhead } from "@waste/domain/route-schemes/plan-ahead"
import { todayIso } from "@waste/domain/route-schemes/recurrence"

export function SchemePlanAheadRunner({ actorName }: { actorName: string }) {
  const hydrated = useBusinessRecordsHydrated()
  const onApi = useApiConfigured()
  const schemes = useModuleRecords("route-studio", "schemes")
  const existingRoutes = useModuleRecords("route-studio", "routes")
  const existingPickups = useModuleRecords("route-studio", "pickups")
  const calendarRecords = useModuleRecords(
    COLLECTION_CALENDARS_MODULE.workspaceId,
    COLLECTION_CALENDARS_MODULE.moduleId,
  )
  const projectRecords = useModuleRecords("configure", "organization")
  const containers = useModuleRecords("resources", "containers")
  const { upsertRecord } = useBusinessRecordStore()

  // Once per mount: the run's own upserts re-notify every store subscriber,
  // and an unguarded effect would replay the (idempotent, but not write-free)
  // refresh loop forever.
  const hasRun = useRef(false)

  useEffect(() => {
    if (onApi || !hydrated || hasRun.current) return
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
      projectRecords,
      containers,
      actorName: `Plan Ahead (${actorName})`,
      generatedAt: new Date().toISOString(),
    })
    for (const route of routes) upsertRecord("route-studio", "routes", route)
    for (const pickup of pickups) upsertRecord("route-studio", "pickups", pickup)
    // What each run left on its scheme (issue #25, issue #41): the
    // first-generation marker and promotion, and the matched-container stamp
    // when it moved. Only schemes with something new come back, so a quiet
    // load writes (and re-loops) nothing.
    for (const scheme of schemeStamps) {
      upsertRecord("route-studio", "schemes", scheme)
    }
    // A rule that resolved a different container set than its previous run
    // reshaped that scheme's routes without anyone at the dialog — say so.
    if (summary.containerDrift.length > 0) {
      toast.warning("Plan Ahead: matched containers shifted", {
        description: summary.containerDrift
          .map((entry) => `${entry.schemeName} — ${entry.warning}`)
          .join(" · "),
      })
    }
    // Quiet refreshes stay quiet — a toast on every visit would be noise.
    if (summary.created > 0 || summary.cancelled > 0) {
      toast.info("Plan Ahead generated routes", {
        description: [
          `${summary.created} created`,
          ...(summary.refreshed > 0 ? [`${summary.refreshed} refreshed`] : []),
          ...(summary.cancelled > 0 ? [`${summary.cancelled} cancelled`] : []),
          ...(summary.holidaySkipped > 0
            ? [`${summary.holidaySkipped} holiday-skipped`]
            : []),
          `${summary.schemes} scheme${summary.schemes === 1 ? "" : "s"}`,
        ].join(" · "),
      })
    }
  }, [
    actorName,
    calendarRecords,
    projectRecords,
    containers,
    existingPickups,
    existingRoutes,
    hydrated,
    onApi,
    schemes,
    upsertRecord,
  ])

  return null
}
