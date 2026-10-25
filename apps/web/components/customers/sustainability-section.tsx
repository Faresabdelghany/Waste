"use client"
// A Customer's sustainability report in its details (M13 of #293), asked
// for when the person wants it — a year of stops is no read to make on every
// customer opened: a Compliance period, last year by default, or the
// person's own window, then the report the API answers for it (`GET
// /reports/sustainability`), the file as the API writes it, and the
// printable page. While a new window's report is on its way the last one is
// greyed, never shown as the new one's. Read under the customers' grant and
// the stops', and a role without both is told so, not asked. Today is on the
// customer's project's clock where the record names one, the browser's
// otherwise.
import { useState } from "react"
import Link from "next/link"
import { DownloadSimple, Printer } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { useReport } from "@/components/insight/use-report"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useApiClient, useApiSession } from "@/components/waste/api-session-store"
import { useServerModuleState } from "@/components/waste/business-record-store"
import { useProjectTimezone } from "@/components/waste/commands/use-command-support"
import { problemSentence } from "@/lib/api/problem"
import { problemOfError } from "@/lib/api/records/server-records"
import { sustainabilityFile, sustainabilityKey, sustainabilityReport, type FileSeparator, type SustainabilityQuery } from "@/lib/api/reports"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { downloadBlob } from "@/lib/data/csv"
import { CONTACTS_MODULE } from "@/lib/data/properties"
import { projectToday } from "@/lib/data/route-schemes"
import { COMPLIANCE_PERIODS, DEFAULT_PERIOD, periodOf, SEPARATORS, separatorFor, type CompliancePeriodId } from "@/lib/insight/compliance"
import type { DayWindow } from "@/lib/insight/dashboard"
import { reportShowsAny, sustainabilityFileName, sustainabilityPrintHref, sustainabilityReadable, windowRefusal } from "@/lib/insight/sustainability"

import { SustainabilityReportBody } from "./sustainability-report-body"

export function SustainabilitySection({ record }: { record: BusinessRecord }) {
  const client = useApiClient()
  const { me } = useApiSession()
  const serverId = useServerModuleState(CONTACTS_MODULE.workspaceId, CONTACTS_MODULE.moduleId)?.serverIds.get(record.id)
  const today = projectToday(useProjectTimezone(record.projectIds?.[0]))
  // Until `/me` is read the grants are unknown: the section waits, never saying the role cannot see it.
  const known = me !== null
  const readable = known && sustainabilityReadable(me.role.grants)
  const [asked, setAsked] = useState(false)
  const [periodId, setPeriodId] = useState<CompliancePeriodId>(DEFAULT_PERIOD)
  const [custom, setCustom] = useState<DayWindow>(() => periodOf(DEFAULT_PERIOD, today) ?? { from: today, to: today })
  const [separator, setSeparator] = useState<FileSeparator>(() => separatorFor(typeof navigator === "undefined" ? undefined : navigator.language))
  const [downloading, setDownloading] = useState(false)

  const window = periodOf(periodId, today) ?? custom
  const refusal = windowRefusal(window)
  const query: SustainabilityQuery | null = serverId === undefined || refusal !== null ? null : { customerId: serverId, ...window }
  const read = useReport(asked && readable && query !== null ? sustainabilityKey(query) : null, (asking) => sustainabilityReport(asking, query as SustainabilityQuery))

  /** A day typed into the window: the window becomes the person's own from the days it held. */
  const spell = (end: keyof DayWindow, day: string) => {
    setCustom({ ...window, [end]: day })
    setPeriodId("custom")
  }
  const pick = (id: CompliancePeriodId) => {
    if (id === "custom") setCustom(window)
    setPeriodId(id)
  }

  const download = async () => {
    if (client === null || query === null) return
    setDownloading(true)
    try {
      const file = await sustainabilityFile(client, query, separator)
      downloadBlob(sustainabilityFileName(file.fileName, query), new Blob([file.bytes], { type: file.contentType ?? "text/csv;charset=utf-8" }))
    } catch (error) {
      toast.error("The sustainability file was not downloaded", { description: problemSentence(problemOfError(error)) })
    } finally {
      setDownloading(false)
    }
  }

  let notice: string | null = null
  if (!known) notice = "Reading what your role may see…"
  else if (!readable) notice = "The sustainability report is not shown to your role."
  else if (serverId === undefined) notice = "The customer is not read from the API yet."
  else if (refusal !== null) notice = refusal
  else if (read.problem !== null) notice = `The sustainability report could not be read from the API: ${problemSentence(read.problem)}`
  else if (read.shown === null) notice = "Reading the sustainability report from the API…"
  // Judged on the current window's own answer: the last one's, greyed, says nothing of this window.
  else if (read.report !== null && !reportShowsAny(read.report)) notice = "No collection of this customer's was completed in this window."

  return (
    <section className="space-y-3" data-testid="customer-sustainability" aria-label="Sustainability">
      <h3 className="text-sm font-semibold">Sustainability</h3>
      {readable && !asked && (
        <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setAsked(true)} data-testid="sustainability-show">
          Show sustainability report
        </Button>
      )}
      {readable && asked && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={periodId} onValueChange={(value) => pick(value as CompliancePeriodId)}>
            <SelectTrigger className="h-8 w-[170px] bg-transparent text-xs" aria-label="Report period">
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
          <Input type="date" className="h-8 w-[150px] bg-transparent text-xs" aria-label="First day" value={window.from} onChange={(event) => spell("from", event.target.value)} />
          <span className="text-xs text-muted-foreground">to</span>
          <Input type="date" className="h-8 w-[150px] bg-transparent text-xs" aria-label="Last day" value={window.to} onChange={(event) => spell("to", event.target.value)} />
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
          <Button variant="outline" size="sm" className="h-8 gap-1.5 bg-transparent text-xs" onClick={() => void download()} disabled={client === null || query === null || downloading} data-testid="sustainability-download">
            <DownloadSimple className="h-3.5 w-3.5" />
            {downloading ? "Downloading…" : "Download CSV"}
          </Button>
          {query !== null && (
            <Button asChild variant="outline" size="sm" className="h-8 gap-1.5 bg-transparent text-xs">
              <Link href={sustainabilityPrintHref(query.customerId, window)} target="_blank" data-testid="sustainability-print">
                <Printer className="h-3.5 w-3.5" />
                Printable report
              </Link>
            </Button>
          )}
        </div>
      )}
      {!asked && readable ? null : notice !== null ? (
        <p className="text-sm text-muted-foreground">{notice}</p>
      ) : (
        read.shown !== null && (
          <div aria-busy={read.loading} className={read.loading ? "opacity-50 transition-opacity" : undefined}>
            <SustainabilityReportBody report={read.shown} />
          </div>
        )
      )}
    </section>
  )
}
