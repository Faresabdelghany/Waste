"use client"

// The Dashboard's Performance tab on the Pilot (#292, #291 slice 27): Improve's
// Performance module over the API's service and ticket reports, each read for
// the window and for the period before it. Four tiles — the collection rate,
// the missed pickups, the routes on time, the tickets opened — each against
// the period before; the pickups collected per interval beside the period
// before; the missed pickups by reason; the tickets; and the Route Schemes
// with their numbers, downloadable as the CSV of the rows shown; and the
// fleet's planned emissions (M10 of #293, emissions-card.tsx). A report
// whose rows the role may not read (`route-studio.routes`, `operate.tickets`)
// is not asked for, and its cards say so. What is shown while a read is on
// its way is the last answer, greyed; what a change is worked out from, and
// what a CSV is written from, is only ever the current window's own answer.

import { DownloadSimple } from "@phosphor-icons/react/dist/ssr"

import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { statusLabel } from "@/lib/api/records/adapter"
import { reportKey, serviceReport, ticketReport, type ReportWindowQuery } from "@/lib/api/reports"
import { csvFileName, csvOf, downloadCsv } from "@/lib/data/csv"
import { pickupReasonLabel } from "@/lib/data/routes"
import {
  countChange,
  countedOf,
  countOf,
  percentOf,
  rateChange,
  SCHEME_COLUMNS,
  schemeKeyOf,
  schemeNameOf,
  schemeRowOf,
  schemesByAttention,
  throughputOf,
} from "@/lib/insight/dashboard"

import { EmissionsCard } from "./emissions-card"
import { ReportCard, ReportNotice } from "./report-card"
import { comparisonOf, StatRow, StatTile } from "./stat-tile"
import { ThroughputChart } from "./throughput-chart"
import { useReport } from "./use-report"

export type TabProps = {
  /** The window asked for, and the period before it. */
  current: ReportWindowQuery
  previous: ReportWindowQuery
  /** The period before, "Oct 11 – Oct 17": what a change is told against. */
  against: string
  /** The modules the role views. */
  viewed: ReadonlySet<string>
  projectName: (id: string) => string
  /** The file names' stem: the project and the window. */
  fileStem: string
}

export function PerformanceTab({ current, previous, against, viewed, projectName, fileStem }: TabProps) {
  const routesShown = viewed.has("route-studio.routes")
  const ticketsShown = viewed.has("operate.tickets")
  const service = useReport(routesShown ? reportKey("service", current) : null, (client) => serviceReport(client, current))
  const servicePrevious = useReport(routesShown ? reportKey("service", previous) : null, (client) => serviceReport(client, previous))
  const tickets = useReport(ticketsShown ? reportKey("tickets", current) : null, (client) => ticketReport(client, current))
  const ticketsPrevious = useReport(ticketsShown ? reportKey("tickets", previous) : null, (client) => ticketReport(client, previous))

  // What is drawn: the window's answer or, while it is on its way, the last one, greyed.
  const shown = service.shown
  const ticketsNow = tickets.shown
  // What is counted from: the two periods' own answers, never one left over from another window or project.
  const now = service.report
  const before = servicePrevious.report
  const intervalWord = current.interval === "week" ? "week" : current.interval === "month" ? "month" : "day"
  const schemes = shown === null ? [] : schemesByAttention(shown)
  const maxMissed = Math.max(1, ...(shown?.missedByReason.map((reason) => reason.skipped + reason.failed) ?? []))
  const serviceComparison = service.loading ? "reading" : comparisonOf(servicePrevious)

  const exportSchemes = () => {
    if (now === null) return
    downloadCsv(
      csvFileName("route-schemes", fileStem),
      csvOf(
        [...SCHEME_COLUMNS],
        schemesByAttention(now).map((scheme) => schemeRowOf(scheme, projectName)),
      ),
    )
  }

  return (
    <div className="flex flex-col">
      <StatRow>
        {routesShown && shown !== null && !service.problem ? (
          <>
            <StatTile
              testId="kpi-collection-rate"
              label="Collection rate"
              value={percentOf(shown.rates.collection)}
              helper={`${countOf(shown.pickups.completed)} of ${countedOf(shown.pickups.completed + shown.pickups.missed, "pickup")} with an outcome`}
              change={now === null ? null : rateChange(now.rates.collection, before?.rates.collection, true)}
              comparison={serviceComparison}
              against={against}
              loading={service.loading}
            />
            <StatTile
              testId="kpi-missed"
              label="Missed pickups"
              value={countOf(shown.pickups.missed)}
              helper={`${percentOf(shown.rates.missed)} missed · ${countOf(shown.pickups.open)} still open`}
              change={now === null ? null : countChange(now.pickups.missed, before?.pickups.missed, false)}
              comparison={serviceComparison}
              against={against}
              loading={service.loading}
            />
            <StatTile
              testId="kpi-on-time"
              label="Routes on time"
              value={percentOf(shown.rates.onTime)}
              helper={`${countOf(shown.routes.onTime)} of ${countOf(shown.routes.onTime + shown.routes.late)} judged · ${countOf(shown.routes.started)} of ${countedOf(shown.routes.total, "route")} went out`}
              change={now === null ? null : rateChange(now.rates.onTime, before?.rates.onTime, true)}
              comparison={serviceComparison}
              against={against}
              loading={service.loading}
            />
          </>
        ) : (
          <div className="sm:col-span-2 xl:col-span-3">
            <ReportNotice notGranted={routesShown ? undefined : "routes"} problem={service.problem} />
          </div>
        )}
        {ticketsShown && ticketsNow !== null && !tickets.problem ? (
          <StatTile
            testId="kpi-tickets"
            label="Tickets opened"
            value={countOf(ticketsNow.opened)}
            helper={`${countOf(ticketsNow.open)} open now · ${countOf(ticketsNow.overdue)} overdue`}
            change={tickets.report === null ? null : countChange(tickets.report.opened, ticketsPrevious.report?.opened, false)}
            comparison={tickets.loading ? "reading" : comparisonOf(ticketsPrevious)}
            against={against}
            loading={tickets.loading}
          />
        ) : (
          <ReportNotice notGranted={ticketsShown ? undefined : "tickets"} problem={tickets.problem} />
        )}
      </StatRow>

      <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1.55fr)_minmax(300px,0.95fr)] lg:p-4">
        <ReportCard title="Pickups collected" subtitle={`Per ${intervalWord}, this period and the period before`} loading={service.loading || servicePrevious.loading} testId="throughput">
          {routesShown && shown !== null && !service.problem ? (
            <ThroughputChart points={throughputOf(shown.intervals, now === null ? undefined : (before?.intervals ?? undefined))} intervalWord={intervalWord} />
          ) : (
            <ReportNotice notGranted={routesShown ? undefined : "routes"} problem={service.problem} />
          )}
        </ReportCard>

        <ReportCard title="Missed pickups by reason" subtitle="Skipped and failed, the withdrawn left out" loading={service.loading} testId="missed-by-reason">
          {routesShown && shown !== null && !service.problem ? (
            shown.missedByReason.length === 0 ? (
              <ReportNotice empty="No pickup was missed in this period." />
            ) : (
              <ul className="divide-y divide-border/70">
                {shown.missedByReason.map((reason) => {
                  const missed = reason.skipped + reason.failed
                  return (
                    <li key={reason.reason} className="px-4 py-2.5">
                      <div className="flex items-baseline justify-between gap-3 text-xs">
                        <span className="text-foreground">{pickupReasonLabel(reason.reason)}</span>
                        <span className="tabular-nums text-muted-foreground">
                          <span className="font-medium text-foreground">{countOf(missed)}</span> · {countOf(reason.failed)} failed, {countOf(reason.skipped)} skipped
                        </span>
                      </div>
                      <div className="mt-1.5 h-1.5 rounded-full bg-muted" aria-hidden>
                        <div className="h-1.5 rounded-full bg-[var(--chart-1)]" style={{ width: `${(missed / maxMissed) * 100}%` }} />
                      </div>
                    </li>
                  )
                })}
              </ul>
            )
          ) : (
            <ReportNotice notGranted={routesShown ? undefined : "routes"} problem={service.problem} />
          )}
        </ReportCard>
      </div>

      <div className="grid gap-3 px-3 pb-3 lg:grid-cols-[minmax(0,1.55fr)_minmax(300px,0.95fr)] lg:px-4 lg:pb-4">
        <ReportCard
          title="Route schemes"
          subtitle="Their routes and pickups in this period, the most missed first"
          loading={service.loading}
          testId="route-schemes"
          actions={
            <Button variant="outline" size="sm" className="h-7 gap-1.5 bg-transparent text-xs" onClick={exportSchemes} disabled={now === null || now.schemes.length === 0}>
              <DownloadSimple className="h-3.5 w-3.5" />
              CSV
            </Button>
          }
        >
          {routesShown && shown !== null && !service.problem ? (
            schemes.length === 0 ? (
              <ReportNotice empty="No route operated in this period." />
            ) : (
              <div className="overflow-x-auto">
                <Table className="min-w-[560px] text-xs">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Route scheme</TableHead>
                      <TableHead className="text-right">Routes</TableHead>
                      <TableHead className="text-right">On time</TableHead>
                      <TableHead className="text-right">Pickups due</TableHead>
                      <TableHead className="text-right">Completed</TableHead>
                      <TableHead className="text-right">Missed</TableHead>
                      <TableHead className="text-right">Collection rate</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {schemes.map((scheme) => (
                      <TableRow key={schemeKeyOf(scheme)}>
                        <TableCell>
                          <span className="block font-medium text-foreground">{schemeNameOf(scheme)}</span>
                          <span className="block text-[10px] text-muted-foreground">{projectName(scheme.projectId)}</span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{countOf(scheme.routes.total)}</TableCell>
                        <TableCell className="text-right tabular-nums">{percentOf(scheme.rates.onTime)}</TableCell>
                        <TableCell className="text-right tabular-nums">{countOf(scheme.pickups.due)}</TableCell>
                        <TableCell className="text-right tabular-nums">{countOf(scheme.pickups.completed)}</TableCell>
                        <TableCell className="text-right tabular-nums">{countOf(scheme.pickups.missed)}</TableCell>
                        <TableCell className="text-right tabular-nums">{percentOf(scheme.rates.collection)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )
          ) : (
            <ReportNotice notGranted={routesShown ? undefined : "routes"} problem={service.problem} />
          )}
        </ReportCard>

        <ReportCard title="Tickets" subtitle="Opened and closed in this period, open now" loading={tickets.loading} testId="tickets">
          {ticketsShown && ticketsNow !== null && !tickets.problem ? (
            <div>
              <dl className="grid grid-cols-2 gap-px border-b border-border/70 bg-border/70 text-xs">
                {[
                  ["Closed", countOf(ticketsNow.closed)],
                  ["Closed by their due time", ticketsNow.closedWithDue === 0 ? "—" : `${percentOf(ticketsNow.rates.closedWithinDue)} of ${countOf(ticketsNow.closedWithDue)}`],
                  ["Open now", countOf(ticketsNow.open)],
                  ["Overdue now", countOf(ticketsNow.overdue)],
                ].map(([label, value]) => (
                  <div key={label} className="bg-card px-4 py-2.5">
                    <dt className="text-[11px] text-muted-foreground">{label}</dt>
                    <dd className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">{value}</dd>
                  </div>
                ))}
              </dl>
              {ticketsNow.byKind.length === 0 ? (
                <ReportNotice empty="No ticket in this period." />
              ) : (
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Kind</TableHead>
                      <TableHead className="text-right">Opened</TableHead>
                      <TableHead className="text-right">Closed</TableHead>
                      <TableHead className="text-right">Open</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ticketsNow.byKind.map((kind) => (
                      <TableRow key={kind.kind}>
                        <TableCell>{statusLabel(kind.kind)}</TableCell>
                        <TableCell className="text-right tabular-nums">{countOf(kind.opened)}</TableCell>
                        <TableCell className="text-right tabular-nums">{countOf(kind.closed)}</TableCell>
                        <TableCell className="text-right tabular-nums">{countOf(kind.open)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          ) : (
            <ReportNotice notGranted={ticketsShown ? undefined : "tickets"} problem={tickets.problem} />
          )}
        </ReportCard>
      </div>

      <div className="px-3 pb-3 lg:px-4 lg:pb-4">
        <EmissionsCard current={current} routesShown={routesShown} />
      </div>
    </div>
  )
}
