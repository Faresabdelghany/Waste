"use client"

// Generation on the Pilot's scheme page (#178, slice 4 of #81): the Generate
// dialog, which asks the API for a run over a window, and the scheme's run
// list, which watches every run it shows that is still open. The run is the
// API's to make and the worker's to finish (#128): the dialog closes on the
// run the API answers — the one it started, or the scheme's run already
// queued, two clicks being one run — and the list reads an open run again
// every few seconds until it has finished (lib/api/records/generation.ts has
// the rule and the watch), then reads the scheme back, since the scheme's
// last-run and drift readings are the runs'. A run open for fifteen minutes
// since its last update is left unwatched and says so: its row cannot say
// whether the worker is still at it. Fixture mode never reaches this file;
// its Generate dialog is scheme-generate-routes.tsx.
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import type { GenerationRun } from "@waste/contracts/generation"
import { addDays, formatServiceDate, todayIso } from "@waste/domain/route-schemes/recurrence"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { ApiClient } from "@/lib/api/client"
import { problemSentence } from "@/lib/api/problem"
import { generationRunOf, runCounts, runReading, schemeGenerationRuns, watchGenerationRun, withRun } from "@/lib/api/records/generation"
import { generateScheme, type GenerationAnswer } from "@/lib/api/records/route-schemes"
import { problemOfError } from "@/lib/api/records/server-records"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { ROUTE_SCHEMES_MODULE } from "@/lib/data/route-schemes"

import { useApiClient, useApiSessionIdentity } from "./api-session-store"
import { useBusinessRecordStore, useServerModuleState } from "./business-record-store"

const INSTANT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
const CLOCK = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" })

const TRIGGER_LABELS: Record<GenerationRun["trigger"], string> = { "on-demand": "Generate routes", cron: "Nightly plan-ahead" }
const STATUS_LABELS: Record<GenerationRun["status"], string> = { queued: "Queued", running: "Running", succeeded: "Succeeded", failed: "Failed" }

const isFinished = (run: GenerationRun) => run.status === "succeeded" || run.status === "failed"

type Loaded = { key: string; runs: GenerationRun[] } | { key: string; problem: string }

export type SchemeGenerationRuns = {
  /** The scheme's newest runs once read, newest first; null while they are read or when they could not be. */
  runs: GenerationRun[] | null
  /** Why the runs could not be read. */
  problem: string | null
  /** The last read of a watched run that failed, in the API's words; cleared by the next answer. */
  readProblem: string | null
  /** The open runs left unwatched: no word from the worker for fifteen minutes. */
  unreported: ReadonlySet<string>
  /** Shows the run a Generate answered, in its place, and watches it. */
  follow: (answer: GenerationAnswer) => void
}

/**
 * A scheme's runs on the Pilot, read when its page opens and watched while
 * open: one watch per open run, all stopped when the page goes. Idle in
 * fixture mode (no client) and for a scheme the API does not hold yet.
 */
export function useSchemeGenerationRuns(record: BusinessRecord): SchemeGenerationRuns {
  const recordId = record.id
  const client = useApiClient()
  const identity = useApiSessionIdentity()
  const serverId = useServerModuleState(ROUTE_SCHEMES_MODULE.workspaceId, ROUTE_SCHEMES_MODULE.moduleId)?.serverIds.get(recordId)
  const { refreshRecord } = useBusinessRecordStore()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [unreported, setUnreported] = useState<ReadonlySet<string>>(() => new Set())
  const [readProblem, setReadProblem] = useState<string | null>(null)
  // The client as it stands when a read goes out: a watch outlives the hourly token refresh.
  const clientRef = useRef<ApiClient | null>(client)
  const watches = useRef(new Map<string, () => void>())
  const nameRef = useRef(record.name)

  useEffect(() => {
    clientRef.current = client
    nameRef.current = record.name
  }, [client, record.name])

  const watch = useCallback(
    (run: GenerationRun, key: string) => {
      if (watches.current.has(run.id)) return
      const stop = watchGenerationRun(run, {
        read: (runId, signal) => {
          const current = clientRef.current
          if (current === null) return Promise.reject(new Error("The session ended"))
          return generationRunOf({ ...current, signal }, runId)
        },
        onRun: (next) => {
          setReadProblem(null)
          setLoaded((current) => (current?.key === key && "runs" in current ? { key, runs: withRun(current.runs, next) } : current))
          if (!isFinished(next)) return
          watches.current.delete(next.id)
          // The scheme's last run and its drift are the runs': read them back.
          void refreshRecord(ROUTE_SCHEMES_MODULE.workspaceId, ROUTE_SCHEMES_MODULE.moduleId, recordId)
          if (next.status === "succeeded") toast.success(`Routes generated — ${nameRef.current}`, { description: runCounts(next) })
          else toast.error(`Generation failed — ${nameRef.current}`, { description: next.error ?? "The worker gave no reason" })
        },
        onProblem: (problem) => setReadProblem(problemSentence(problem)),
        onUnreported: (open) => {
          watches.current.delete(open.id)
          setUnreported((current) => new Set(current).add(open.id))
        },
      })
      // A run the watch declined at once (finished, or already unreported) left no timer to stop.
      if (runReading(run, Date.now()) === "watched") watches.current.set(run.id, stop)
    },
    [recordId, refreshRecord],
  )

  useEffect(() => {
    const current = clientRef.current
    if (identity === null || current === null || serverId === undefined) return
    const controller = new AbortController()
    const running = watches.current
    schemeGenerationRuns({ ...current, signal: controller.signal }, serverId).then(
      (listed) => {
        if (controller.signal.aborted) return
        // A run a Generate answered while the list was read stays, the list's copy winning where both hold it.
        setLoaded((before) => ({
          key: serverId,
          runs: before?.key === serverId && "runs" in before ? [...before.runs.filter((run) => !listed.some((item) => item.id === run.id)), ...listed] : listed,
        }))
        for (const run of listed) watch(run, serverId)
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setLoaded({ key: serverId, problem: problemSentence(problemOfError(error)) })
      },
    )
    return () => {
      controller.abort()
      for (const stop of running.values()) stop()
      running.clear()
    }
  }, [identity, serverId, watch])

  const follow = useCallback(
    (answer: GenerationAnswer) => {
      if (serverId === undefined) return
      setLoaded((current) => ({ key: serverId, runs: withRun(current?.key === serverId && "runs" in current ? current.runs : [], answer.run) }))
      watch(answer.run, serverId)
    },
    [serverId, watch],
  )

  const current = loaded !== null && loaded.key === serverId ? loaded : null
  return {
    runs: current !== null && "runs" in current ? current.runs : null,
    problem: current !== null && "problem" in current ? current.problem : null,
    readProblem,
    unreported,
    follow,
  }
}

/** The Generate dialog on the Pilot: the window to plan, one button, the API's sentence inline on a refusal. */
export function SchemeGenerateDialog({
  record,
  open,
  onOpenChange,
  onAnswered,
}: {
  record: BusinessRecord
  open: boolean
  onOpenChange: (open: boolean) => void
  onAnswered: (answer: GenerationAnswer) => void
}) {
  // The fixture dialog's window: the next seven days from tomorrow, today's routes being under way.
  const [from, setFrom] = useState(() => addDays(todayIso(), 1))
  const [to, setTo] = useState(() => addDays(todayIso(), 7))
  const [pending, setPending] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const { sendAction } = useBusinessRecordStore()

  const submit = () => {
    setPending(true)
    setRefusal(null)
    void generateScheme(sendAction, record.id, { from, to }, { report: false }).then((outcome) => {
      setPending(false)
      if (outcome.kind === "refused") {
        setRefusal(`${outcome.what}: ${problemSentence(outcome.problem)}`)
        return
      }
      const { run, started } = outcome.answer
      onAnswered(outcome.answer)
      onOpenChange(false)
      const window = `${formatServiceDate(run.windowFrom)} → ${formatServiceDate(run.windowTo)}`
      if (started) toast.success(`Generation queued — ${record.name}`, { description: `${window}. The run list follows it until the worker has finished.` })
      else toast.info(`A generation of ${record.name} is already queued`, { description: `${TRIGGER_LABELS[run.trigger]}, ${window}. The run list follows that run; ask again once it has finished.` })
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Generate routes</DialogTitle>
          <DialogDescription>
            The worker plans {record.name}&apos;s collections from the first day to the last, both included, and the run list shows its progress.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="generate-from">From</Label>
            <Input id="generate-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="generate-to">To</Label>
            <Input id="generate-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
        </div>
        {refusal !== null && (
          <p role="alert" className="text-sm text-destructive">
            {refusal}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={pending || from === "" || to === ""} onClick={submit}>
            {pending ? "Generating…" : "Generate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The scheme's newest runs, from the Generate button and the nightly plan-ahead, each as the worker has left it. */
export function SchemeGenerationRunsSection({ generation }: { generation: SchemeGenerationRuns }) {
  const { runs, problem, readProblem, unreported } = generation
  return (
    <section className="space-y-3 rounded-xl border border-border/60 p-4" aria-labelledby="scheme-generation-runs">
      <div>
        <h3 id="scheme-generation-runs" className="text-sm font-semibold">
          Generation runs
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">The scheme&apos;s newest runs, from Generate routes and the nightly plan-ahead. A run still open is read again every few seconds.</p>
      </div>
      {problem !== null ? (
        <p role="alert" className="text-sm text-destructive">
          The generation runs could not be read: {problem}
        </p>
      ) : runs === null ? (
        <p className="text-sm text-muted-foreground">Reading the generation runs…</p>
      ) : runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No generation run yet. Generate routes plans the days you pick; the nightly plan-ahead keeps the next seven planned.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Asked</TableHead>
              <TableHead>By</TableHead>
              <TableHead>Window</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.id} data-run-status={run.status}>
                <TableCell className="whitespace-nowrap tabular-nums">{INSTANT.format(new Date(run.createdAt))}</TableCell>
                <TableCell>{TRIGGER_LABELS[run.trigger]}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatServiceDate(run.windowFrom)} → {formatServiceDate(run.windowTo)}
                </TableCell>
                <TableCell>
                  {unreported.has(run.id) && !isFinished(run) ? (
                    <span className="text-xs text-amber-700 dark:text-amber-400">Open since {CLOCK.format(new Date(run.updatedAt))}, the worker has not reported</span>
                  ) : (
                    <Badge variant={run.status === "succeeded" ? "secondary" : "outline"} className={run.status === "failed" ? "border-destructive/40 text-destructive" : undefined}>
                      {STATUS_LABELS[run.status]}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {run.status === "succeeded" ? runCounts(run) : run.status === "failed" ? (run.error ?? "The worker gave no reason") : "—"}
                  {run.warnings.length > 0 && (
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-amber-700 dark:text-amber-400">
                      {run.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {readProblem !== null && <p className="text-xs text-muted-foreground">The last read of an open run failed: {readProblem}</p>}
    </section>
  )
}
