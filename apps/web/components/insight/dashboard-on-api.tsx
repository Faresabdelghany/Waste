"use client"

// The Dashboard on the Pilot (#292, #291 slices 27 and 29, #290 O12):
// `/performance` reads the API's reports for the person's projects, in place
// of the fixture control room the prototype shows without the API. Its tabs
// are Improve's modules, Performance, Analytics and Compliance, each shown to
// a role that views it (`/me`'s grants). One row of filters scopes everything
// below it — the project (one of `/me`'s, or every one) and, for Performance
// and Analytics, the period (the last 7, 30 or 90 days, ending today on the
// project's clock), every change told against the period of the same length
// before it (`previousWindow`). Compliance asks for a filing's period of its
// own (compliance-tab.tsx), so the header offers it no period. A tab, once
// opened, stays mounted and keeps its reads, so going back to it asks
// nothing again.

import { useMemo, useState } from "react"
import Link from "next/link"
import { UploadSimple } from "@phosphor-icons/react/dist/ssr"

import { Breadcrumbs } from "@/components/projects/Breadcrumbs"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useApiSession } from "@/components/waste/api-session-store"
import { useBusinessRecordStore } from "@/components/waste/business-record-store"
import { projectWebIdOf } from "@/lib/api/records/me-projects"
import type { ReportWindowQuery } from "@/lib/api/reports"
import { getModuleDefinition } from "@/lib/data/business-modules"
import { mayView as mayViewImports } from "@/lib/imports/import-file"
import { projectToday, timezoneOfProject } from "@/lib/data/route-schemes"
import {
  DASHBOARD_RANGES,
  DEFAULT_RANGE,
  intervalLabel,
  previousWindow,
  rangeOf,
  tabsShown,
  viewedModules,
  windowEnding,
  type DashboardRangeId,
  type DashboardTabId,
} from "@/lib/insight/dashboard"

import { AnalyticsTab } from "./analytics-tab"
import { ComplianceTab } from "./compliance-tab"
import { PerformanceTab } from "./performance-tab"
import { ReportNotice } from "./report-card"

const ALL = "all"

export function DashboardOnApi() {
  const { me } = useApiSession()
  const { getRecords } = useBusinessRecordStore()
  const [projectChoice, setProjectChoice] = useState<string>(ALL)
  const [rangeId, setRangeId] = useState<DashboardRangeId>(DEFAULT_RANGE)
  const [tabChoice, setTabChoice] = useState<DashboardTabId | null>(null)
  const [visited, setVisited] = useState<ReadonlySet<DashboardTabId>>(() => new Set())

  const projects = useMemo(() => me?.projects ?? [], [me])
  const viewed = useMemo(() => viewedModules(me?.role.grants), [me])
  const tabs = tabsShown(viewed)
  const tab = tabs.find((candidate) => candidate.id === tabChoice) ?? tabs[0]
  const projectId = projects.some((candidate) => candidate.id === projectChoice) ? projectChoice : undefined
  const projectName = (id: string) => projects.find((candidate) => candidate.id === id)?.name ?? id

  // Today on the project's clock where the store holds its timezone — the one asked for, else the person's first — and the browser's otherwise.
  const organisation = getModuleDefinition({ workspaceId: "configure", moduleId: "organization" })?.records ?? []
  const clockProject = projects.find((candidate) => candidate.id === projectId) ?? projects[0]
  const timezone = clockProject === undefined ? undefined : timezoneOfProject(getRecords("configure", "organization", organisation), projectWebIdOf(clockProject, organisation))
  const today = projectToday(timezone)

  const range = rangeOf(rangeId)
  const window = windowEnding(today, range.days)
  const before = previousWindow(window, range.interval)
  const current: ReportWindowQuery = { projectId, ...window, interval: range.interval }
  const previous: ReportWindowQuery = { projectId, ...before, interval: range.interval }
  const against = intervalLabel(before)
  const fileStem = `${projectId === undefined ? "all-projects" : projectName(projectId)} ${window.from} ${window.to}`

  const choose = (id: DashboardTabId) => {
    setTabChoice(id)
    setVisited((opened) => new Set(opened).add(id))
  }
  const mounted = (id: DashboardTabId) => tab?.id === id || visited.has(id)
  // Compliance's period is its own: the header's is Performance's and Analytics'.
  const windowed = tab?.id !== "compliance"

  return (
    <Tabs value={tab?.id ?? ""} onValueChange={(value) => choose(value as DashboardTabId)} className="m-2 flex min-w-0 flex-1 flex-col gap-0 overflow-hidden rounded-lg border border-sidebar bg-background" data-testid="dashboard-on-api">
      <header className="shrink-0 border-b border-border/70">
        <div className="flex min-h-14 items-center gap-3 border-b border-border/70 px-3 sm:px-4">
          <SidebarTrigger className="h-8 w-8 shrink-0 rounded-md text-muted-foreground hover:bg-accent" />
          <div className="min-w-0 flex-1">
            <Breadcrumbs items={[{ label: "Dashboard" }]} />
            <p className="hidden text-[11px] text-muted-foreground sm:block">Service, tickets, tonnage, invoicing and the waste-data filing, counted by the API</p>
          </div>
          {/* Improve's Imports (#291 slice 12), for a role that reads them. */}
          {mayViewImports(me?.role.grants) && (
            <Button asChild variant="outline" size="sm" className="h-8 shrink-0 text-xs">
              <Link href="/improve/imports" data-testid="dashboard-imports">
                <UploadSimple className="h-4 w-4" />
                Imports
              </Link>
            </Button>
          )}
        </div>
        <div className="flex flex-col gap-2.5 px-3 py-3 sm:px-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            {windowed && (
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
            )}
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
            {tabs.length > 1 && (
              <TabsList className="h-8">
                {tabs.map((candidate) => (
                  <TabsTrigger key={candidate.id} value={candidate.id} className="text-xs">
                    {candidate.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            )}
          </div>
          {windowed && (
            <p className="text-[11px] text-muted-foreground" data-testid="dashboard-window">
              {intervalLabel(window)}, {window.to.slice(0, 4)} · against {against}
            </p>
          )}
        </div>
      </header>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {me === null ? (
          <ReportNotice />
        ) : tab === undefined ? (
          <ReportNotice notGranted="Dashboard's modules" />
        ) : (
          <>
            {tabs.some((candidate) => candidate.id === "performance") && (
              <TabsContent value="performance" forceMount hidden={tab.id !== "performance"} className="mt-0">
                {mounted("performance") && <PerformanceTab current={current} previous={previous} against={against} viewed={viewed} projectName={projectName} fileStem={fileStem} />}
              </TabsContent>
            )}
            {tabs.some((candidate) => candidate.id === "analytics") && (
              <TabsContent value="analytics" forceMount hidden={tab.id !== "analytics"} className="mt-0">
                {mounted("analytics") && <AnalyticsTab current={current} previous={previous} against={against} viewed={viewed} projectName={projectName} fileStem={fileStem} />}
              </TabsContent>
            )}
            {tabs.some((candidate) => candidate.id === "compliance") && (
              <TabsContent value="compliance" forceMount hidden={tab.id !== "compliance"} className="mt-0">
                {mounted("compliance") && <ComplianceTab projectId={projectId} today={today} viewed={viewed} />}
              </TabsContent>
            )}
          </>
        )}
      </main>
    </Tabs>
  )
}
