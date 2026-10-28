"use client"

// Improve › Imports on the Pilot (#291 slice 12, row 20.1): a CSV file of
// one kind — the company's Customers, or a project's Properties,
// containers, or Agreements with their Subscriptions — previewed, then
// committed through the API, with the outcome of every row.
//
// A person picks the kind and, for a project's kind, the project; may
// download the kind's template; and chooses a file, which is read here into
// rows (lib/imports/import-file.ts over @waste/domain/imports). A header the
// kind cannot use stops the file before anything is sent. The preview is
// asked a batch at a time and stores nothing; it says what each row would
// become — new, changed, unchanged or refused, a refusal in the API's own
// sentence — and the commit sends the same batches to one run, each under
// the audit log's reason: the office's where it typed one, else "CSV import
// <file>", which the client carries in the change-reason header. A batch
// that fails on the way is sent again whole by Resume: the run answers the
// rows it already recorded as recorded. Changing the kind, the project or
// the file starts over. The recent runs sit below, each with its refusals
// a click away.

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { ArrowClockwise, DownloadSimple, FileCsv, UploadSimple } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import type { ImportKind, ImportRowResult, ImportRun } from "@waste/contracts/imports"
import { IMPORT_COLUMNS } from "@waste/domain/imports/columns"
import type { ImportRow } from "@waste/domain/imports/csv"

import { Breadcrumbs } from "@/components/projects/Breadcrumbs"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { ReportCard, ReportNotice } from "@/components/insight/report-card"
import { useApiClient, useApiSession } from "@/components/waste/api-session-store"
import { UNREACHABLE_STATUS, type ApiClient } from "@/lib/api/client"
import { importTemplate, previewImport, sendImportBatch, startImportRun } from "@/lib/api/imports"
import { ApiProblem, genericProblem, problemSentence, type Problem } from "@/lib/api/problem"
import { problemOfError } from "@/lib/api/records/server-records"
import { REASON_MAX } from "@/lib/data/action-decision"
import { masterDataSettingsHref } from "@/lib/data/business-links"
import { CSV_BOM, downloadCsv } from "@/lib/data/csv"
import { batchesOf, countsOf, importableKinds, importReason, kindOption, mayView, readImportFile, templateSeparatorFor, textOf, type FileReading } from "@/lib/imports/import-file"

import { ImportResultsTable } from "./import-results-table"
import { ImportRuns } from "./import-runs"

type Chosen = { name: string; reading: FileReading }

/** Where the screen is: choosing, a preview asked or read, a commit under way or done, or stopped by a refusal. */
type Phase =
  | { step: "choosing" }
  | { step: "previewing"; done: number }
  | { step: "previewed"; results: ImportRowResult[] }
  | { step: "committing"; run: ImportRun | null; results: ImportRowResult[]; next: number }
  | { step: "committed"; run: ImportRun; results: ImportRowResult[] }
  | { step: "stopped"; problem: Problem; run: ImportRun | null; results: ImportRowResult[]; next: number; preview: boolean }

export function ImportsOnApi() {
  const { me } = useApiSession()
  const client = useApiClient()
  const grants = me?.role.grants
  const kinds = useMemo(() => importableKinds(grants), [grants])
  const projects = useMemo(() => me?.projects ?? [], [me])
  const [kindChoice, setKindChoice] = useState<ImportKind | null>(null)
  const [projectChoice, setProjectChoice] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Chosen | null>(null)
  const [phase, setPhase] = useState<Phase>({ step: "choosing" })
  const [runsVersion, setRunsVersion] = useState(0)
  const [reasonTyped, setReasonTyped] = useState("")
  const fileInput = useRef<HTMLInputElement>(null)
  /** The latest file read asked for; an earlier one that lands later is dropped. */
  const reads = useRef(0)
  /** Whether a preview or a commit is on its way. */
  const working = useRef(false)
  // The client of the latest render, asked for at each request: a file of many batches outlives a token, and the session refreshes it under a new client.
  const latestClient = useRef(client)
  useEffect(() => {
    latestClient.current = client
  })
  const clientNow = (): ApiClient => {
    const current = latestClient.current
    if (current === null) throw new ApiProblem(genericProblem(UNREACHABLE_STATUS, "The session has ended; sign in again and resume"))
    return current
  }

  const option = kinds.find((candidate) => candidate.kind === kindChoice) ?? kinds[0]
  const kind = option?.kind
  const projectId = option?.projectScoped ? (projects.find((candidate) => candidate.id === projectChoice) ?? projects[0])?.id : undefined
  const busy = phase.step === "previewing" || phase.step === "committing"
  const rows: ImportRow[] = chosen?.reading.file.rows ?? []
  const blocking = chosen?.reading.blocking ?? []

  const startOver = () => setPhase({ step: "choosing" })
  const chooseKind = (value: string) => {
    setKindChoice(value as ImportKind)
    setChosen(null)
    reads.current += 1
    startOver()
    if (fileInput.current) fileInput.current.value = ""
  }
  const chooseProject = (value: string) => {
    setProjectChoice(value)
    startOver()
  }

  const readFile = async (file: File | undefined) => {
    startOver()
    // Only the latest choice is read into the screen: a slower read of an earlier file, or one begun under another kind, lands nowhere.
    const reading = ++reads.current
    if (file === undefined || kind === undefined) {
      setChosen(null)
      return
    }
    const text = textOf(await file.arrayBuffer())
    if (reading !== reads.current) return
    setChosen({ name: file.name, reading: readImportFile(kind, text) })
  }

  const downloadTemplate = async () => {
    if (client === null || kind === undefined) return
    try {
      const separator = templateSeparatorFor(typeof navigator === "undefined" ? undefined : navigator.language)
      const template = await importTemplate(client, kind, separator)
      // The API writes the byte-order mark a spreadsheet reads UTF-8 by, and reading the body as text drops it: it is put back.
      downloadCsv(`${kind}-import-template.csv`, template.startsWith(CSV_BOM) ? template : `${CSV_BOM}${template}`)
    } catch (error) {
      // A template is beside the import, not a step of it: told apart, and the screen left where it was.
      toast.error("The template did not download", { description: problemSentence(problemOfError(error)) })
    }
  }

  /** Holds a second preview or commit off while one is on its way: a double click would otherwise start two runs of one file before the screen shows it busy. */
  const claim = (): boolean => {
    if (working.current) return false
    working.current = true
    return true
  }

  const preview = async () => {
    if (client === null || kind === undefined || chosen === null || !claim()) return
    const results: ImportRowResult[] = []
    const batches = batchesOf(rows)
    setPhase({ step: "previewing", done: 0 })
    try {
      for (const batch of batches) {
        const answer = await previewImport(clientNow(), { kind, projectId, fileName: chosen.name, rows: batch })
        results.push(...answer.rows)
        setPhase({ step: "previewing", done: results.length })
      }
      setPhase({ step: "previewed", results })
    } catch (error) {
      setPhase({ step: "stopped", problem: problemOfError(error), run: null, results: [], next: 0, preview: true })
    } finally {
      working.current = false
    }
  }

  /** Sends the batches from `next` on to the run, starting the run first when there is none yet. */
  const commit = async (from: { run: ImportRun | null; results: ImportRowResult[]; next: number }) => {
    if (client === null || kind === undefined || chosen === null || !claim()) return
    const batches = batchesOf(rows)
    let run = from.run
    const results = [...from.results]
    let next = from.next
    // The audit log's reason for every row the run writes: the office's, else the file's.
    const reason = importReason(chosen.name, reasonTyped)
    // Busy from the click, before the run is made, so nothing on the screen moves under it.
    setPhase({ step: "committing", run, results, next })
    try {
      run ??= await startImportRun(clientNow(), { kind, projectId, fileName: chosen.name, rowCount: rows.length })
      setPhase({ step: "committing", run, results, next })
      for (; next < batches.length; next += 1) {
        const answer = await sendImportBatch(clientNow(), run, batches[next] ?? [], reason)
        results.push(...answer.rows)
        run = answer.run
        setPhase({ step: "committing", run, results: [...results], next: next + 1 })
      }
      setPhase({ step: "committed", run, results })
    } catch (error) {
      setPhase({ step: "stopped", problem: problemOfError(error), run, results, next, preview: false })
    } finally {
      working.current = false
      setRunsVersion((version) => version + 1)
    }
  }

  if (me === null) return <ReportNotice />
  if (!mayView(grants)) return <ReportNotice notGranted="imports" />

  const previewed = phase.step === "previewed" ? phase.results : null
  const previewCounts = previewed === null ? null : countsOf(previewed)
  const writable = previewCounts === null ? 0 : previewCounts.created + previewCounts.updated
  const committedResults = phase.step === "committing" || phase.step === "committed" || (phase.step === "stopped" && !phase.preview) ? phase.results : null
  const progress = phase.step === "previewing" ? phase.done : committedResults?.length ?? 0

  return (
    <div className="m-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-sidebar bg-background" data-testid="imports-on-api">
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/70 px-3 sm:px-4">
        <SidebarTrigger className="h-8 w-8 shrink-0 rounded-md text-muted-foreground hover:bg-accent" />
        <div className="min-w-0">
          <Breadcrumbs items={[{ label: "Dashboard", href: "/performance" }, { label: "Imports" }]} />
          <p className="hidden text-[11px] text-muted-foreground sm:block">Customers, properties, containers and agreements from a CSV file, previewed before anything is written</p>
        </div>
      </header>

      <main className="min-w-0 flex-1 space-y-4 overflow-y-auto p-4">
        {kinds.length === 0 || option === undefined || kind === undefined ? (
          <ReportCard title="New import">
            <ReportNotice empty="Your role may read the imports run here, but writes none of what an import writes." />
          </ReportCard>
        ) : (
          <ReportCard
            title="New import"
            subtitle="Choose what the file holds, then the file. Nothing is written until you import it."
            actions={
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={downloadTemplate} disabled={client === null} data-testid="import-template">
                <DownloadSimple className="h-4 w-4" />
                Template
              </Button>
            }
          >
            <div className="space-y-4 px-4 py-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">What the file holds</Label>
                  <Select value={kind} onValueChange={chooseKind} disabled={busy}>
                    <SelectTrigger className="h-8 w-[240px] text-xs" aria-label="What the file holds">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {kinds.map((candidate) => (
                        <SelectItem key={candidate.kind} value={candidate.kind}>
                          {candidate.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {option.projectScoped && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Project</Label>
                    <Select value={projectId ?? ""} onValueChange={chooseProject} disabled={busy || projects.length === 0}>
                      <SelectTrigger className="h-8 w-[220px] text-xs" aria-label="Project">
                        <SelectValue placeholder="No project" />
                      </SelectTrigger>
                      <SelectContent>
                        {projects.map((candidate) => (
                          <SelectItem key={candidate.id} value={candidate.id}>
                            {candidate.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="import-file" className="text-xs">
                    File
                  </Label>
                  <input
                    id="import-file"
                    ref={fileInput}
                    type="file"
                    accept=".csv,text/csv"
                    disabled={busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      // Emptied once read, so the same file chosen again after it was fixed is read again: a browser fires no change for an unchanged path.
                      event.target.value = ""
                      void readFile(file)
                    }}
                    className="block h-8 text-xs file:mr-3 file:h-8 file:rounded-md file:border file:border-input file:bg-transparent file:px-3 file:text-xs file:font-medium"
                    data-testid="import-file"
                  />
                </div>
                <div className="min-w-[240px] flex-1 space-y-1.5">
                  <Label htmlFor="import-reason" className="text-xs">
                    Reason <span className="font-normal text-muted-foreground">(optional, kept in each record&apos;s history)</span>
                  </Label>
                  <Input
                    id="import-reason"
                    value={reasonTyped}
                    onChange={(event) => setReasonTyped(event.target.value)}
                    maxLength={REASON_MAX}
                    disabled={busy}
                    placeholder={chosen === null ? "CSV import <file>" : `CSV import ${chosen.name}`}
                    className="h-8 text-xs"
                    data-testid="import-reason"
                  />
                </div>
              </div>

              <Collapsible>
                <CollapsibleTrigger className="text-xs font-medium text-muted-foreground underline-offset-2 hover:underline">The {kindOption(kind).label.toLowerCase()} columns</CollapsibleTrigger>
                <CollapsibleContent>
                  <ul className="mt-2 grid gap-1.5 text-xs sm:grid-cols-2" data-testid="import-columns">
                    {IMPORT_COLUMNS[kind].map((column) => (
                      <li key={column.header}>
                        <span className="font-medium">{column.header}</span>
                        {column.required && <span className="text-muted-foreground"> · required</span>}
                        <span className="text-muted-foreground"> — {column.description}</span>
                      </li>
                    ))}
                  </ul>
                </CollapsibleContent>
              </Collapsible>

              {chosen !== null && (
                <div className="space-y-2" data-testid="import-file-reading">
                  <p className="flex items-center gap-2 text-xs">
                    <FileCsv className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{chosen.name}</span>
                    <span className="text-muted-foreground">· {rows.length === 1 ? "1 row" : `${rows.length} rows`}</span>
                  </p>
                  {blocking.map((sentence) => (
                    <Alert key={sentence} variant="destructive" className="py-2">
                      <AlertDescription className="text-xs">{sentence}</AlertDescription>
                    </Alert>
                  ))}
                  {chosen.reading.ignored.length > 0 && (
                    <p className="text-xs text-muted-foreground">Not read: {chosen.reading.ignored.join(", ")}, which {chosen.reading.ignored.length === 1 ? "is not a column" : "are not columns"} of this import.</p>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" className="h-8 text-xs" onClick={preview} disabled={busy || chosen === null || blocking.length > 0 || client === null || (option.projectScoped && projectId === undefined)} data-testid="import-preview">
                  <ArrowClockwise className="h-4 w-4" />
                  Preview
                </Button>
                {previewed !== null && (
                  <Button size="sm" className="h-8 text-xs" onClick={() => void commit({ run: null, results: [], next: 0 })} disabled={writable === 0} data-testid="import-commit">
                    <UploadSimple className="h-4 w-4" />
                    {writable === 0 ? "Nothing to import" : `Import ${writable === 1 ? "1 row" : `${writable} rows`}`}
                  </Button>
                )}
                {phase.step === "stopped" && !phase.preview && phase.run !== null && (
                  <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => void commit(phase)} data-testid="import-resume">
                    Resume
                  </Button>
                )}
              </div>

              {busy && (
                <div className="space-y-1" role="status">
                  <Progress value={rows.length === 0 ? 0 : (progress / rows.length) * 100} className="h-1.5" />
                  <p className="text-[11px] text-muted-foreground">
                    {phase.step === "previewing" ? "Previewing" : "Importing"} {progress} of {rows.length} rows…
                  </p>
                </div>
              )}
              {phase.step === "stopped" && (
                <Alert variant="destructive" className="py-2" data-testid="import-stopped">
                  <AlertDescription className="text-xs">
                    {phase.preview ? "The preview stopped: " : `The import stopped after ${phase.results.length} of ${rows.length} rows: `}
                    {problemSentence(phase.problem)}
                  </AlertDescription>
                </Alert>
              )}
            </div>
          </ReportCard>
        )}

        {previewed !== null && previewCounts !== null && (
          <ReportCard title="Preview" subtitle={`${previewCounts.created} new · ${previewCounts.updated} changed · ${previewCounts.unchanged} unchanged · ${previewCounts.refused} refused. Nothing has been written.`} testId="import-preview-card">
            <ImportResultsTable results={previewed} testId="import-preview-rows" />
          </ReportCard>
        )}

        {committedResults !== null && (phase.step === "committing" || phase.step === "committed" || phase.step === "stopped") && (
          <ReportCard
            title={phase.step === "committed" ? "Imported" : "Importing"}
            subtitle={resultSubtitle(countsOf(committedResults), rows.length)}
            actions={
              phase.step === "committed" && option !== undefined ? (
                <Button asChild variant="outline" size="sm" className="h-8 text-xs">
                  <Link href={recordsHref(option.kind)}>Open {option.label.toLowerCase()}</Link>
                </Button>
              ) : undefined
            }
            testId="import-result-card"
          >
            <ImportResultsTable results={committedResults} testId="import-result-rows" />
          </ReportCard>
        )}

        <ImportRuns version={runsVersion} projects={projects} />
      </main>
    </div>
  )
}

function resultSubtitle(counts: ReturnType<typeof countsOf>, total: number): string {
  const recorded = counts.created + counts.updated + counts.unchanged + counts.refused
  return `${recorded} of ${total} rows · ${counts.created} new · ${counts.updated} changed · ${counts.unchanged} unchanged · ${counts.refused} refused`
}

/** Where a kind's records are worked on. */
function recordsHref(kind: ImportKind): string {
  switch (kind) {
    case "customers":
      return "/customers?module=contacts"
    case "properties":
      return "/customers?module=properties"
    case "containers":
      return "/resources?module=containers"
    case "agreements":
      return "/customers?module=agreements"
    case "waste-fractions":
      return masterDataSettingsHref("waste-fraction")
    case "container-types":
      return masterDataSettingsHref("container-type")
    case "vehicle-types":
      return masterDataSettingsHref("vehicle-type")
  }
}
