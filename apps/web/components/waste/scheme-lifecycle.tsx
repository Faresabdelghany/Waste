"use client"

// A Route Scheme's lifecycle on the Pilot (O21 of #290): the three dialogs
// the scheme page opens from its Actions menu — the Plan Ahead window, the
// next version of the scheme from a day, and the archive, which is the
// scheme's delete and erases nothing. The rules are the API's
// (apps/api/src/routes/scheme-lifecycle.ts); a dialog says what will happen,
// sends the request through the store and stays open on a refusal in the
// API's words. Days are the project's, never the browser's: the earliest an
// archive or a new version takes effect is tomorrow on the project's clock.

import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { problemSentence } from "@/lib/api/problem"
import { archiveScheme, PLAN_AHEAD_DAYS_KEY, PLAN_AHEAD_DAYS_REFUSAL, succeedScheme } from "@/lib/api/records/route-schemes"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { ROUTE_SCHEMES_MODULE } from "@/lib/data/route-schemes"
import { PLAN_AHEAD_DAYS_DEFAULT, PLAN_AHEAD_DAYS_MAX, planAheadDaysAllowed } from "@waste/domain/planning/lifecycle"
import { addDays, formatServiceDate } from "@waste/domain/route-schemes/recurrence"
import { count } from "@waste/domain/text"
import type { SchemeEndingCounts } from "@waste/contracts/route-schemes"

import { useBusinessRecordStore, whenSaved } from "./business-record-store"

/** The scheme's Plan Ahead window in days, as the record carries it; the week where it says none. */
export function planAheadDaysOf(record: BusinessRecord): number {
  const days = Number(record.submittedValues?.[PLAN_AHEAD_DAYS_KEY])
  return planAheadDaysAllowed(days) ? days : PLAN_AHEAD_DAYS_DEFAULT
}

/** What ending the scheme did to its routes, in one sentence for the toast. */
export function endingSentence(routes: SchemeEndingCounts): string {
  const parts = [
    routes.cancelled === 0 ? "no planned route to cancel" : `${count(routes.cancelled, "planned route")} cancelled`,
    ...(routes.trimmed === 0 ? [] : [`${count(routes.trimmed, "route")} kept for the office's stops on ${routes.trimmed === 1 ? "it" : "them"}`]),
    ...(routes.kept === 0 ? [] : [`${count(routes.kept, "dispatched route")} left as ${routes.kept === 1 ? "it stands" : "they stand"}: cancel by hand if it must not run`]),
  ]
  return `${parts.join("; ")}.`
}

/** The modules an archive or a new version changes rows of beside the scheme's: its routes, then their stops. */
const ROUTE_MODULES = [
  ["route-studio", "routes"],
  ["route-studio", "pickups"],
] as const

type DialogProps = { record: BusinessRecord; open: boolean; onOpenChange: (open: boolean) => void }

/** The Plan Ahead window: how many days from tomorrow the nightly run keeps the scheme planned, 1..28. */
export function SchemePlanAheadWindowDialog({ record, stored, open, onOpenChange }: DialogProps & { stored: BusinessRecord }) {
  const [days, setDays] = useState(() => String(planAheadDaysOf(record)))
  const [pending, setPending] = useState(false)
  const { upsertRecord } = useBusinessRecordStore()
  const valid = planAheadDaysAllowed(Number(days))

  const submit = () => {
    setPending(true)
    // Against the stored record, never the page's derived one (scheme-details-page.tsx's rule).
    const next = { ...stored, submittedValues: { ...stored.submittedValues, [PLAN_AHEAD_DAYS_KEY]: String(Number(days)) } }
    whenSaved(
      upsertRecord(ROUTE_SCHEMES_MODULE.workspaceId, ROUTE_SCHEMES_MODULE.moduleId, next),
      () => {
        setPending(false)
        onOpenChange(false)
        toast.success("Plan Ahead window saved", { description: `${record.name} is kept planned ${count(Number(days), "day")} ahead from tomorrow by the nightly run.` })
      },
      () => setPending(false),
    )
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Plan Ahead window</DialogTitle>
          <DialogDescription>
            Each night the plan-ahead run keeps {record.name}&apos;s collections planned from tomorrow through this many days ahead, while Plan Ahead is on.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="plan-ahead-days">Days ahead</Label>
          <Input id="plan-ahead-days" type="number" min={1} max={PLAN_AHEAD_DAYS_MAX} step={1} value={days} onChange={(event) => setDays(event.target.value)} />
          {!valid && <p className="text-xs text-destructive">{PLAN_AHEAD_DAYS_REFUSAL}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={pending || !valid} onClick={submit}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The next version of the scheme from a day: a copy of it, groups and seasons and all, while this one ends there. */
export function SchemeSuccessorDialog({ record, today, open, onOpenChange }: DialogProps & { today: string }) {
  const tomorrow = addDays(today, 1)
  const [validFrom, setValidFrom] = useState(tomorrow)
  const [pending, setPending] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const { sendAction, refreshModule } = useBusinessRecordStore()

  const submit = () => {
    setPending(true)
    setRefusal(null)
    void succeedScheme(sendAction, record.id, validFrom).then(async (outcome) => {
      setPending(false)
      if (outcome.kind === "refused") {
        setRefusal(`${outcome.what}: ${problemSentence(outcome.problem)}`)
        return
      }
      onOpenChange(false)
      await refreshModule(ROUTE_SCHEMES_MODULE.workspaceId, ROUTE_SCHEMES_MODULE.moduleId)
      for (const [workspaceId, moduleId] of ROUTE_MODULES) await refreshModule(workspaceId, moduleId)
      const { successor, generationRunId, routes } = outcome.answer
      // A validated version is planned by the run the API queued with it; a draft, or one no run was queued for, waits for the office.
      const planning =
        generationRunId !== null
          ? "Its first days are being generated now."
          : successor.status === "validated"
            ? "No generation run could be queued: open it and press Generate before its first day."
            : "It is a draft: validate it, then press Generate before its first day."
      toast.success(`New version of ${record.name} from ${formatServiceDate(validFrom)}`, {
        description: `This version now ends the day before. ${planning} ${endingSentence(routes)}`,
      })
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New version</DialogTitle>
          <DialogDescription>
            Writes the next version of {record.name} from the day you pick: the same recurrence, collection groups, crew and seasons, to edit from there. This version ends the day before, and its planned routes from that day are cancelled; a dispatched route on or after it must be cancelled first. A validated new version is generated at once over its Plan Ahead window.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="successor-from">New version from</Label>
          <Input id="successor-from" type="date" min={tomorrow} value={validFrom} onChange={(event) => setValidFrom(event.target.value)} />
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
          <Button disabled={pending || validFrom === ""} onClick={submit}>
            {pending ? "Writing…" : "Write new version"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The archive: the scheme's delete on the Pilot, which ends it from a day and erases nothing it made. */
export function SchemeArchiveDialog({ record, today, open, onOpenChange, onArchived }: DialogProps & { today: string; onArchived: () => void }) {
  const tomorrow = addDays(today, 1)
  const [effectiveFrom, setEffectiveFrom] = useState(tomorrow)
  const [pending, setPending] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const { sendAction, refreshRecord, refreshModule } = useBusinessRecordStore()

  const submit = () => {
    setPending(true)
    setRefusal(null)
    void archiveScheme(sendAction, record.id, effectiveFrom).then(async (outcome) => {
      setPending(false)
      if (outcome.kind === "refused") {
        setRefusal(`${outcome.what}: ${problemSentence(outcome.problem)}`)
        return
      }
      onOpenChange(false)
      await refreshRecord(ROUTE_SCHEMES_MODULE.workspaceId, ROUTE_SCHEMES_MODULE.moduleId, record.id)
      for (const [workspaceId, moduleId] of ROUTE_MODULES) await refreshModule(workspaceId, moduleId)
      toast.success(`${record.name} archived`, { description: `It no longer runs from ${formatServiceDate(effectiveFrom)}; ${endingSentence(outcome.answer.routes)} Its routes, stops and history are kept.` })
      onArchived()
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Archive scheme</DialogTitle>
          <DialogDescription>
            {record.name} stops planning from the day you pick: Plan Ahead goes off, and its planned routes from that day are cancelled — a route carrying a stop the office added keeps that stop. Dispatched routes, everything already run and the scheme&apos;s history are kept. An archived scheme cannot be edited or generated again.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="archive-from">No longer runs from</Label>
          <Input id="archive-from" type="date" min={tomorrow} value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} />
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
          <Button variant="destructive" disabled={pending || effectiveFrom === ""} onClick={submit}>
            {pending ? "Archiving…" : "Archive scheme"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
