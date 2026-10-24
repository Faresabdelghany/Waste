"use client"
// Service areas, service provider prices, settlements and weight review on
// the Pilot (Issue #186, slice 11 of #81, for #148): the command surfaces of
// `service-providers.service-areas`, `commercial.service-provider-prices`,
// `commercial.settlements` and `route-studio.weights`.
//
// Service areas: Create service area is the award by its own form — the
// planning areas it covers, never a drawn polygon (#127) — and an award's
// details offer its edit (its code and project held) and its assignments, the
// first holder first: Add assignment, and each one's end. An assignment added
// or ended moves the award's holder, so the module is read again.
//
// Prices: Add price is a chain's first row; a price's details offer its edit
// (its notes and its end: the bid is locked and the fee moves by index alone)
// and Apply index, a create of the chain's next row that ends this one the day
// before — so the module is read again once it lands.
//
// Settlements: Open settlement is a period of an assignment; its details offer
// the commands the machine moves it by from its status and the project's day
// (never a stay or a refusal, `settlementCommandsOffered`: no Calculate before
// the period has begun, no Close before it has ended, #260), Close settlement
// once asked whether to (#257), Reopen with the reason the history keeps,
// then its lines — each event by name and route, and the provider price that
// priced it — and its history.
//
// Weights: an unload's details offer the reviews the machine moves it by
// (`weightReviewsOffered`); a corrected one names the row to review instead.
// The forms are lib/data/provider-money-forms.ts', and each primary button
// says what its form does (its submit label), not the fixture's action;
// nothing is offered until the module reads the API's rows.
import { useEffect, useState } from "react"
import { toast } from "sonner"
import type { SettlementDetail, SettlementEvent } from "@waste/contracts/settlements"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { BusinessRecordFormDialog } from "@/components/waste/business-record-form-dialog"
import { savedRow, useBusinessRecordStore, useServerModuleState, whenSaved } from "@/components/waste/business-record-store"
import { useCommercialPickers } from "@/components/waste/commands/commercial-pickers"
import type { RowSurfaceProps } from "@/components/waste/commands/command-surfaces"
import { CreateSurface } from "@/components/waste/commands/create-surface"
import { ReadRows } from "@/components/waste/commands/read-rows"
import { useCommandRunner, useModuleReady, useRowHistory, useServerNames } from "@/components/waste/commands/use-command-support"
import type { ApiClient } from "@/lib/api/client"
import { statusLabel } from "@/lib/api/records/adapter"
import { shownOn } from "@/lib/api/records/clock"
import { settlementCommandsOffered, settlementDetail, settlementHeldBack, settlementHistory } from "@/lib/api/records/provider-money"
import { weightReviewsOffered } from "@/lib/api/records/weights"
import { formatMinor } from "@/lib/commercial/money"
import type { BusinessFormValues } from "@/lib/data/business-form-types"
import type { BusinessRecord, ModuleLocation } from "@/lib/data/business-modules"
import { EVENT_PREFIX, EVENTS_MODULE } from "@/lib/data/commercial"
import { blankNone, editedRecord, formValuesOf } from "@/lib/data/commercial-forms"
import {
  assignmentsOf,
  isAssignmentRecord,
  PROVIDER_PRICE_PREFIX,
  PROVIDER_PRICES_MODULE,
  SERVICE_AREAS_MODULE,
  SETTLEMENTS_MODULE,
  WEIGHTS_MODULE,
} from "@/lib/data/provider-money"
import {
  ASSIGNMENT_FORM,
  assignmentEndForm,
  createAssignmentRecord,
  createIndexedPriceRecord,
  createProviderPriceRecord,
  createServiceAreaRecord,
  createSettlementRecord,
  INDEX_FORM,
  PROVIDER_PRICE_FORM,
  providerPriceEditForm,
  REOPEN_FORM,
  SERVICE_AREA_FORM,
  serviceAreaEditForm,
  SETTLEMENT_FORM,
  updateServiceAreaRecord,
  WEIGHT_REVIEW_FORMS,
} from "@/lib/data/provider-money-forms"
import { ACCESS_MODULE } from "@/lib/data/tickets"

/**
 * One row of a module read back: a write that moves another row of it (an
 * award's holder, a chain's previous row), and only that row.
 */
function useRowReread(module: ModuleLocation): (recordId: string) => void {
  const { refreshRecord } = useBusinessRecordStore()
  return (recordId) => void refreshRecord(module.workspaceId, module.moduleId, recordId)
}

/**
 * Mounted beside the service areas', the prices' and the settlements'
 * tables: the awards and their assignments read again, for an award the map
 * or the provider page made — its first assignment is the server's, which no
 * create here hands the store — before its assignment is picked.
 */
export function ServiceAreasRead() {
  const { refreshModule } = useBusinessRecordStore()
  useEffect(() => {
    void refreshModule(SERVICE_AREAS_MODULE.workspaceId, SERVICE_AREAS_MODULE.moduleId)
  }, [refreshModule])
  return null
}

/** One write from a row's details, waited on through `whenSaved` (#263): the dialog open until the API has answered, the store's toast over it on a refusal; `done` told the row the write left (`savedRow`). */
function useRowWrite(module: ModuleLocation) {
  const { upsertRecord } = useBusinessRecordStore()
  const [busy, setBusy] = useState(false)
  /** `done` is told the row and whether the write changed it: one that changed nothing says so here, in place of the caller's success. */
  const write = (record: BusinessRecord, done: (saved: BusinessRecord, changed: boolean) => void) => {
    if (busy) return
    setBusy(true)
    whenSaved(
      upsertRecord(module.workspaceId, module.moduleId, record),
      (saved) => {
        const changed = saved?.kind !== "unchanged"
        if (!changed) toast.info("Nothing to change", { description: "The row is as the API holds it." })
        done(savedRow(saved, record), changed)
      },
      () => setBusy(false),
    )
  }
  return { busy, write }
}

// ---------------------------------------------------------------------------
// Service areas and assignments
// ---------------------------------------------------------------------------

/** Create service area: the award by its own form, the planning areas it covers. */
export function CreateServiceAreaSurface() {
  const pickers = useCommercialPickers()
  const { refreshModule } = useBusinessRecordStore()
  return (
    <CreateSurface
      label={SERVICE_AREA_FORM.submitLabel}
      module={SERVICE_AREAS_MODULE}
      schema={SERVICE_AREA_FORM}
      pickers={pickers}
      make={(values, now) => createServiceAreaRecord(values, now)}
      created={(record) => ({ title: "Service area created", description: `${record.name} covers its planning areas over its period.` })}
      // The award's first assignment is the server's: the module is read again, and the award keeps the id it was made under (#240).
      onCreated={() => void refreshModule(SERVICE_AREAS_MODULE.workspaceId, SERVICE_AREAS_MODULE.moduleId)}
    />
  )
}

type AreaDialog = { kind: "edit"; values: BusinessFormValues } | { kind: "assign" } | { kind: "end"; assignment: BusinessRecord; values: BusinessFormValues }

/** An award's details: its edit, its assignments the first holder first, Add assignment and each one's end; an assignment opened alone, its end. */
export function ServiceAreaCommandsSurface({ record }: RowSurfaceProps) {
  const pickers = useCommercialPickers()
  const moduleReady = useModuleReady(SERVICE_AREAS_MODULE)
  const state = useServerModuleState(SERVICE_AREAS_MODULE.workspaceId, SERVICE_AREAS_MODULE.moduleId)
  const reread = useRowReread(SERVICE_AREAS_MODULE)
  const { busy, write } = useRowWrite(SERVICE_AREAS_MODULE)
  const [dialog, setDialog] = useState<AreaDialog | null>(null)
  const isAssignment = isAssignmentRecord(record)
  const assignments = isAssignment ? [] : assignmentsOf(state?.records ?? [], record.id)
  const project = record.projectIds?.[0]

  const save = (edited: BusinessRecord, said: string) =>
    write(edited, (saved, changed) => {
      setDialog(null)
      // An assignment moves the award's holder: the award is read back.
      const award = isAssignmentRecord(edited) ? edited.submittedValues?.serviceAreaId : undefined
      if (typeof award === "string" && changed) reread(award)
      if (changed) toast.success(said, { description: `${saved.name}.` })
    })

  const end = (assignment: BusinessRecord) => setDialog({ kind: "end", assignment, values: formValuesOf(assignmentEndForm(assignment), assignment) })
  const schema = dialog === null ? null : dialog.kind === "edit" ? serviceAreaEditForm(record) : dialog.kind === "assign" ? ASSIGNMENT_FORM : assignmentEndForm(dialog.assignment)
  const opened = dialog === null ? {} : dialog.kind === "assign" ? { serviceAreaId: record.id } : dialog.values
  const submit = (values: BusinessFormValues) => {
    if (dialog === null) return
    if (dialog.kind === "edit") save(updateServiceAreaRecord(record, values), "Service area updated")
    else if (dialog.kind === "assign") save({ ...createAssignmentRecord({ ...values, serviceAreaId: record.id }, Date.now()), projectIds: record.projectIds }, "Assignment added")
    else save(editedRecord(dialog.assignment, values), "Assignment updated")
  }

  return (
    <section className="space-y-3" data-testid="service-area-commands">
      <h3 className="text-sm font-semibold">{isAssignment ? "Assignment" : "Service area"}</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The service areas are being read from the API; their actions follow.</p>}
      {isAssignment ? (
        <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => end(record)}>
          End or note
        </Button>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={!moduleReady || busy || !pickers.readyFor(serviceAreaEditForm(record))} onClick={() => setDialog({ kind: "edit", values: formValuesOf(serviceAreaEditForm(record), record) })}>
              Edit service area
            </Button>
            <Button variant="outline" size="sm" disabled={!moduleReady || busy || !pickers.readyFor(ASSIGNMENT_FORM)} onClick={() => setDialog({ kind: "assign" })}>
              Add assignment
            </Button>
          </div>
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground">Assignments</h4>
            <ReadRows
              read={{ rows: state === null ? null : assignments, problem: null }}
              label="Reading the assignments…"
              empty="Not awarded yet: add an assignment."
              testId="service-area-assignments"
              line={(assignment) => (
                <div className="flex items-center justify-between gap-3">
                  <span>
                    {assignment.facts["Service provider"] ?? assignment.name} · {assignment.value} · {assignment.status}
                  </span>
                  <Button variant="ghost" size="sm" disabled={!moduleReady || busy} onClick={() => end(assignment)}>
                    End or note
                  </Button>
                </div>
              )}
            />
          </div>
        </>
      )}
      {dialog !== null && schema !== null && (
        <BusinessRecordFormDialog schema={schema} open onOpenChange={(isOpen) => !isOpen && setDialog(null)} onSubmit={submit} relationOptions={(field, values) => pickers.options(field, values, project, opened)} initialValueOverrides={opened} />
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Service provider prices
// ---------------------------------------------------------------------------

/** Add price: the first row of a chain, under an assignment. */
export function AddProviderPriceSurface() {
  const pickers = useCommercialPickers()
  return (
    <CreateSurface
      label={PROVIDER_PRICE_FORM.submitLabel}
      module={PROVIDER_PRICES_MODULE}
      schema={PROVIDER_PRICE_FORM}
      pickers={pickers}
      make={(values, now) => createProviderPriceRecord(values, now)}
      created={() => ({ title: "Price added", description: "The provider is paid it for the product's events from the day it starts." })}
    />
  )
}

/** A price's details: its edit, and Apply index. */
export function ProviderPriceCommandsSurface({ record }: RowSurfaceProps) {
  const pickers = useCommercialPickers()
  const moduleReady = useModuleReady(PROVIDER_PRICES_MODULE)
  const reread = useRowReread(PROVIDER_PRICES_MODULE)
  const { busy, write } = useRowWrite(PROVIDER_PRICES_MODULE)
  const [dialog, setDialog] = useState<"edit" | "index" | null>(null)
  const edit = providerPriceEditForm(record)
  const opened = dialog === "edit" ? formValuesOf(edit, record) : {}

  const submit = (values: BusinessFormValues) => {
    if (dialog === "edit")
      write(editedRecord(record, values), (saved, changed) => {
        setDialog(null)
        if (changed) toast.success("Price updated", { description: `${saved.name}: ${saved.value}.` })
      })
    else
      // A create always changes something: `changed` is never false here.
      write(createIndexedPriceRecord(record, values, Date.now()), (saved) => {
        setDialog(null)
        // This row now ends the day before the next: it is read back.
        reread(record.id)
        toast.success("Index applied", { description: `${record.name} is ${saved.value} from ${String(values.appliedFrom)}.` })
      })
  }

  return (
    <section className="space-y-3" data-testid="provider-price-commands">
      <h3 className="text-sm font-semibold">Service provider price</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The prices are being read from the API; their actions follow.</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={!moduleReady || busy || !pickers.readyFor(edit)} onClick={() => setDialog("edit")}>
          Edit price
        </Button>
        <Button variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => setDialog("index")}>
          Apply index
        </Button>
      </div>
      {dialog !== null && (
        <BusinessRecordFormDialog schema={dialog === "edit" ? edit : INDEX_FORM} open onOpenChange={(isOpen) => !isOpen && setDialog(null)} onSubmit={submit} relationOptions={(field, values) => pickers.options(field, values, record.projectIds?.[0], opened)} initialValueOverrides={opened} />
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

/** Open settlement: a period of an assignment, to calculate then close. */
export function OpenSettlementSurface() {
  const pickers = useCommercialPickers()
  return (
    <CreateSurface
      label={SETTLEMENT_FORM.submitLabel}
      module={SETTLEMENTS_MODULE}
      schema={SETTLEMENT_FORM}
      pickers={pickers}
      make={(values, now) => createSettlementRecord(values, now)}
      created={() => ({ title: "Settlement opened", description: "Calculate it to price the provider's events in its period." })}
    />
  )
}

/** The commands as their buttons read: Close settlement, never a bare Close beside the drawer's own two (#257). */
const COMMAND_LABELS = { calculate: "Calculate", close: "Close settlement", reopen: "Reopen" } as const
const COMMAND_DONE = { calculate: "Settlement calculated", close: "Settlement closed", reopen: "Settlement reopened" } as const

/** The settlement's own read and its history, as a one-row read its surface reads again after each command. */
const readSettlement = (client: ApiClient, serverId: string) =>
  Promise.all([settlementDetail(client, serverId), settlementHistory(client, serverId)]).then(([detail, history]): { detail: SettlementDetail; history: SettlementEvent[] }[] => [{ detail, history }])

/** A settlement's details: the commands its status moves by on the project's day, its lines by event, and its history. */
export function SettlementSurface({ record }: RowSurfaceProps) {
  const moduleReady = useModuleReady(SETTLEMENTS_MODULE)
  const { timezoneOf } = useCommercialPickers()
  const { busy, version, run } = useCommandRunner(SETTLEMENTS_MODULE, record.id)
  const read = useRowHistory(SETTLEMENTS_MODULE.workspaceId, SETTLEMENTS_MODULE.moduleId, record, version, readSettlement)
  const events = useServerModuleState(EVENTS_MODULE.workspaceId, EVENTS_MODULE.moduleId)
  const priceName = useServerNames(PROVIDER_PRICES_MODULE, PROVIDER_PRICE_PREFIX)
  const userName = useServerNames(ACCESS_MODULE, "user")
  // The two commands asked before they are sent: a reopening's reason, and whether to close at all.
  const [asking, setAsking] = useState<"close" | "reopen" | null>(null)
  const offered = settlementCommandsOffered(record)
  const heldBack = settlementHeldBack(record)
  const settlement = read.rows?.[0]
  const money = (minor: number | null) => (minor === null ? "—" : formatMinor(minor, settlement?.detail.currency ?? record.facts.Currency ?? "DKK"))

  /** A line's event as the events module holds it: its name and its route, or its id chip. */
  const eventOf = (serverId: string): { name: string; route?: string } => {
    for (const [webId, id] of events?.serverIds ?? []) {
      if (id !== serverId) continue
      const event = events?.records.find((candidate) => candidate.id === webId)
      if (event !== undefined) return { name: event.name, route: event.facts.Route }
    }
    return { name: `${EVENT_PREFIX}-${serverId}` }
  }

  const send = (name: "calculate" | "close" | "reopen", values?: BusinessFormValues) =>
    run(name, values === undefined ? undefined : blankNone(values), (outcome) => {
      setAsking(null)
      toast.success(COMMAND_DONE[name], { description: `${outcome.record.name}: ${outcome.record.value}.` })
    })

  return (
    <section className="space-y-4" data-testid="settlement-commands">
      <h3 className="text-sm font-semibold">Settlement</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The settlements are being read from the API; their commands follow.</p>}
      <div className="flex flex-wrap gap-2">
        {offered.map((name) => (
          <Button key={name} variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => (name === "calculate" ? send(name) : setAsking(name))}>
            {COMMAND_LABELS[name]}
          </Button>
        ))}
      </div>
      {/* Why a command the status moves by waits for the day: the API's own sentence (#260). */}
      {heldBack !== undefined && <p className="text-sm text-muted-foreground" data-testid="settlement-held-back">{heldBack}.</p>}
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">Lines</h4>
        {read.problem !== null ? (
          <p className="text-sm text-destructive">{read.problem}</p>
        ) : settlement === undefined ? (
          <p className="text-sm text-muted-foreground">Reading the settlement…</p>
        ) : settlement.detail.lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">{settlement.history.length > 0 ? "No event of the provider's in the period." : offered.includes("calculate") ? "Not calculated yet: Calculate prices the provider's events in the period." : "Not calculated yet."}</p>
        ) : (
          <div className="overflow-auto rounded-lg border border-border/60">
            <Table data-testid="settlement-lines">
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Qty</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Net</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {settlement.detail.lines.map((line) => {
                  const event = eventOf(line.billableEventId)
                  return (
                    <TableRow key={line.id} data-priced={line.serviceProviderPriceId !== null}>
                      <TableCell className="text-sm">{event.name}</TableCell>
                      <TableCell className="text-sm">{event.route ?? "—"}</TableCell>
                      <TableCell className="text-sm">{line.quantity}</TableCell>
                      <TableCell className="text-sm">{line.serviceProviderPriceId === null ? <span className="text-destructive">No provider price on its day</span> : `${money(line.unitPriceMinor)} · ${priceName(line.serviceProviderPriceId)}`}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{money(line.netMinor)}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">History</h4>
        <ReadRows
          read={{ rows: settlement === undefined ? null : settlement.history, problem: read.problem }}
          label="Reading the history…"
          empty="Nothing yet: it was opened."
          testId="settlement-history"
          line={(event) => `${statusLabel(event.kind)} · ${shownOn(event.recordedAt, timezoneOf(record.projectIds?.[0]))} · ${event.lineCount} line${event.lineCount === 1 ? "" : "s"}, ${money(event.netMinor)} · ${userName(event.recordedBy)}${event.reason === null ? "" : ` — ${event.reason}`}`}
        />
      </div>
      {/* Each asked only while the machine still moves the settlement by it: a re-read, the day's turn or another desk may have moved it since. */}
      {asking === "reopen" && offered.includes("reopen") && <BusinessRecordFormDialog schema={REOPEN_FORM} open onOpenChange={(isOpen) => !isOpen && setAsking(null)} onSubmit={(values) => send("reopen", values)} relationOptions={(field) => field.options ?? []} />}
      {asking === "close" && offered.includes("close") && (
        // A closed settlement is final until reopened with a reason, and the provider is told its totals: asked before it is sent (#257).
        <Dialog open onOpenChange={(isOpen) => !isOpen && !busy && setAsking(null)}>
          <DialogContent className="sm:max-w-md" data-testid="close-settlement">
            <DialogHeader>
              <DialogTitle>Close settlement</DialogTitle>
              <DialogDescription>
                {record.name} closes at {record.value}. Its lines stand still from here, and they are what {record.facts["Service provider"] ?? "the provider"} is told; they change only if the settlement is reopened, with the reason.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => setAsking(null)}>
                Cancel
              </Button>
              <Button disabled={busy} onClick={() => send("close")}>
                Close settlement
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Weight review
// ---------------------------------------------------------------------------

/** An unload's details: the reviews its status moves by; a corrected one names the row to review. */
export function WeightReviewSurface({ record }: RowSurfaceProps) {
  const moduleReady = useModuleReady(WEIGHTS_MODULE)
  const { busy, run } = useCommandRunner(WEIGHTS_MODULE, record.id)
  const [open, setOpen] = useState<keyof typeof WEIGHT_REVIEW_FORMS | null>(null)
  const offered = weightReviewsOffered(record)
  const correction = record.facts["Corrected by"]

  const send = (name: keyof typeof WEIGHT_REVIEW_FORMS, values: BusinessFormValues) =>
    run(name, blankNone(values), (outcome) => {
      setOpen(null)
      toast.success(WEIGHT_REVIEW_FORMS[name].execution?.completionMessage ?? "Recorded", { description: `${outcome.record.name} is now ${outcome.record.status.toLowerCase()}.` })
    })

  return (
    <section className="space-y-3" data-testid="weight-review-commands">
      <h3 className="text-sm font-semibold">Weight review</h3>
      {!moduleReady && <p className="text-sm text-muted-foreground">The weights are being read from the API; their reviews follow.</p>}
      {correction !== undefined && <p className="text-sm text-muted-foreground">Corrected by {correction}: review that one.</p>}
      <div className="flex flex-wrap gap-2">
        {offered.map((name) => (
          <Button key={name} variant="outline" size="sm" disabled={!moduleReady || busy} onClick={() => setOpen(name)}>
            {WEIGHT_REVIEW_FORMS[name].submitLabel}
          </Button>
        ))}
      </div>
      {open !== null && <BusinessRecordFormDialog schema={WEIGHT_REVIEW_FORMS[open]} open onOpenChange={(isOpen) => !isOpen && setOpen(null)} onSubmit={(values) => send(open, values)} relationOptions={(field) => field.options ?? []} />}
    </section>
  )
}
