"use client"
// Agreements and subscriptions on the Pilot (#291, slice 10c): the
// lifecycle the generic Edit cannot spell, in a row's details. An
// agreement is terminated on its last day of service — its subscriptions
// and their placements with it, the bins staying until they are collected —
// and a subscription has its service changed from a day, the replacement
// taking its bins, or is paused over a period and its pauses listed, each
// cancelled before it begins or resumed while it runs. Each goes through the
// adapter's action (lib/api/records/agreements.ts), the API's refusal in its
// own words through the store's toast; the module is read again where the
// rows changed, the containers too where their placements did, and the
// stops a command left standing on dispatched routes are named in the toast
// for the office to remove by hand. The forms and readings are
// lib/data/subscription-lifecycle.ts's.
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useBusinessRecordStore, useModuleRecords } from "@/components/waste/business-record-store"
import type { RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { useModuleReady, useRelationPickers, useRowHistory } from "@/components/waste/commands/use-command-support"
import { cancelPause, changeService, pauseSubscription, resumePause, subscriptionPauses, terminateAgreement } from "@/lib/api/records/agreements"
import { CONTAINERS_MODULE } from "@/lib/api/records/containers"
import { dayIn } from "@/lib/api/records/planning"
import { AGREEMENTS_MODULE, isAgreementRecord, isSubscriptionRecord, subscriptionProductOptions } from "@/lib/data/agreements"
import type { BusinessFormField, BusinessFormValues } from "@/lib/data/business-form-types"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { PRODUCTS_MODULE } from "@/lib/data/commercial"
import { CHANGE_SERVICE_FORM, PAUSE_FORM, pauseLine, pauseOffers, stopsToRemoveSentence, TERMINATE_FORM } from "@/lib/data/subscription-lifecycle"
import type { SubscriptionPause } from "@waste/contracts/agreements"

const NO_FIXTURES: readonly BusinessRecord[] = []

/** The project a row is in, as its form typed it. */
const projectOf = (record: BusinessRecord): string | undefined => (typeof record.submittedValues?.projectId === "string" ? record.submittedValues.projectId : undefined)

/** A row's lifecycle, by its kind: an agreement's termination, a subscription's change and pauses. */
export function AgreementCommandsSurface({ record }: RowSurfaceProps) {
  if (isAgreementRecord(record)) return <TerminateSurface record={record} />
  if (isSubscriptionRecord(record)) return <SubscriptionLifecycleSurface record={record} />
  return null
}

/** What both kinds' surfaces share: the store's action and re-read, the module's readiness, the project's day, and one write out at a time. */
function useLifecycle(record: BusinessRecord) {
  const { sendAction, refreshModule } = useBusinessRecordStore()
  const moduleReady = useModuleReady(AGREEMENTS_MODULE)
  const pickers = useRelationPickers()
  const projectId = projectOf(record)
  // The moment the details opened: the project's day the surface judges a pause on, held so a render reads one day.
  const [openedAt] = useState(() => new Date())
  const today = dayIn(openedAt, pickers.timezoneOf(projectId))
  const [busy, setBusy] = useState(false)
  const reread = (containers: boolean) => {
    void refreshModule(AGREEMENTS_MODULE.workspaceId, AGREEMENTS_MODULE.moduleId)
    if (containers) void refreshModule(CONTAINERS_MODULE.workspaceId, CONTAINERS_MODULE.moduleId)
  }
  const options = (field: BusinessFormField, values: BusinessFormValues) => pickers.options(field, values, projectId)
  return { sendAction, moduleReady, today, busy, setBusy, reread, options }
}

/** The stops a command left standing, as the toast's second sentence. */
const andStops = (sentence: string | null) => (sentence === null ? "" : ` ${sentence}.`)

function TerminateSurface({ record }: RowSurfaceProps) {
  const { sendAction, moduleReady, busy, setBusy, reread, options } = useLifecycle(record)
  const [open, setOpen] = useState(false)
  const terminate = (values: BusinessFormValues) => {
    if (busy) return
    setBusy(true)
    void terminateAgreement(sendAction, record.id, values).then((outcome) => {
      setBusy(false)
      if (outcome.kind !== "done") return
      setOpen(false)
      reread(true)
      toast.success("Agreement terminated", { description: `${record.name} ends after ${String(values.lastDay)}.${andStops(stopsToRemoveSentence(outcome.answer.stopsToRemove))}` })
    })
  }
  return (
    <section className="space-y-3" data-testid="agreement-lifecycle">
      <h3 className="text-sm font-semibold">Agreement lifecycle</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The agreements are being read from the API; their commands follow.</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => setOpen(true)}>
          Terminate
        </Button>
      </div>
      {open && <BusinessRecordFormDialog schema={TERMINATE_FORM} open onOpenChange={(isOpen) => !isOpen && setOpen(false)} onSubmit={terminate} relationOptions={options} submitting={busy} />}
    </section>
  )
}

function SubscriptionLifecycleSurface({ record }: RowSurfaceProps) {
  const { sendAction, moduleReady, today, busy, setBusy, reread, options } = useLifecycle(record)
  const products = useModuleRecords(PRODUCTS_MODULE.workspaceId, PRODUCTS_MODULE.moduleId, NO_FIXTURES)
  // Bumped after each write the API took, so the pauses are read again.
  const [version, setVersion] = useState(0)
  const pauses = useRowHistory(AGREEMENTS_MODULE.workspaceId, AGREEMENTS_MODULE.moduleId, record, version, subscriptionPauses)
  const [open, setOpen] = useState<"change" | "pause" | null>(null)

  const changeForm = CHANGE_SERVICE_FORM(subscriptionProductOptions(products.records, { projectId: projectOf(record) ?? "" }))

  /** Sends one action, then — where the API took it — closes the dialog, reads again what moved and says so. */
  const send = <Answer,>(outcome: Promise<{ kind: "done"; answer: Answer } | { kind: "refused" }>, done: (answer: Answer) => void) => {
    if (busy) return
    setBusy(true)
    void outcome.then((answered) => {
      setBusy(false)
      if (answered.kind !== "done") return
      setOpen(null)
      setVersion((current) => current + 1)
      done(answered.answer)
    })
  }

  const change = (values: BusinessFormValues) =>
    send(changeService(sendAction, record.id, values), (replacement) => {
      reread(true)
      toast.success("Service changed", { description: `From ${replacement.validFrom}, ${replacement.quantity} at the same place; the bins serve the new subscription.` })
    })
  const pause = (values: BusinessFormValues) =>
    send(pauseSubscription(sendAction, record.id, values), (answer) => {
      toast.success("Subscription paused", { description: `${pauseLine(answer.pause, today)}.${andStops(stopsToRemoveSentence(answer.stopsToRemove))}` })
    })
  const resume = (pauseId: string) =>
    send(resumePause(sendAction, record.id, pauseId, today), (answer) => {
      toast.success("Pause ended", { description: `Collections resume from ${today}.${andStops(stopsToRemoveSentence(answer.stopsToRemove))}` })
    })
  const cancel = (pauseId: string) => send(cancelPause(sendAction, record.id, pauseId), () => toast.success("Pause cancelled", { description: "Its days are planned again." }))

  return (
    <section className="space-y-4" data-testid="subscription-lifecycle">
      <h3 className="text-sm font-semibold">Subscription lifecycle</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The subscriptions are being read from the API; their commands follow.</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => setOpen("change")}>
          Change service
        </Button>
        <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => setOpen("pause")}>
          Pause
        </Button>
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Pauses</h4>
        <PauseList read={pauses} today={today} disabled={busy} onResume={resume} onCancel={cancel} />
      </div>
      {open === "change" && <BusinessRecordFormDialog schema={changeForm} open onOpenChange={(isOpen) => !isOpen && setOpen(null)} onSubmit={change} relationOptions={options} submitting={busy} />}
      {open === "pause" && <BusinessRecordFormDialog schema={PAUSE_FORM} open onOpenChange={(isOpen) => !isOpen && setOpen(null)} onSubmit={pause} relationOptions={options} submitting={busy} />}
    </section>
  )
}

/** A subscription's pauses, oldest first, each with what it offers on the project's day. */
function PauseList({ read, today, disabled, onResume, onCancel }: { read: { rows: SubscriptionPause[] | null; problem: string | null }; today: string; disabled: boolean; onResume: (id: string) => void; onCancel: (id: string) => void }) {
  if (read.problem !== null) return <p className="text-sm text-muted-foreground">The pauses could not be read: {read.problem}</p>
  if (read.rows === null) return <p className="text-sm text-muted-foreground">Reading the pauses…</p>
  if (read.rows.length === 0) return <p className="text-sm text-muted-foreground">No pause.</p>
  return (
    <ul className="divide-y divide-border/60 border-y border-border/60" data-testid="subscription-pauses">
      {read.rows.map((pause) => {
        const offers = pauseOffers(pause, today)
        return (
          <li key={pause.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <span>{pauseLine(pause, today)}</span>
            {offers === "resume" && (
              <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onResume(pause.id)}>
                Resume today
              </Button>
            )}
            {offers === "cancel" && (
              <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onCancel(pause.id)}>
                Cancel pause
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
