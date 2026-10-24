"use client"

// The Dashboard's Compliance tab on the Pilot (#291 slice 29): Improve's
// Compliance module over the API's waste-data report, the one the office
// files with the national waste-data system by hand. A filing's period
// (lib/insight/compliance.ts: the year before by default, the national
// system's), the Dashboard's project above it; the warnings to read before
// filing; the approved weight per municipality, unloading station and waste
// fraction with each fraction's waste code; and the file itself, downloaded
// as the API writes it (`GET /reports/waste-data.csv`), its separator by the
// browser's locale unless the person picks the other. The report is read
// under the weights' grant too, and a role without it is not asked for it.

import { useState } from "react"
import { DownloadSimple, WarningCircle } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useApiClient } from "@/components/waste/api-session-store"
import { problemSentence } from "@/lib/api/problem"
import { problemOfError } from "@/lib/api/records/server-records"
import { wasteDataFile, wasteDataKey, wasteDataReport, type FileSeparator, type WasteDataQuery } from "@/lib/api/reports"
import { downloadBlob } from "@/lib/data/csv"
import { COMPLIANCE_PERIODS, DEFAULT_PERIOD, periodLabel, periodOf, periodRefusal, SEPARATORS, separatorFor, wasteDataFileName, type CompliancePeriodId } from "@/lib/insight/compliance"
import { countedOf, countOf, WEIGHTS_MODULE, weightOf, type DayWindow } from "@/lib/insight/dashboard"

import { ReportCard, ReportNotice } from "./report-card"
import { StatRow, StatTile } from "./stat-tile"
import { useReport } from "./use-report"

export function ComplianceTab({ projectId, today, viewed }: { projectId?: string; today: string; viewed: ReadonlySet<string> }) {
  const client = useApiClient()
  const weightsShown = viewed.has(WEIGHTS_MODULE)
  const [periodId, setPeriodId] = useState<CompliancePeriodId>(DEFAULT_PERIOD)
  const [custom, setCustom] = useState<DayWindow>(() => periodOf(DEFAULT_PERIOD, today) ?? { from: today, to: today })
  // The tab mounts only once `/me` is read, in the browser, so the locale is the person's.
  const [separator, setSeparator] = useState<FileSeparator>(() => separatorFor(typeof navigator === "undefined" ? undefined : navigator.language))
  const [downloading, setDownloading] = useState(false)

  const period = periodOf(periodId, today) ?? custom
  const refusal = periodRefusal(period)
  const complete = refusal === null
  const query: WasteDataQuery = { projectId, ...period }
  const read = useReport(weightsShown && complete ? wasteDataKey(query) : null, (asking) => wasteDataReport(asking, query))
  const shown = read.shown
  const warnings = shown?.warnings ?? []
  const unreviewed = warnings.reduce((sum, warning) => (warning.kind === "not-reviewed" ? { kg: sum.kg + warning.netKg, unloads: sum.unloads + warning.unloads } : sum), { kg: 0, unloads: 0 })

  /** A day typed into the period: the period becomes the person's own from the days it held. */
  const spell = (end: keyof DayWindow, day: string) => {
    setCustom({ ...period, [end]: day })
    setPeriodId("custom")
  }

  const download = async () => {
    if (client === null || !complete) return
    setDownloading(true)
    try {
      const file = await wasteDataFile(client, query, separator)
      downloadBlob(wasteDataFileName(file.fileName, query), new Blob([file.bytes], { type: file.contentType ?? "text/csv;charset=utf-8" }))
    } catch (error) {
      toast.error("The waste-data file was not downloaded", { description: problemSentence(problemOfError(error)) })
    } finally {
      setDownloading(false)
    }
  }

  /** A preset picked; the custom period opens on the days on screen, for the person to move one end. */
  const pick = (id: CompliancePeriodId) => {
    if (id === "custom") setCustom(period)
    setPeriodId(id)
  }

  const notice = !weightsShown ? <ReportNotice notGranted="unloads" /> : refusal !== null ? <ReportNotice empty={refusal} /> : read.problem ? <ReportNotice problem={read.problem} /> : null

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-2.5 border-b border-border/70 px-3 py-3 sm:px-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={periodId} onValueChange={(value) => pick(value as CompliancePeriodId)}>
            <SelectTrigger className="h-8 w-[170px] bg-transparent text-xs" aria-label="Filing period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COMPLIANCE_PERIODS.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input type="date" className="h-8 w-[150px] bg-transparent text-xs" aria-label="First day" value={period.from} onChange={(event) => spell("from", event.target.value)} />
          <span className="text-xs text-muted-foreground">to</span>
          <Input type="date" className="h-8 w-[150px] bg-transparent text-xs" aria-label="Last day" value={period.to} onChange={(event) => spell("to", event.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={separator} onValueChange={(value) => setSeparator(value as FileSeparator)}>
            <SelectTrigger className="h-8 w-[130px] bg-transparent text-xs" aria-label="Separator">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEPARATORS.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="h-8 gap-1.5 bg-transparent text-xs" onClick={() => void download()} disabled={client === null || !weightsShown || !complete || downloading} data-testid="waste-data-download">
            <DownloadSimple className="h-3.5 w-3.5" />
            {downloading ? "Downloading…" : "Download CSV"}
          </Button>
        </div>
      </div>

      <StatRow>
        {notice === null && shown !== null ? (
          <>
            <StatTile testId="kpi-filed" label="To file" value={weightOf(shown.totals.netKg)} helper={countedOf(shown.totals.unloads, "approved unload")} loading={read.loading} />
            <StatTile testId="kpi-waste-data-rows" label="Rows" value={countOf(shown.rows.length)} helper="Municipality, station and fraction" loading={read.loading} />
            <StatTile testId="kpi-not-reviewed" label="Not reviewed" value={weightOf(unreviewed.kg)} helper={`${countedOf(unreviewed.unloads, "unload")}, in no row`} loading={read.loading} />
            <StatTile testId="kpi-warnings" label="Warnings" value={countOf(warnings.length)} helper={warnings.length === 0 ? "Ready to file" : "Read them before filing"} loading={read.loading} />
          </>
        ) : (
          <div className="sm:col-span-2 xl:col-span-4">{notice ?? <ReportNotice />}</div>
        )}
      </StatRow>

      <div className="flex flex-col gap-3 p-3 lg:p-4">
        {notice === null && warnings.length > 0 && (
          <ReportCard title="Before you file" subtitle="What the file warns of: each is a row of its own below its data rows" loading={read.loading} testId="waste-data-warnings">
            <ul className="divide-y divide-border/70">
              {warnings.map((warning, index) => (
                <li key={`${warning.kind}-${index}`} className="flex items-start gap-2 px-4 py-2.5 text-xs text-foreground">
                  <WarningCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                  <span>{warning.sentence}</span>
                </li>
              ))}
            </ul>
          </ReportCard>
        )}

        <ReportCard
          title="Waste data"
          subtitle={`Approved unloads${shown === null ? "" : `, ${periodLabel(shown.window)}`}, per municipality, unloading station and waste fraction, in kilograms`}
          loading={read.loading}
          testId="waste-data"
        >
          {notice ?? (shown === null ? (
            <ReportNotice />
          ) : shown.rows.length === 0 ? (
            <ReportNotice empty="No approved unload was recorded in this period." />
          ) : (
            <div className="overflow-x-auto">
              <Table className="min-w-[720px] text-xs" data-testid="waste-data-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Municipality</TableHead>
                    <TableHead>Unloading station</TableHead>
                    <TableHead>Waste fraction</TableHead>
                    <TableHead>Waste code</TableHead>
                    <TableHead className="text-right">Net kg</TableHead>
                    <TableHead className="text-right">Unloads</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.rows.map((row) => (
                    <TableRow key={[row.projectId, row.unloadingStationId, row.wasteFractionId].join("|")}>
                      <TableCell>{row.municipality}</TableCell>
                      <TableCell>{row.unloadingStationName}</TableCell>
                      <TableCell>{row.wasteFractionName}</TableCell>
                      <TableCell className="font-mono">{row.wasteCode ?? <span className="font-sans text-amber-700 dark:text-amber-400">None</span>}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{countOf(row.netKg)}</TableCell>
                      <TableCell className="text-right tabular-nums">{countOf(row.unloads)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ))}
        </ReportCard>
      </div>
    </div>
  )
}
