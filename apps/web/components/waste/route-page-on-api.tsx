"use client"

import { useMemo, type ReactNode } from "react"

import { PageTopBar } from "@/components/page-layout"
import { Breadcrumbs } from "@/components/projects/Breadcrumbs"
import { StatRow } from "@/components/projects/StatRow"
import { StatusBadge } from "@/components/ui/status-badge"
import { useModuleRecords } from "@/components/waste/business-record-store"
import { RouteSurfacePage } from "@/components/waste/commands/route-surfaces"
import { routeStatusTone, TicketsTab } from "@/components/waste/route-details-page"
import { TICKETS_MODULE } from "@/lib/api/records/tickets"
import type { BusinessRecord, ModuleDefinition } from "@/lib/data/business-modules"
import { cn } from "@/lib/utils"

/** No fixture tickets: on the Pilot a route's tickets are the API's alone. */
const NO_TICKETS: readonly BusinessRecord[] = []

/**
 * A route's own page on the Pilot, laid out as fixture mode's
 * `RouteDetailsPage`: its name and status in the top bar, the stops headed by
 * Dispatch and one Actions menu, the Map and Route information beside them,
 * then its tickets, sessions, Plans, messages and activity — every one
 * read from the API through its command surface (`RouteSurfacePage`).
 */
export function RouteDetailsOnApi({
  module,
  record,
  onBack,
  history,
  menu,
}: {
  module: ModuleDefinition
  record: BusinessRecord
  onBack: () => void
  /** The route's History, the API's audit log of the row. */
  history?: ReactNode
  /** The record's own actions (Delete, …), after the Actions menu. */
  menu?: ReactNode
}) {
  // The tickets about this route: a ticket names its route by the route's web id (`TICKET_LINKS`).
  const ticketRecords = useModuleRecords(TICKETS_MODULE.workspaceId, TICKETS_MODULE.moduleId, NO_TICKETS).records
  const tickets = useMemo(() => ticketRecords.filter((ticket) => ticket.submittedValues?.routeId === record.id), [record.id, ticketRecords])
  // Where it runs, then what made it and for which day, and whether the office holds it.
  const subtitle = [record.context, record.description].filter(Boolean).join(" · ")

  return (
    <section aria-label={record.name} className="flex min-h-0 flex-1 flex-col" data-testid="route-page">
      <header>
        <PageTopBar>
          <div className="flex flex-wrap items-center gap-2">
            <Breadcrumbs items={[{ label: module.label, onClick: onBack }, { label: record.name }]} />
            <StatusBadge outlined tone={routeStatusTone(record.status)} className="rounded-full text-[11px]">
              {record.status}
            </StatusBadge>
          </div>
          {subtitle && <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>}
        </PageTopBar>
      </header>
      <RouteSurfacePage
        record={record}
        menu={menu}
        history={history}
        tickets={{ count: tickets.length, content: <TicketsTab tickets={tickets} /> }}
        information={<RouteInformationOnApi record={record} />}
      />
    </section>
  )
}

/** The facts of the route's crew and places, under Assignment; the named ones read as links do. */
const ASSIGNMENT: ReadonlyArray<readonly [fact: string, label: string, named: boolean]> = [
  ["Vehicle", "Vehicle", true],
  ["Driver", "Driver", true],
  ["Trailer", "Trailer", true],
  ["Actual assignment", "Actual assignment", false],
  ["Service provider", "Service provider", true],
  ["Depot", "Depot", true],
  ["Unloading", "Unloading station", true],
  ["Route scheme", "Route scheme", true],
  ["Origin", "Origin", false],
]

/** The facts of when it runs and how long it takes, under Schedule. */
const SCHEDULE: ReadonlyArray<readonly [fact: string, label: string]> = [
  ["Service date", "Service date"],
  ["Planned start", "Planned start"],
  ["Distance", "Distance"],
  ["Duration", "Duration"],
  ["Stop time", "Stop time"],
  ["Dispatched at", "Dispatched at"],
  ["Started at", "Started at"],
  ["Completed at", "Completed at"],
  ["Cancelled at", "Cancelled at"],
]

/** The facts the panel's head and the page's top bar already say. */
const SHOWN_ABOVE = new Set(["Operating date", "Project", "Area"])

/**
 * The route's facts as fixture mode's Route information panel shows them: its
 * operating date and status, then Assignment and Schedule, and every other
 * fact the API gave under Details — none made up where the route has none.
 */
function RouteInformationOnApi({ record }: { record: BusinessRecord }) {
  const facts = record.facts
  const grouped = new Set([...SHOWN_ABOVE, ...ASSIGNMENT.map(([fact]) => fact), ...SCHEDULE.map(([fact]) => fact)])
  const sections: { title: string; rows: { label: string; value: string; named: boolean }[] }[] = [
    { title: "Assignment", rows: ASSIGNMENT.flatMap(([fact, label, named]) => (facts[fact] === undefined ? [] : [{ label, value: facts[fact], named }])) },
    { title: "Schedule", rows: SCHEDULE.flatMap(([fact, label]) => (facts[fact] === undefined ? [] : [{ label, value: facts[fact], named: false }])) },
    { title: "Details", rows: Object.entries(facts).flatMap(([label, value]) => (grouped.has(label) ? [] : [{ label, value, named: false }])) },
  ]

  return (
    <section className="min-w-0 px-5 py-5 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs text-muted-foreground">Operating date</p>
          <p className="mt-1 text-base font-semibold">{facts["Operating date"] ?? "Not set"}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">Route status</p>
          <StatusBadge outlined tone={routeStatusTone(record.status)} className="mt-1 rounded-full text-[11px]">
            {record.status}
          </StatusBadge>
        </div>
      </div>

      <div className="mt-7 space-y-7">
        {sections
          .filter((section) => section.rows.length > 0)
          .map((section) => (
            <section key={section.title} className="space-y-3.5">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{section.title}</h3>
              <div className="space-y-3.5">
                {section.rows.map((row) => (
                  <StatRow key={row.label} label={row.label} value={<span className={cn("block min-w-0 break-words", row.named && "text-primary")}>{row.value}</span>} />
                ))}
              </div>
            </section>
          ))}
      </div>
    </section>
  )
}
