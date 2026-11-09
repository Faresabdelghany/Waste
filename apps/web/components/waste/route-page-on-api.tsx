"use client"

import Link from "next/link"
import { useMemo, type ReactNode } from "react"
import { Ticket } from "@phosphor-icons/react/dist/ssr"

import { PageTopBar } from "@/components/page-layout"
import { Badge } from "@/components/ui/badge"
import { Breadcrumbs } from "@/components/ui/breadcrumbs"
import { Button } from "@/components/ui/button"
import { StatRow } from "@/components/ui/stat-row"
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { TablePagination, useTablePagination } from "@/components/ui/table-pagination"
import { useModuleRecords } from "@/components/platform/business-record-store"
import { RouteSurfacePage } from "@/components/waste/commands/route-surfaces"
import { TICKETS_MODULE } from "@/lib/data/tickets"
import { workspaceHref } from "@/lib/data/workspace-href"
import type { BusinessRecord, ModuleDefinition } from "@/lib/data/business-modules"
import { cn } from "@/lib/utils"

/**
 * A route's own page: its name and status in the top bar, the stops headed by
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
  const ticketRecords = useModuleRecords(TICKETS_MODULE.workspaceId, TICKETS_MODULE.moduleId).records
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
 * The route's facts: its operating date and status, then Assignment and
 * Schedule, and every other fact the API gave under Details — none made up
 * where the route has none.
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

function routeStatusTone(status: string): StatusTone {
  if (/active|completed|ready/i.test(status)) {
    return "success"
  }
  if (/attention|delayed|unassigned/i.test(status)) {
    return "warning"
  }
  return "neutral"
}

/** The tickets about a route, as its page's Tickets tab lists them. */
function TicketsTab({
  tickets,
}: {
  tickets: readonly BusinessRecord[]
}) {
  const {
    page: ticketsPage,
    setPage: setTicketsPage,
    pageCount: ticketsPageCount,
    pageRows: ticketsPageRows,
    totalCount: ticketsTotalCount,
  } = useTablePagination(tickets)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold">Tickets related to this Route</h2>
      </div>
      <div className="p-4">
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="border-b border-border px-4 py-2.5 text-xs text-muted-foreground">
            {tickets.length} {tickets.length === 1 ? "ticket" : "tickets"}
          </div>
          <div className="overflow-x-auto">
            <Table className="min-w-[900px]">
              <TableHeader className="bg-muted/30">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    Ticket
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    Type
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    Priority
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    Status
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground">
                    SLA
                  </TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tickets.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-52 text-center">
                      <Ticket className="mx-auto h-6 w-6 text-muted-foreground" />
                      <p className="mt-2 text-sm font-medium">No related tickets</p>
                    </TableCell>
                  </TableRow>
                ) : (
                  ticketsPageRows.map((ticketRecord) => (
                    <TableRow
                      key={ticketRecord.id}
                      className="hover:bg-muted/60"
                    >
                      <TableCell className="min-w-[260px] py-3">
                        <p className="text-sm font-medium text-foreground">
                          {ticketRecord.name}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {ticketRecord.context}
                        </p>
                      </TableCell>
                      <TableCell className="py-3 text-sm">
                        {ticketRecord.facts.Type ?? "Operational"}
                      </TableCell>
                      <TableCell className="py-3">
                        <Badge
                          variant="outline"
                          className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                        >
                          {ticketRecord.facts.Priority ?? "Normal"}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-3">
                        <StatusBadge outlined tone={routeStatusTone(ticketRecord.status)} className="rounded-full px-2 py-0.5 text-[11px] font-medium">
                          {ticketRecord.status}
                        </StatusBadge>
                      </TableCell>
                      <TableCell className="py-3 text-sm">
                        {ticketRecord.value}
                      </TableCell>
                      <TableCell className="py-3 text-right">
                        <Button variant="ghost" size="sm" asChild>
                          <Link
                            href={workspaceHref(TICKETS_MODULE, ticketRecord.id)}
                          >
                            Open
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <TablePagination
            page={ticketsPage}
            pageCount={ticketsPageCount}
            totalCount={ticketsTotalCount}
            onPageChange={setTicketsPage}
          />
        </div>
      </div>
    </div>
  )
}
