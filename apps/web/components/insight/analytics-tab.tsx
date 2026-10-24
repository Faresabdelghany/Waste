"use client"

// The Dashboard's Analytics tab on the Pilot (#292, #290 O12, #291 slice 27):
// Improve's Analytics module over the API's tonnage and revenue reports.
// Four tiles — the net tonnage against the period before, how much of it is
// reviewed, the rejected loads, what was weighed at the kerb — then the
// tonnage report rolled up by fraction, by station or by period (or every
// row), drawn and tabled, and downloadable as the CSV of the rows shown; and
// what was invoiced, by currency. The tonnage is read under
// `route-studio.weights` and the revenue under `commercial.invoices`; a role
// without one is not asked for it, and the card says so. As on Performance,
// what is drawn while a read is on its way is the last answer, greyed, and
// what is counted from or written to a CSV is the window's own.

import { useState } from "react"
import { DownloadSimple } from "@phosphor-icons/react/dist/ssr"
import { rate } from "@waste/domain/insight/readings"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { reportKey, revenueReport, tonnageReport } from "@/lib/api/reports"
import { formatMinor } from "@/lib/commercial/money"
import { csvFileName, csvOf, downloadCsv } from "@/lib/data/csv"
import {
  countChange,
  countedOf,
  countOf,
  intervalLabel,
  percentOf,
  REVENUE_MODULE,
  TONNAGE_GROUPINGS,
  tonnageCsvOf,
  tonnageLines,
  weightOf,
  WEIGHTS_MODULE,
  type TonnageGrouping,
} from "@/lib/insight/dashboard"

import type { TabProps } from "./performance-tab"
import { ReportCard, ReportNotice } from "./report-card"
import { comparisonOf, StatRow, StatTile } from "./stat-tile"
import { TonnageChart } from "./tonnage-chart"
import { useReport } from "./use-report"

export function AnalyticsTab({ current, previous, against, viewed, projectName, fileStem }: TabProps) {
  const weightsShown = viewed.has(WEIGHTS_MODULE)
  const revenueShown = viewed.has(REVENUE_MODULE)
  const tonnage = useReport(weightsShown ? reportKey("tonnage", current) : null, (client) => tonnageReport(client, current))
  const tonnagePrevious = useReport(weightsShown ? reportKey("tonnage", previous) : null, (client) => tonnageReport(client, previous))
  const revenue = useReport(revenueShown ? reportKey("revenue", current) : null, (client) => revenueReport(client, current))
  const [grouping, setGrouping] = useState<TonnageGrouping>("fraction")

  const shown = tonnage.shown
  const totals = shown?.totals
  const now = tonnage.report
  const before = tonnagePrevious.report
  const comparison = tonnage.loading ? "reading" : comparisonOf(tonnagePrevious)
  const lines = shown === null ? [] : tonnageLines(shown, grouping)
  const groupingLabel = TONNAGE_GROUPINGS.find((option) => option.id === grouping)?.label ?? ""
  // Every project's weights are told apart by their project.
  const byProject = current.projectId === undefined

  const exportTonnage = () => {
    if (now === null) return
    const { header, rows } = tonnageCsvOf(tonnageLines(now, grouping), grouping, projectName)
    downloadCsv(csvFileName("tonnage", groupingLabel, fileStem), csvOf(header, rows))
  }

  return (
    <div className="flex flex-col">
      <StatRow>
        {weightsShown && totals !== undefined && !tonnage.problem ? (
          <>
            <StatTile
              testId="kpi-net-tonnage"
              label="Net tonnage"
              value={weightOf(totals.netKg)}
              helper={`${countedOf(totals.unloads, "unload")} counted`}
              change={now === null ? null : countChange(now.totals.netKg, before?.totals.netKg, null)}
              comparison={comparison}
              against={against}
              loading={tonnage.loading}
            />
            <StatTile
              testId="kpi-reviewed"
              label="Reviewed"
              value={percentOf(rate(totals.approvedKg, totals.netKg))}
              helper={`${weightOf(totals.approvedKg)} approved · ${weightOf(totals.capturedKg)} not reviewed`}
              change={now === null ? null : countChange(now.totals.approvedKg, before?.totals.approvedKg, true)}
              comparison={comparison}
              against={against}
              loading={tonnage.loading}
            />
            <StatTile
              testId="kpi-rejected"
              label="Rejected loads"
              value={weightOf(totals.rejectedKg)}
              helper={`${countedOf(totals.rejectedUnloads, "unload")}, in no total`}
              change={now === null ? null : countChange(now.totals.rejectedKg, before?.totals.rejectedKg, false)}
              comparison={comparison}
              against={against}
              loading={tonnage.loading}
            />
            <StatTile
              testId="kpi-pickup-weights"
              label="Weighed at the kerb"
              value={weightOf(totals.pickupWeightKg)}
              helper={`${countedOf(totals.weighedPickups, "collected pickup")} weighed`}
              change={now === null ? null : countChange(now.totals.pickupWeightKg, before?.totals.pickupWeightKg, null)}
              comparison={comparison}
              against={against}
              loading={tonnage.loading}
            />
          </>
        ) : (
          <div className="sm:col-span-2 xl:col-span-4">
            <ReportNotice notGranted={weightsShown ? undefined : "unloads"} problem={tonnage.problem} />
          </div>
        )}
      </StatRow>

      <div className="flex flex-col gap-3 p-3 lg:p-4">
        <ReportCard
          title="Tonnage"
          subtitle="Net weight of the unloads that count — approved and not yet reviewed; rejected loads beside them"
          loading={tonnage.loading}
          testId="tonnage"
          actions={
            <>
              <Select value={grouping} onValueChange={(value) => setGrouping(value as TonnageGrouping)}>
                <SelectTrigger className="h-7 w-[132px] bg-transparent text-xs" aria-label="Group the tonnage">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TONNAGE_GROUPINGS.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" className="h-7 gap-1.5 bg-transparent text-xs" onClick={exportTonnage} disabled={now === null || now.unloads.length === 0}>
                <DownloadSimple className="h-3.5 w-3.5" />
                CSV
              </Button>
            </>
          }
        >
          {weightsShown && shown !== null && !tonnage.problem ? (
            lines.length === 0 ? (
              <ReportNotice empty="No unload was recorded in this period." />
            ) : (
              <>
                {grouping !== "all" && <TonnageChart lines={lines} orientation={grouping === "interval" ? "columns" : "bars"} />}
                <div className="overflow-x-auto border-t border-border/70">
                  <Table className="min-w-[640px] text-xs" data-testid="tonnage-table">
                    <TableHeader>
                      <TableRow>
                        {(grouping === "interval" || grouping === "all") && <TableHead>Period</TableHead>}
                        {grouping === "all" && <TableHead>Project</TableHead>}
                        {(grouping === "fraction" || grouping === "all") && <TableHead>Waste fraction</TableHead>}
                        {(grouping === "station" || grouping === "all") && <TableHead>Unloading station</TableHead>}
                        <TableHead className="text-right">Net</TableHead>
                        <TableHead className="text-right">Approved</TableHead>
                        <TableHead className="text-right">Not reviewed</TableHead>
                        <TableHead className="text-right">Unloads</TableHead>
                        <TableHead className="text-right">Rejected</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {lines.map((line) => (
                        <TableRow key={line.key}>
                          {(grouping === "interval" || grouping === "all") && <TableCell className="whitespace-nowrap">{line.period === null ? "" : intervalLabel(line.period)}</TableCell>}
                          {grouping === "all" && <TableCell>{line.projectId === null ? "" : projectName(line.projectId)}</TableCell>}
                          {(grouping === "fraction" || grouping === "all") && <TableCell>{line.fraction}</TableCell>}
                          {(grouping === "station" || grouping === "all") && <TableCell>{line.station}</TableCell>}
                          <TableCell className="text-right font-medium tabular-nums">{weightOf(line.netKg)}</TableCell>
                          <TableCell className="text-right tabular-nums">{weightOf(line.approvedKg)}</TableCell>
                          <TableCell className="text-right tabular-nums">{weightOf(line.capturedKg)}</TableCell>
                          <TableCell className="text-right tabular-nums">{countOf(line.unloads)}</TableCell>
                          <TableCell className="text-right tabular-nums">{line.rejectedKg === 0 ? "—" : weightOf(line.rejectedKg)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )
          ) : (
            <ReportNotice notGranted={weightsShown ? undefined : "unloads"} problem={tonnage.problem} />
          )}
        </ReportCard>

        <div className="grid gap-3 lg:grid-cols-2">
          <ReportCard title="Weighed at the kerb" subtitle="Collected pickups' latest weight readings, by fraction" loading={tonnage.loading} testId="pickup-weights">
            {weightsShown && shown !== null && !tonnage.problem ? (
              shown.pickupWeights.length === 0 ? (
                <ReportNotice empty="No collected pickup was weighed in this period." />
              ) : (
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Period</TableHead>
                      {byProject && <TableHead>Project</TableHead>}
                      <TableHead>Waste fraction</TableHead>
                      <TableHead className="text-right">Weight</TableHead>
                      <TableHead className="text-right">Pickups</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shown.pickupWeights.map((row) => (
                      <TableRow key={[row.from, row.projectId, row.wasteFractionId].join("|")}>
                        <TableCell className="whitespace-nowrap">{intervalLabel(row)}</TableCell>
                        {byProject && <TableCell>{projectName(row.projectId)}</TableCell>}
                        <TableCell>{row.wasteFractionName}</TableCell>
                        <TableCell className="text-right tabular-nums">{weightOf(row.weightKg)}</TableCell>
                        <TableCell className="text-right tabular-nums">{countOf(row.pickups)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )
            ) : (
              <ReportNotice notGranted={weightsShown ? undefined : "unloads"} problem={tonnage.problem} />
            )}
          </ReportCard>

          <ReportCard title="Invoiced" subtitle="Invoices and credit notes issued in this period, by currency" loading={revenue.loading} testId="revenue">
            {revenueShown && revenue.shown !== null && !revenue.problem ? (
              revenue.shown.currencies.length === 0 ? (
                <ReportNotice empty="Nothing was invoiced in this period." />
              ) : (
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Currency</TableHead>
                      <TableHead className="text-right">Invoices</TableHead>
                      <TableHead className="text-right">Credit notes</TableHead>
                      <TableHead className="text-right">Net</TableHead>
                      <TableHead className="text-right">Gross</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {revenue.shown.currencies.map((row) => (
                      <TableRow key={row.currency}>
                        <TableCell>{row.currency}</TableCell>
                        <TableCell className="text-right tabular-nums">{countOf(row.invoices)}</TableCell>
                        <TableCell className="text-right tabular-nums">{countOf(row.creditNotes)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMinor(row.netMinor, row.currency)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMinor(row.grossMinor, row.currency)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )
            ) : (
              <ReportNotice notGranted={revenueShown ? undefined : "invoices"} problem={revenue.problem} />
            )}
          </ReportCard>
        </div>
      </div>
    </div>
  )
}
