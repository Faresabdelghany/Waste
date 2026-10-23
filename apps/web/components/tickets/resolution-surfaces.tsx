"use client"
// Tickets and alerts on the Pilot (Issue #182, slice 8 of #81, for #147):
// the command surfaces of `operate.tickets` and `operate.exceptions`. New
// ticket opens a case through the form trimmed to `TicketCreate`; Raise alert
// raises one by hand through `AlertCreate`'s; an alert's details offer
// acknowledge, resolve, Open ticket — the New ticket form on the alert's
// words and links, answering it — and the link to a ticket that exists. A
// ticket's details are its own dialog (TicketDetailsDialog.tsx). Nothing is
// offered until the module reads the API's rows: before that, and after its
// load failed, a write would reach the browser's bucket and never the API.
import { useState, type ReactNode } from "react"
import { ArrowSquareOut, Plus } from "@phosphor-icons/react/dist/ssr"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { useBusinessRecordStore, whenSaved } from "@/components/waste/business-record-store"
import type { PrimarySurfaceProps, RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { useCommandRunner, useModuleReady, useOpenRecord, type RelationPickers } from "@/components/waste/commands/use-command-support"
import { ACKNOWLEDGE_ALERT, ALERTS_MODULE, LINK_ALERT_TICKET, RESOLVE_ALERT } from "@/lib/api/records/alerts"
import { TICKETS_MODULE } from "@/lib/api/records/tickets"
import { ALERT_COMMAND_FORMS, ALERT_FORM, createAlertRecord, ticketValuesOfAlert, type AlertCommandWithForm } from "@/lib/data/alerts"
import type { BusinessFormSchema, BusinessFormValues } from "@/lib/data/business-form-types"
import type { BusinessRecord, ModuleLocation } from "@/lib/data/business-modules"
import { createTicketRecord, TICKET_FORM } from "@/lib/data/tickets"
import type { AlertStatus } from "@waste/domain/resolution/vocabulary"

import { useResolutionPickers } from "./resolution-pickers"

/**
 * A create dialog of Resolution's: the form, the write through the record
 * store — open until the API has answered, the API's refusal the store's
 * toast over the form still holding what was typed — and the row made
 * opened in its module's details. `initial` is what it opens on (an alert's
 * words and links), `extra` what rides along unseen (the alert it answers).
 */
function ResolutionCreateDialog({
  module,
  schema,
  make,
  created,
  open,
  onOpenChange,
  initial,
  onSaved,
  pickers,
}: {
  module: ModuleLocation
  schema: BusinessFormSchema
  make: (values: BusinessFormValues, now: number) => BusinessRecord
  created: (record: BusinessRecord) => { title: string; description: string }
  open: boolean
  onOpenChange: (open: boolean) => void
  initial?: BusinessFormValues
  onSaved?: () => void
  /** The pickers its opener built, so one surface subscribes to the modules once. */
  pickers: RelationPickers
}) {
  const { upsertRecord } = useBusinessRecordStore()
  const openRecord = useOpenRecord(module.moduleId)
  const [saving, setSaving] = useState(false)
  const submit = (values: BusinessFormValues) => {
    if (saving) return
    const record = make(values, Date.now())
    setSaving(true)
    whenSaved(
      upsertRecord(module.workspaceId, module.moduleId, record),
      () => {
        onOpenChange(false)
        onSaved?.()
        openRecord(record.id)
        const said = created(record)
        toast.success(said.title, { description: said.description })
      },
      () => setSaving(false),
    )
  }
  // A create opens with nothing to keep but what it was handed: a pick made since and no longer offered is flagged, not kept.
  return <BusinessRecordFormDialog schema={schema} open={open} onOpenChange={onOpenChange} onSubmit={submit} relationOptions={(field, values) => pickers.options(field, values, undefined, initial ?? {})} initialValueOverrides={initial} />
}

/** A primary action of Resolution's: the button, offered once the module reads the API's rows and every module its form picks from has answered. */
function CreateButton({ label, module, schema, children }: { label: string; module: ModuleLocation; schema: BusinessFormSchema; children: (open: boolean, setOpen: (open: boolean) => void, pickers: RelationPickers) => ReactNode }) {
  const pickers = useResolutionPickers()
  const moduleReady = useModuleReady(module)
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" disabled={!moduleReady || !pickers.readyFor(schema)} onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" weight="bold" />
        <span className="hidden sm:inline">{label}</span>
        <span className="sm:hidden">Action</span>
      </Button>
      {children(open, setOpen, pickers)}
    </>
  )
}

const ticketCreated = (record: BusinessRecord) => ({ title: "Ticket opened", description: `${record.name} is open; its number follows from the API.` })

/** New ticket: the office opens a case. */
export function NewTicketSurface({ label }: PrimarySurfaceProps) {
  return (
    <CreateButton label={label} module={TICKETS_MODULE} schema={TICKET_FORM}>
      {(open, setOpen, pickers) => <ResolutionCreateDialog module={TICKETS_MODULE} schema={TICKET_FORM} pickers={pickers} open={open} onOpenChange={setOpen} make={(values, now) => createTicketRecord(values, { now })} created={ticketCreated} />}
    </CreateButton>
  )
}

/** Raise alert: the office raises a condition by hand, the one source of alerts the pilot has. */
export function RaiseAlertSurface({ label }: PrimarySurfaceProps) {
  return (
    <CreateButton label={label} module={ALERTS_MODULE} schema={ALERT_FORM}>
      {(open, setOpen, pickers) => (
        <ResolutionCreateDialog
          module={ALERTS_MODULE}
          schema={ALERT_FORM}
          pickers={pickers}
          open={open}
          onOpenChange={setOpen}
          make={(values, now) => createAlertRecord(values, { now })}
          created={(record) => ({ title: "Alert raised", description: `${record.name} is new: acknowledge it, resolve it, or hand it to a ticket.` })}
        />
      )}
    </CreateButton>
  )
}

/** What each of the alert's commands is told once the API has taken it. */
const ALERT_DONE: Readonly<Record<string, string>> = {
  [ACKNOWLEDGE_ALERT]: "Alert acknowledged",
  [RESOLVE_ALERT]: "Alert resolved",
  [LINK_ALERT_TICKET]: "Alert linked to the ticket",
}

type AlertOpen = { kind: "command"; name: AlertCommandWithForm } | { kind: "ticket" }

/** An alert's commands in its details: acknowledge, resolve, Open ticket and the link to a ticket that exists — each offered where the alert's machine would take it. */
export function AlertCommandsSurface({ record }: RowSurfaceProps) {
  const { refreshRecord } = useBusinessRecordStore()
  const pickers = useResolutionPickers()
  const moduleReady = useModuleReady(ALERTS_MODULE)
  const ticketsReady = useModuleReady(TICKETS_MODULE)
  const { busy, run: send } = useCommandRunner(ALERTS_MODULE, record.id)
  const openTicket = useOpenRecord(TICKETS_MODULE.moduleId)
  const [open, setOpen] = useState<AlertOpen | null>(null)
  const projectId = typeof record.submittedValues?.projectId === "string" ? record.submittedValues.projectId : undefined
  const status = String(record.submittedValues?.status ?? "new") as AlertStatus
  const ticketId = typeof record.submittedValues?.ticketId === "string" && record.submittedValues.ticketId !== "" ? record.submittedValues.ticketId : undefined
  // An alert links to one ticket, and a resolved one changes no more.
  const handsOver = ticketId === undefined && status !== "resolved"
  const offered = moduleReady && !busy

  const run = (name: string, input?: BusinessFormValues) =>
    send(name, input, (outcome) => {
      setOpen(null)
      toast.success(ALERT_DONE[name] ?? "Alert updated", { description: `${outcome.record.name} is ${outcome.record.status.toLowerCase()}.` })
    })

  return (
    <section className="space-y-4" data-testid="alert-commands">
      <h3 className="text-sm font-semibold">Alert commands</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The alerts are being read from the API; their commands follow.</p>}
      <div className="flex flex-wrap gap-2">
        {status === "new" && (
          <Button variant="outline" size="sm" disabled={!offered} onClick={() => run(ACKNOWLEDGE_ALERT)}>
            Acknowledge
          </Button>
        )}
        {status !== "resolved" && (
          <Button variant="outline" size="sm" disabled={!offered} onClick={() => setOpen({ kind: "command", name: "resolve" })}>
            Resolve
          </Button>
        )}
        {handsOver && (
          <>
            <Button variant="outline" size="sm" disabled={!offered || !ticketsReady || !pickers.readyFor(TICKET_FORM)} onClick={() => setOpen({ kind: "ticket" })}>
              Open ticket
            </Button>
            <Button variant="ghost" size="sm" disabled={!offered || !ticketsReady} onClick={() => setOpen({ kind: "command", name: "link-ticket" })}>
              Link to a ticket
            </Button>
          </>
        )}
        {ticketId !== undefined && (
          <Button variant="ghost" size="sm" className="gap-1" onClick={() => openTicket(ticketId)}>
            Open {record.facts.Ticket ?? "ticket"}
            <ArrowSquareOut className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {open?.kind === "command" && (
        <BusinessRecordFormDialog
          schema={ALERT_COMMAND_FORMS[open.name]}
          open
          onOpenChange={(isOpen) => !isOpen && setOpen(null)}
          onSubmit={(values) => run(open.name === "resolve" ? RESOLVE_ALERT : LINK_ALERT_TICKET, values)}
          relationOptions={(field, values) => pickers.options(field, values, projectId)}
        />
      )}
      {open?.kind === "ticket" && (
        <ResolutionCreateDialog
          module={TICKETS_MODULE}
          schema={TICKET_FORM}
          pickers={pickers}
          open
          onOpenChange={(isOpen) => !isOpen && setOpen(null)}
          initial={ticketValuesOfAlert(record)}
          make={(values, now) => createTicketRecord(values, { now, extra: { alertId: record.id } })}
          created={ticketCreated}
          // The API links the alert to the ticket it answers in the same transaction: the alert is read back.
          onSaved={() => void refreshRecord(ALERTS_MODULE.workspaceId, ALERTS_MODULE.moduleId, record.id)}
        />
      )}
    </section>
  )
}
