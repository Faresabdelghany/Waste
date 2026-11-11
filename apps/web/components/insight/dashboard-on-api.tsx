"use client"

// The Dashboard (#292, #291 slice 27): `/performance` reads the API's
// reports for the person's projects, and without the API it says they are
// kept there. It is Improve's Performance, shown to a role that views it
// (`/me`'s grants). One row of filters scopes everything below it — the
// project (one of `/me`'s, or every one) and the period (the last 7, 30 or
// 90 days, ending today on the project's clock), every change told against
// the period of the same length before it (`previousWindow`).

import { useMemo, useState } from "react"
import Link from "next/link"
import { UploadSimple } from "@phosphor-icons/react/dist/ssr"
import type { ModuleKey } from "@waste/domain/access/modules"

import { Breadcrumbs } from "@/components/ui/breadcrumbs"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CONTENT_FRAME, PageActions, PageTopBar } from "@/components/page-layout"
import { useApiConfigured, useApiSession } from "@/components/platform/api-session-store"
import { modulesMayView } from "@/lib/modules/grants"
import { keptOnApi } from "@/lib/api/records/server-records"
import { useBusinessRecordStore } from "@/components/platform/business-record-store"
import { cn } from "@/lib/utils"
import { projectWebIdOf } from "@/lib/api/records/me-projects"
import type { ReportWindowQuery } from "@/lib/api/reports"
import { mayView as mayViewImports } from "@/lib/imports/import-file"
import { dayIn } from "@/lib/format/clock"
import { timezoneOfProject } from "@/lib/data/route-schemes"
import { DASHBOARD_RANGES, DEFAULT_RANGE, intervalLabel, PERFORMANCE_MODULE, previousWindow, rangeOf, windowEnding, type DashboardRangeId } from "@/lib/insight/dashboard"

import { PerformanceCards } from "./performance-cards"
import { ReportNotice } from "./report-card"
import { useGrants } from "@/components/platform/use-grants"

const ALL = "all"

export function DashboardOnApi() {
  const onApi = useApiConfigured()
  const { me } = useApiSession()
  const { getRecords } = useBusinessRecordStore()
  const [projectChoice, setProjectChoice] = useState<string>(ALL)
  const [rangeId, setRangeId] = useState<DashboardRangeId>(DEFAULT_RANGE)

  const projects = useMemo(() => me?.projects ?? [], [me])
  const grants = useGrants()
  // In fixture mode the Dashboard is the prototype's control room: no report, no Imports.
  const viewed = useMemo(() => (onApi ? modulesMayView(grants) : new Set<ModuleKey>()), [onApi, grants])
  const projectId = projects.some((candidate) => candidate.id === projectChoice) ? projectChoice : undefined
  const projectName = (id: string) => projects.find((candidate) => candidate.id === id)?.name ?? id

  // Today on the project's clock where the store holds its timezone — the one asked for, else the person's first — and the browser's otherwise.
  const clockProject = projects.find((candidate) => candidate.id === projectId) ?? projects[0]
  const timezone = clockProject === undefined ? undefined : timezoneOfProject(getRecords("configure", "organization"), projectWebIdOf(clockProject))
  const today = dayIn(new Date(), timezone)

  const range = rangeOf(rangeId)
  const window = windowEnding(today, range.days)
  const before = previousWindow(window, range.interval)
  const current: ReportWindowQuery = { projectId, ...window, interval: range.interval }
  const previous: ReportWindowQuery = { projectId, ...before, interval: range.interval }
  const against = intervalLabel(before)
  const fileStem = `${projectId === undefined ? "all-projects" : projectName(projectId)} ${window.from} ${window.to}`

  return (
    <div className={cn("m-2 flex min-w-0 flex-1 flex-col gap-0 overflow-hidden", CONTENT_FRAME)} data-testid="dashboard-on-api">
      <header className="shrink-0 border-b border-border/70">
        <PageTopBar>
          <Breadcrumbs items={[{ label: "Dashboard" }]} />
        </PageTopBar>
        <div className="flex flex-col gap-2.5 px-3 py-3 sm:px-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={rangeId} onValueChange={(value) => setRangeId(value as DashboardRangeId)}>
              <SelectTrigger className="h-8 w-[150px] bg-transparent text-xs" aria-label="Period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DASHBOARD_RANGES.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={projectId ?? ALL} onValueChange={setProjectChoice}>
              <SelectTrigger className="h-8 w-[200px] bg-transparent text-xs" aria-label="Project">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All projects</SelectItem>
                {projects.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-[11px] text-muted-foreground" data-testid="dashboard-window">
              {intervalLabel(window)}, {window.to.slice(0, 4)} · against {against}
            </p>
            {/* Improve's Imports (#291 slice 12), for a role that reads them. */}
            {onApi && mayViewImports(grants) && (
              <PageActions>
                <Button asChild variant="outline" size="sm">
                  <Link href="/improve/imports" data-testid="dashboard-imports">
                    <UploadSimple className="h-4 w-4" />
                    Imports
                  </Link>
                </Button>
              </PageActions>
            )}
          </div>
        </div>
      </header>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {!onApi ? (
          <ReportNotice empty={keptOnApi("The Dashboard")} />
        ) : me === null ? (
          <ReportNotice />
        ) : !viewed.has(PERFORMANCE_MODULE) ? (
          <ReportNotice notGranted="Dashboard's reports" />
        ) : (
          <PerformanceCards current={current} previous={previous} against={against} viewed={viewed} projectName={projectName} fileStem={fileStem} />
        )}
      </main>
    </div>
  )
}
