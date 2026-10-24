"use client"

// The imports run here (#291 slice 12), newest first: when, what, which
// file into which project, how its rows came out, and whether every row of
// the file has been recorded. A run's refusals open beside it, each with its
// row number and the API's sentence, for the file to be fixed and imported
// again — a new run, whose rows the first one wrote come back unchanged.
// Both are read as the Dashboard reads a report (`useReport`): the list again
// whenever the screen has just committed (`version`), the last list held,
// greyed, while the next is on its way or after it failed, the failure said.

import { useState } from "react"

import type { ImportRun } from "@waste/contracts/imports"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ReportCard, ReportNotice } from "@/components/insight/report-card"
import { useReport } from "@/components/insight/use-report"
import { importRunRows, recentImportRuns } from "@/lib/api/imports"
import { problemSentence } from "@/lib/api/problem"
import { kindOption } from "@/lib/imports/import-file"

/** How many runs the list shows: the latest, which is what a person comes back for. */
const RECENT = 20

const when = (instant: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(instant))

export function ImportRuns({ version, projects }: { version: number; projects: readonly { id: string; name: string }[] }) {
  const read = useReport(`/imports?limit=${RECENT}#${version}`, (client) => recentImportRuns(client, { limit: RECENT }))
  const [opened, setOpened] = useState<ImportRun | null>(null)
  const runs = read.shown?.items ?? null

  const projectName = (id: string | null) => (id === null ? "The company" : (projects.find((project) => project.id === id)?.name ?? "Another project"))

  return (
    <ReportCard title="Recent imports" subtitle="The latest runs, newest first" loading={read.loading && runs !== null} testId="import-runs">
      {runs !== null && read.problem !== null && (
        <p role="alert" className="border-b border-border/70 px-4 py-2 text-xs text-destructive">
          The list was not read again: {problemSentence(read.problem)}
        </p>
      )}
      {runs === null ? (
        <ReportNotice problem={read.problem} />
      ) : runs.length === 0 ? (
        <ReportNotice empty="Nothing has been imported here yet." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">When</TableHead>
              <TableHead className="text-xs">What</TableHead>
              <TableHead className="text-xs">File</TableHead>
              <TableHead className="text-xs">Into</TableHead>
              <TableHead className="text-xs">Rows</TableHead>
              <TableHead className="text-xs">Status</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.id} data-testid="import-run">
                <TableCell className="whitespace-nowrap text-xs">{when(run.createdAt)}</TableCell>
                <TableCell className="text-xs">{kindOption(run.kind).label}</TableCell>
                <TableCell className="max-w-[200px] truncate text-xs" title={run.fileName}>
                  {run.fileName}
                </TableCell>
                <TableCell className="text-xs">{projectName(run.projectId)}</TableCell>
                <TableCell className="whitespace-nowrap text-xs tabular-nums">
                  {run.counts.created} new · {run.counts.updated} changed · {run.counts.unchanged} unchanged · {run.counts.refused} refused
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="font-normal">
                    {run.status === "completed" ? "Complete" : `${run.counts.created + run.counts.updated + run.counts.unchanged + run.counts.refused} of ${run.rowCount}`}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  {run.counts.refused > 0 && (
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setOpened(run)}>
                      Refusals
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <RefusalsDialog run={opened} onClose={() => setOpened(null)} />
    </ReportCard>
  )
}

function RefusalsDialog({ run, onClose }: { run: ImportRun | null; onClose: () => void }) {
  const runId = run?.id ?? null
  const read = useReport(runId === null ? null : `/imports/${runId}/rows?outcome=refused`, (client) => importRunRows(client, runId ?? "", { outcome: "refused" }))
  return (
    <Dialog open={run !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Refused rows</DialogTitle>
          <DialogDescription>{run === null ? "" : `${run.fileName}: fix these rows in the file and import it again. The rows already written come back unchanged.`}</DialogDescription>
        </DialogHeader>
        {read.report === null ? (
          <ReportNotice problem={read.problem} />
        ) : (
          <div className="max-h-[420px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16 text-xs">Row</TableHead>
                  <TableHead className="text-xs">Matched on</TableHead>
                  <TableHead className="text-xs">Why</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {read.report.map((row) => (
                  <TableRow key={row.id} data-testid="import-refusal">
                    <TableCell className="text-xs tabular-nums">{row.row}</TableCell>
                    <TableCell className="text-xs">{row.key ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.detail}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
